// Ask the model, run the tools it asked for, put the answers back, ask again.
// Every step is written to the run as it happens, because a job that goes
// wrong at four in the morning is only debuggable if that record exists.
import { randomUUID } from "node:crypto";

import { isStepCount, tool, type StopCondition, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";

import { duringRun } from "#chloe/core/current";
import { CUT_OFF, db } from "#chloe/core/db";
import { oneLineSummary } from "#chloe/core/markdown";
import { ownFileRules, type Agent, type ChatHistory, type Skill } from "#chloe/load/load";
import { ask, type Attachment, type Message, type ToolCall } from "#chloe/model/model";
import { modelFor } from "#chloe/model/choices";
import { recall, remember } from "#chloe/model/memory";
import { userNotes } from "#chloe/model/tools/memory";
import { selfReadTools } from "#chloe/model/tools/self";
import { approval, check, connectionsUsed, describe, overviewsOf, run, type Call, type ChloeTool, type ToolContext, type Tools } from "#chloe/model/tool";
import { afterRun, beforeRun } from "#chloe/services/historyService";
import { guides, ownFiles } from "#chloe/services/selfService";
import { NeedsSignIn } from "#chloe/connections/connection";

/** The options for `turn()`: one message for an agent, and how to handle its reply. */
export interface Ask {
  /** The loaded agent to ask. Required. */
  agent: Agent;
  /** The message for the model. Required. */
  prompt: string;
  /**
   * The person's own words, when `prompt` holds more than that (for example,
   * facts about the chat added before the message). The run list on the
   * dashboard shows this. Default: none.
   */
  asked?: string;
  /**
   * Photos and PDFs sent with the message. The model sees them in this reply
   * only: the conversation history keeps just the words. Default: none.
   */
  attachments?: Attachment[];
  /**
   * The model to ask, by name, like "anthropic/claude-haiku-4.5". Default: a
   * model picked for the whole agent while it runs (with `/models` in a chat,
   * or the API), else the agent's own `model`.
   */
  model?: string;
  /**
   * The id of the conversation this message belongs to. With it, the model
   * sees the recent messages of that conversation, and this message and the
   * reply are saved to it. Default: none, so the model sees no earlier
   * messages and nothing is saved to a conversation.
   */
  thread?: string;
  /**
   * Where the message came from, saved with the run: "telegram", "chat",
   * "api", "terminal", "schedule", "eval", or the name of a channel an agent
   * adds. Required.
   */
  source: string;
  /** The id of the job this run is, when it is one. It is saved with the run. Default: none. */
  job?: string;
  /** How much of `thread` the model sees, as the channel's `chatHistory`. Default: the last 10 messages. */
  history?: ChatHistory;
  /**
   * Called with what the model writes before it calls a tool, as soon as that
   * text is complete. It is never called with the final answer: `turn()`
   * returns that. Default: none.
   */
  said?: (text: string) => void;
  /**
   * Called as each tool call starts, with the tool's name and its `title` if
   * it has one. A channel can use it to show what the agent is doing.
   * Default: none.
   */
  calling?: (tool: { name: string; title?: string }) => void;
  /**
   * Called with each new piece of the model's words, as they are written.
   * This works only when the model is reached with an API key ("direct" or
   * "gateway" in `model.preferredRoute`). Words written before a tool call
   * come here too, and then to `said`. Default: none.
   */
  writing?: (delta: string) => void;
  /**
   * The name of the person on the other end of a channel. The model is told
   * it is talking to them, so it writes to them as "you". Default: none.
   */
  talkingTo?: string;
  /** Who this run belongs to, as an address like "telegram:12345". It is saved with the run. Default: none. */
  owner?: string;
  /**
   * Names of tools to leave out of this reply, even though the agent has
   * them. A channel uses it to keep some tools away from the people on it.
   * Default: none.
   */
  without?: string[];
  /**
   * Set for someone nobody vouched for, like a visitor on a web page. When a
   * tool needs someone to sign in, the sign-in is never started for them: the
   * reply only says what failed. Off by default.
   */
  stranger?: boolean;
  /**
   * Set when the agent's owner wrote this message. Only then does the model
   * get the tools only the owner may use (tools marked `forOwner`), and the
   * tools that read the agent's own files and past runs (`selfListFiles`,
   * `selfReadFile`, `selfListRuns`, `selfReadRun`). Off by default.
   */
  fromOwner?: boolean;
  /**
   * Set when the agent's owner wrote this message and may change the agent
   * with it. Only then does the model get the tools that change the agent
   * (tools marked `changesAgent`, like `selfWriteFile`). Setting it also
   * counts as `fromOwner`. Off by default, so a job, a schedule or another
   * program never changes the agent.
   *
   * Even then, once a tool not marked `own` (one that reads from outside the
   * agent's own folder and memory) has answered in this conversation, the
   * tools that change the agent are refused: what it read could be what asked
   * for the change.
   */
  mayChangeAgent?: boolean;
  /**
   * Who this message is from, as `channel:id`, like "telegram:12345". Every
   * tool gets it as `context.user`. For an agent with `memoryPerUser`, it also
   * picks whose note the model is shown. Default: none.
   */
  user?: string;
  /**
   * Answers each tool call with this function instead of running the tool.
   * Evals use it. With it, nothing in the agent's memory is committed to git.
   * Default: none.
   */
  instead?: (name: string, args: unknown) => Promise<unknown> | unknown;
  /** Stops the reply when it is aborted, for example when the person who asked has gone. Default: none. */
  signal?: AbortSignal;
}

/** What `turn()` returns: the final answer, and every tool call made on the way. */
export interface Result {
  /** The id of the run in the run history. */
  runId: string;
  /**
   * The model's final answer. When the run stopped early, the reason
   * instead, like "Stopped after 40 steps without finishing." When a tool
   * needs someone to sign in: what failed, and how to sign in.
   */
  text: string;
  /** How many times the model answered during the run. */
  steps: number;
  /** What the run spent, in dollars. */
  cost: number;
  /** Every tool call made, in order, with the input it was given and the output it returned. */
  calls: Call[];
}

function shown(history: ChatHistory = {}): { limit?: number; days?: number } {
  return { limit: history.messages, days: history.days };
}

/** Dollars, at the size these numbers actually are: $0.0004 and $0.10, not $0.00 and $0.1. */
export function money(amount: number): string {
  return `$${amount.toFixed(4).replace(/(\.\d\d)0+$/, "$1")}`;
}

/** What stops a turn when its agent's `stopWhen` says nothing: forty steps that ran tools. */
const STOP_WHEN = isStepCount(40);

/** An agent's `stopWhen` as a list, the way the loop checks it. */
function stopWhenOf(agent: Agent): StopCondition<any>[] {
  const said = agent.stopWhen ?? STOP_WHEN;
  return Array.isArray(said) ? said : [said];
}

/**
 * Sends one message to an agent and returns its reply. The model may call
 * tools: each time it does, the tools run and their answers go back to the
 * model, until it answers without calling a tool.
 *
 * The model gets the agent's instructions, its tools and its skills. Each
 * step is saved to the run history as it happens.
 *
 * The run stops early when the agent's `stopWhen` is met (default: 40 rounds
 * of tool calls), and `text` then says so. A tool that fails does not stop
 * the run: the model is told what went wrong. Throws when asking the model
 * fails.
 */
export async function turn({ agent, prompt, asked, attachments, model, thread, source, job, history, said, calling, writing, talkingTo, owner, without, stranger, fromOwner, mayChangeAgent, user, instead, signal }: Ask): Promise<Result> {
  const runId = randomUUID();
  const using = model ?? modelFor(agent);

  const started = new Date().toISOString();
  db.prepare(
    "insert into runs (id, agent, started, source, job, model, prompt, asked, kind, owner, thread) values (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?)",
  ).run(runId, agent.id, started, source, job ?? null, using, prompt, asked ?? null, owner ?? null, thread ?? null);

  const tools = toolsFor(agent, without, { fromOwner, mayChangeAgent });
  const overviews = await overviewsOf(tools);
  // In the instructions rather than the message, so it is not kept in the conversation again each turn.
  const note = user && tools.memoryWriteUserNotes ? await userNotes(agent.memory.folder, user) : "";
  const messages: Message[] = [
    { role: "system", content: systemPrompt(agent, talkingTo && { name: talkingTo, source, asYouGo: Boolean(said) }, overviews, note, cannotChange(agent, tools), await whatYouRunOn(agent, tools)) },
    ...(thread ? recall(thread, { ...shown(history), tools: true }) : []),
    { role: "user", content: prompt, attachments },
  ];
  // Keep the initial request as the model received it. Attachments stay out of
  // the record because their bytes are already kept by the channel, not the run.
  db.prepare("update runs set context = ? where id = ?").run(JSON.stringify(messages.map(contextMessage)), runId);
  if (thread) remember(thread, "user", prompt);

  return go({ agent, runId, model: using, messages, trace: [], job, source, thread, said, calling, writing, without, stranger, fromOwner, mayChangeAgent, user, instead, signal });
}

/**
 * Picks up a job's run that the service stopped in the middle of, or that ran
 * out of steps, in the same record, rather than starting the job again from
 * the top. One that ran out of steps is given as many again, so it is only
 * ever carried on because somebody asked.
 *
 * What the model is handed is rebuilt from the record: the request it began
 * with, then each answer it gave and what each tool said back. That is not
 * quite what it had, because the record keeps a tool's answer only to
 * `CLIPPED` characters and keeps no call that had not finished, so it is told
 * both and reads again what it needs. A tool that was running when the service
 * stopped may have done its work anyway, and it is told that too.
 *
 * Only a job's run, because a conversation's reply would come back to nobody.
 */
export async function carryOn({ agent, runId, signal }: { agent: Agent; runId: string; signal?: AbortSignal }): Promise<Result> {
  const row = stopped(runId);
  if (row.agent !== agent.id) throw new Error(`${agent.id} has no run ${JSON.stringify(runId)}.`);

  const trace = JSON.parse(row.trace) as LoopStep[];
  const before = answers(trace);
  const outOfSteps = row.why === "out of steps";
  const messages = [...(JSON.parse(row.context) as Message[]), ...replay(trace, row.why)];
  trace.push({
    step: before,
    at: new Date().toISOString(),
    carried: outOfSteps
      ? "It ran out of steps here, and was given as many again to carry on."
      : "The service stopped here, and the run carried on from where it was.",
  });
  db.prepare("update runs set finished = null, error = null, trace = ? where id = ?").run(JSON.stringify(trace), runId);

  return go({
    agent,
    runId,
    model: row.model,
    messages,
    trace,
    job: row.job,
    source: row.source,
    before: outOfSteps ? 0 : before,
    // Whatever changed in the memory since it stopped is mostly its own work,
    // so it goes in this run's commit rather than one of its own.
    carried: true,
    signal,
  });
}

/** A run that can carry on, as the record has it. */
export interface Stopped {
  agent: string;
  job: string;
  source: string;
  model: string;
  context: string;
  trace: string;
  why: CarryOnWhy;
}

/** Why a run stopped, when it is a way `carryOn` can pick it up from. */
export type CarryOnWhy = "cut off" | "out of steps";

/** What a run that ran out of steps says, and how carrying on tells it from one that failed. */
function outOfStepsText(steps: number): string {
  return `Stopped after ${steps} steps without finishing.`;
}
const OUT_OF_STEPS = /^Stopped after \d+ steps without finishing\.$/;

/**
 * The run, when it is one that `carryOn` can pick up: a job's prompt that the
 * service stopped in the middle of, or that ran out of steps. Throws, saying
 * why, when it is not.
 */
export function stopped(runId: string): Stopped {
  const row = db.prepare("select agent, job, source, model, kind, error, context, trace from runs where id = ?").get(runId) as
    | (Omit<Stopped, "job" | "context"> & { job: string | null; kind: string; error: string | null; context: string | null })
    | undefined;
  if (!row) throw new Error(`There is no run ${JSON.stringify(runId)}.`);
  if (row.kind !== "turn" || !row.job) throw new Error("Only a job's prompt can carry on, and this run is not one.");
  const why: CarryOnWhy | undefined = row.error === CUT_OFF ? "cut off" : OUT_OF_STEPS.test(row.error ?? "") ? "out of steps" : undefined;
  if (!why) throw new Error("Only a run the service stopped in the middle of, or one that ran out of steps, can carry on.");
  if (!row.context) throw new Error("This run kept no record of what it was asked, so there is nothing to carry on from.");
  return { agent: row.agent, job: row.job, source: row.source, model: row.model, context: row.context, trace: row.trace, why };
}

/** Why `carryOn` could pick the run up, or false when it could not, for a page deciding whether to offer it. */
export function canCarryOn(runId: string): CarryOnWhy | false {
  try {
    return stopped(runId).why;
  } catch {
    return false;
  }
}

/** The model's answers in a record, which is what its steps are counted in. */
function answers(trace: LoopStep[]): number {
  return trace.filter((one) => one.say !== undefined).length;
}

/**
 * The conversation a record says a loop had, after the request it began with,
 * ending with a word to the model about what it is missing.
 */
function replay(trace: LoopStep[], why: CarryOnWhy): Message[] {
  const messages: Message[] = [];
  const unfinished: string[] = [];
  for (let at = 0; at < trace.length; at++) {
    const answer = trace[at];
    if (answer.say === undefined) continue;
    const ran: LoopStep[] = [];
    while (trace[at + 1] && trace[at + 1].say === undefined && trace[at + 1].tool) ran.push(trace[++at]);
    const calls = ran.map((line, n) => ({
      id: `call_${answer.step}_${n}`,
      type: "function" as const,
      function: { name: line.tool ?? "", arguments: typeof line.args === "string" ? line.args : JSON.stringify(line.args ?? {}) },
    }));
    messages.push({ role: "assistant", content: answer.say, ...(calls.length > 0 && { tool_calls: calls }) });
    ran.forEach((line, n) =>
      messages.push({ role: "tool", tool_call_id: calls[n].id, content: typeof line.result === "string" ? line.result : JSON.stringify(line.result) }),
    );
    unfinished.push(...(answer.wants ?? []).slice(ran.length));
  }
  messages.push({
    role: "user",
    content:
      (why === "out of steps"
        ? "You ran out of steps before finishing this run, and have been given more to carry on from where you were. "
        : "The service stopped in the middle of this run, and it is carrying on now from where it was. ") +
      (unfinished.length > 0
        ? `You had asked for ${unfinished.join(", ")}, which did not finish: it may have done some or all of its work, so check before you run it again. `
        : "") +
      `A tool's answer longer than ${CLIPPED} characters was cut short when it was recorded, so read again anything you need in full. Then carry on with the job.`,
  });
  return messages;
}

/** Runs the loop on a run that is already in the record, and writes how it ended. */
async function go(options: {
  agent: Agent;
  runId: string;
  model: string;
  messages: Message[];
  /** What the record already holds, which the loop's lines are added to. */
  trace: LoopStep[];
  job?: string;
  source: string;
  thread?: string;
  said?: Ask["said"];
  calling?: Ask["calling"];
  writing?: Ask["writing"];
  without?: string[];
  stranger?: boolean;
  fromOwner?: boolean;
  mayChangeAgent?: boolean;
  user?: string;
  instead?: Ask["instead"];
  /** Steps already taken, which the agent's `stopWhen` counts. */
  before?: number;
  carried?: boolean;
  signal?: AbortSignal;
}): Promise<Result> {
  const { agent, runId, trace, job, source, thread, said, calling, writing, instead } = options;
  const tools = toolsFor(agent, options.without, options);
  const before = answers(trace);
  const calls: Result["calls"] = [];
  // An eval answers every tool itself, so nothing it does is written anywhere.
  const committed = (end: { summary?: string; error?: string }) =>
    instead ? Promise.resolve() : afterRun(agent, runId, { job, source, ...end });
  if (!instead && !options.carried) await beforeRun(agent, runId);

  try {
    const done = await duringRun(runId, () =>
      loop({
        model: options.model,
        messages: options.messages,
        tools,
        context: { agent, ...(options.user && { user: options.user }) },
        stopWhen: stopWhenOf(agent),
        before: options.before,
        toolApproval: agent.toolApproval,
        signal: options.signal,
        instead,
        onCall: calling && ((name) => calling({ name, title: tools[name]?.title })),
        onText: writing,
        onStep: (line) => {
          trace.push({ ...line, step: line.step + before });
          if (said && line.say?.trim() && line.wants?.length) said(line.say);
          if (line.tool) calls.push({ toolName: line.tool, input: line.args, output: line.result });
          save(runId, answers(trace), costOf(trace), trace);
        },
      }),
    );
    // A run that carried on has steps and spending from before it stopped.
    const steps = answers(trace);
    const cost = costOf(trace);
    // A sign-in somebody can do from here is an answer, not a failure: the
    // runtime starts it and the reply is the connection's own words and link.
    const signIn = done.stopped === "sign-in" && done.signIn && !options.stranger ? await signInReply(tools, done.signIn, Boolean(thread)) : undefined;
    if (done.stopped && !signIn) {
      fail(runId, done.text, steps, cost, trace);
      await committed({ error: done.text });
      return { runId, text: done.text, steps, cost, calls };
    }
    const text = signIn ?? done.text;
    finish(runId, text, steps, cost, trace);
    await committed({ summary: oneLineSummary(text) });
    if (thread) remember(thread, "assistant", text, calls);
    return { runId, text, steps, cost, calls };
  } catch (error) {
    const why = String(error instanceof Error ? error.message : error);
    fail(runId, why, answers(trace), costOf(trace), trace);
    await committed({ error: why });
    throw error;
  }
}

/**
 * What to send when a tool needs somebody to sign in: what failed, the
 * connection's own words, and its link exactly as it made it. Only in a
 * conversation, where the answer can come back: a run with nobody to answer
 * it fails instead, saying so, because starting a sign-in nobody sees would
 * only replace the link somebody else is about to open.
 */
async function signInReply(tools: Tools, needed: { connection: string; why: string }, canAnswer: boolean): Promise<string | undefined> {
  const connection = connectionsUsed(tools).find((one) => one.name === needed.connection);
  if (!canAnswer || !connection?.signIn) return undefined;
  const started = await connection.signIn.start();
  return [needed.why, started.say, started.link].filter(Boolean).join("\n\n");
}

/** The text and tool calls a model saw before it began, without attachment bytes. */
function contextMessage(message: Message): Omit<Message, "attachments"> {
  const { attachments: _, ...kept } = message;
  return kept;
}

/** What one turn of the loop did: what the model said, or one tool it ran. */
export interface LoopStep {
  step: number;
  /** When it happened: when the model answered, or when the tool was called. */
  at: string;
  say?: string;
  /** What the model wrote after its requests as if they had run. None of it ran. */
  dropped?: string;
  wants?: string[];
  tool?: string;
  /** Set on a call to a tool that only touches the agent itself (`own`). */
  own?: boolean;
  args?: unknown;
  result?: unknown;
  failed?: boolean;
  /** Set on a call the job would not allow. It never ran. */
  refused?: boolean;
  cost?: number;
  /** Set on the line where a run the service stopped picked up again: what happened, in words. */
  carried?: string;
}

/**
 * Ask, run what it asked for, ask again, until it stops asking or hits a limit.
 * Nothing here writes to the database: `turn` records a conversation and a
 * job's agent step records one line, and they both run this.
 *
 * `stopped` says what ended it, and is false when it finished. "steps" and
 * "budget" are limits it hit, which is an answer and not a crash. "person" is
 * a call somebody has to approve first: `waiting` is that call and the ones
 * after it in the same answer, none of them run, and `messages` is the
 * conversation to pick up from with `resume`. "sign-in" is a tool that threw
 * `NeedsSignIn`: `signIn` says which connection, and the calls after it in the
 * same answer are not run.
 */
export async function loop(options: {
  model: string;
  messages: Message[];
  tools: Tools;
  /** What each tool is handed as its `context`: the agent it runs for. */
  context: ToolContext;
  /** The AI SDK's stop conditions, checked after each step that ran tools, as `generateText` checks them. */
  stopWhen: StopCondition<any>[];
  /** Steps a run that carried on had already taken, which the conditions count. */
  before?: number;
  /**
   * The most this may spend, in dollars. Checked between turns, because what a
   * turn costs is only known once it has been paid for, so the turn that goes
   * over the line is paid for.
   */
  budget?: number;
  signal?: AbortSignal;
  instead?: Ask["instead"];
  /** The AI SDK's `toolApproval`, asked before each tool runs. Without one, only each tool's `needsApproval` is. */
  toolApproval?: ToolApprovalConfiguration<any, any>;
  /**
   * Whether a call that needs a person stops the loop to ask them. Without it
   * such a call is refused, because there is nobody to wait for.
   */
  canAsk?: boolean;
  /** Carrying on from a call that waited for a person: the calls left, the first being that one, and what was decided. */
  resume?: { calls: ToolCall[]; decided: Decided };
  onStep?: (line: LoopStep) => void;
  /** Handed the name of each tool it has as the call starts, before it is known whether it may run. */
  onCall?: (name: string) => void;
  /** Handed the model's words as they are written, on a route that streams them. */
  onText?: (delta: string) => void;
}): Promise<{
  text: string;
  steps: number;
  cost: number;
  calls: Result["calls"];
  stopped: false | "steps" | "budget" | "person" | "sign-in";
  waiting?: { calls: ToolCall[]; reason: string; input: unknown };
  /** With "sign-in": the connection a tool needs somebody to sign in to, and what failed, in words. */
  signIn?: { connection: string; why: string };
}> {
  const specs = await Promise.all(Object.entries(options.tools).map(([name, one]) => describe(name, one)));
  const calls: Result["calls"] = [];
  let cost = 0;
  // What the stop conditions read: each step's text, the calls it made and what came back.
  const taken: Taken[] = Array.from({ length: options.before ?? 0 }, () => ({ text: "", toolCalls: [], toolResults: [] }));
  let resume = options.resume;
  // The first tool to answer in this reply that is not `own`. After it, a tool
  // that changes the agent is refused: what it read could be asking for the
  // change. The owner's next message starts clean.
  let readOutside = "";

  for (let steps = 0; ; steps++) {
    let toolCalls: ToolCall[];
    const step: Taken = { text: "", toolCalls: [], toolResults: [] };
    if (resume) {
      toolCalls = resume.calls;
    } else {
      const answer = await ask({ model: options.model, messages: options.messages, tools: specs, signal: options.signal, onText: options.onText });
      cost += answer.cost;
      options.onStep?.({ step: steps, at: new Date().toISOString(), say: answer.text, ...(answer.dropped && { dropped: answer.dropped }), wants: answer.toolCalls.map((c) => c.function.name), cost: answer.cost });

      if (answer.toolCalls.length === 0) {
        return { text: answer.text, steps: steps + 1, cost, calls, stopped: false };
      }

      // Out of money before running what it asked for, because running the tools
      // only leads to a turn there is nothing left to pay for.
      if (options.budget !== undefined && cost >= options.budget) {
        return { text: `Stopped after spending ${money(cost)} without finishing.`, steps: steps + 1, cost, calls, stopped: "budget" };
      }

      // Has to go back exactly as it came, or the provider rejects the tool
      // answers that follow it.
      options.messages.push({ role: "assistant", content: answer.text, tool_calls: answer.toolCalls });
      toolCalls = answer.toolCalls;
      step.text = answer.text;
    }

    for (const [n, call] of toolCalls.entries()) {
      const at = new Date().toISOString();
      const decided = resume && n === 0 ? resume.decided : undefined;
      const one = options.tools[call.function.name];
      if (one) options.onCall?.(call.function.name);
      const ran =
        one?.changesAgent && readOutside
          ? refusedCall(call, `this reply used ${readOutside}, and what it read may be what asked for this. Say what you would change, and your owner can ask for it in their next message`)
          : await runTool(options.tools, call, { context: options.context, instead: options.instead, toolApproval: options.toolApproval, canAsk: options.canAsk, decided });
      if ("person" in ran) {
        return { text: "", steps, cost, calls, stopped: "person", waiting: { calls: toolCalls.slice(n), reason: ran.person, input: ran.args } };
      }
      const { output, args, failed, refused, signIn } = ran;
      if (one && !one.own && !refused && !readOutside) readOutside = call.function.name;
      step.toolCalls.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: args });
      step.toolResults.push({ type: "tool-result", toolCallId: call.id, toolName: call.function.name, input: args, output });
      calls.push({ toolName: call.function.name, input: args, output, ...(refused && { refused }) });
      options.onStep?.({ step: steps, at, tool: call.function.name, args, result: clip(output), ...(one?.own && { own: true }), ...(failed && { failed }), ...(refused && { refused }) });
      // Fixed by somebody signing in, which the runtime starts, so the model is
      // not asked again: it would only try to get round it.
      if (signIn) {
        const why = String(output).replace(/^[\w-]+ failed: /, "");
        return { text: `${why} Somebody signs in from a chat with this agent, or from the dashboard.`, steps: steps + 1, cost, calls, stopped: "sign-in", signIn: { connection: signIn, why } };
      }
      options.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
    resume = undefined;
    taken.push(step);

    // Stopped while it still wanted to go on is an answer, not a crash: an
    // empty string here would read as nothing being wrong.
    const met = await Promise.all(options.stopWhen.map((one) => one({ steps: taken as never })));
    if (met.some(Boolean)) return { text: outOfStepsText(steps + 1), steps: steps + 1, cost, calls, stopped: "steps" };
  }
}

/** What a person said about a call that waited for them: yes, no, or nothing in time. */
export type Decided = "yes" | "no" | "late";

/** One step as the AI SDK's stop conditions read it. */
interface Taken {
  text: string;
  toolCalls: { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }[];
  toolResults: { type: "tool-result"; toolCallId: string; toolName: string; input: unknown; output: unknown }[];
}

/** What the trace says has been spent so far, for the record written as it goes. */
function costOf(trace: unknown[]): number {
  return trace.reduce((sum: number, one) => sum + (((one as { cost?: number }).cost) ?? 0), 0);
}

/** A call that is not run, and what the model is told instead. */
function refusedCall(call: ToolCall, why: string): { output: unknown; args: unknown; failed?: boolean; refused?: boolean; signIn?: string } {
  let args: unknown = call.function.arguments;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {}
  return { output: `${call.function.name} was not allowed: ${why}.`, args, refused: true };
}

// A missing tool, bad arguments and a tool that threw all go back to the model
// as text it can act on. Dying here loses the work the turn had already done.
async function runTool(
  tools: Tools,
  call: ToolCall,
  how: { context: ToolContext; instead?: Ask["instead"]; toolApproval?: ToolApprovalConfiguration<any, any>; canAsk?: boolean; decided?: Decided },
): Promise<{ output: unknown; args: unknown; failed?: boolean; refused?: boolean; signIn?: string } | { person: string; args: unknown }> {
  const name = call.function.name;
  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { output: `${name} was called with arguments that are not valid JSON.`, args: call.function.arguments, failed: true };
  }

  const one = tools[name];
  if (!one) return { output: `There is no tool called ${name}. You have: ${Object.keys(tools).join(", ")}`, args, failed: true };

  const checked = await check(one, args);
  if (!checked.ok) return { output: `${name} was called wrongly: ${checked.why}`, args, failed: true };

  const refuse = (why: string) => ({
    output: `${name} was not allowed: ${why}. Try another way, or finish with what you have.`,
    args: checked.value,
    refused: true,
  });
  if (how.decided === "no") return refuse("the person asked said no");
  if (how.decided === "late") return refuse("nobody answered in time");

  // Asked once the arguments are known and before anything runs, because what
  // makes a call worth stopping is usually the arguments rather than the tool.
  // A call a person already said yes to is not asked about again.
  if (how.decided !== "yes") {
    let allowed: Awaited<ReturnType<typeof approval>>;
    try {
      allowed = await approval(tools, name, checked.value, call.id, how.context, how.toolApproval);
    } catch (error) {
      throw new Error(`Deciding whether ${name} could run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ("denied" in allowed) return refuse(allowed.denied);
    if ("person" in allowed) {
      if (how.canAsk) return { person: allowed.person, args: checked.value };
      return refuse(`it needs a person to approve it, and nobody can be asked from here${allowed.person ? ` (${allowed.person})` : ""}`);
    }
  }

  try {
    const output = how.instead ? await how.instead(name, checked.value) : await run(one, checked.value, call.id, how.context);
    return { output: output ?? { ok: true }, args: checked.value };
  } catch (error) {
    const output = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    return { output, args: checked.value, failed: true, ...(error instanceof NeedsSignIn && { signIn: error.connection }) };
  }
}

// The model sees each skill's name and one sentence, and opens the body only
// when it applies. In the system prompt instead, every skill would cost its
// full text on every step of every turn.
function skillTool(skills: Skill[]): ChloeTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return Object.assign(tool({
    description:
      "Open one of your skills and read what it says. A skill tells you when to do something and " +
      "how. Open the skill before doing the thing it covers.",
    inputSchema: z.object({ name: z.string().describe("The skill's name, from the list in your instructions.") }),
    execute: ({ name }) => {
      const found = byName.get(name);
      if (!found) throw new Error(`No skill called ${JSON.stringify(name)}. You have: ${[...byName.keys()].join(", ")}`);
      return found.body;
    },
  }), { own: true });
}

/**
 * The agent's own instructions talk about people in the third person, because
 * they describe them. This is what stops that carrying over into a
 * conversation with one of them.
 */
function talkingWith({ name, source, asYouGo }: { name: string; source: string; asYouGo: boolean }): string {
  return (
    `## Who you are talking to\n\n` +
    `You are talking with ${name} on ${source}, directly. Write to them as "you", never by name or in the third person.` +
    (asYouGo ? " What you write before calling a tool is sent to them straight away, so write that to them too." : "")
  );
}

/**
 * The tools a turn of this agent has: its own and `skillRead`, less any its
 * channel leaves out, less those for its owner unless the owner wrote, and
 * less those that change it unless the owner may. A turn its owner wrote also
 * has the tools that read its own folder and runs.
 */
function toolsFor(agent: Agent, without: string[] = [], who: { fromOwner?: boolean; mayChangeAgent?: boolean } = {}): Tools {
  const owner = Boolean(who.fromOwner || who.mayChangeAgent);
  const tools: Tools = {
    ...(owner ? selfReadTools(ownFileRules(agent.features))(agent) : {}),
    ...(agent.tools ?? {}),
    skillRead: skillTool(agent.skills),
  };
  for (const name of without) delete tools[name];
  for (const [name, one] of Object.entries(tools)) {
    if ((one.forOwner && !owner) || (one.changesAgent && !who.mayChangeAgent)) delete tools[name];
  }
  return tools;
}

/**
 * What an agent that may change itself is told in a turn that cannot: who can
 * ask for a change, and what to do with a lesson meanwhile. Empty when it may,
 * or never could.
 */
function cannotChange(agent: Agent, tools: Tools): string {
  if (!ownFileRules(agent.features) || Object.values(tools).some((one) => one.changesAgent)) return "";
  return (
    "## Changing yourself\n\n" +
    "You cannot change your own instructions, skills or jobs in this turn: only your owner can ask for that, in a " +
    "message to you. " +
    (agent.features?.memory === false ? "When" : "Keep what you learned in your memory, and when") +
    " it should change one of those files, say which and how in one line, so they can ask."
  );
}

/** The most of its own files an agent is shown by name in its instructions. */
const FILES_SHOWN = 100;

/**
 * What an agent that may change itself is told in a turn its owner wrote: its
 * files, the guides and what each covers, to read what a change needs in one
 * call and write it in one more, and that a secret goes in the Keys box, never a chat.
 * Empty for any other turn.
 */
async function whatYouRunOn(agent: Agent, tools: Tools): Promise<string> {
  if (!ownFileRules(agent.features) || !tools.selfReadGuide) return "";
  const { files } = await ownFiles(agent, ownFileRules(agent.features), FILES_SHOWN + 1);
  const shown = files.slice(0, FILES_SHOWN).map((one) => `- ${one.path}${one.canWrite ? "" : ` (not yours to write: ${one.why})`}`);
  if (files.length > FILES_SHOWN) shown.push("- and more, which selfListFiles lists");
  const changing = tools.selfWriteFile
    ? "To change yourself, read every file and guide the change needs at once, with one selfReadFile and one " +
      "selfReadGuide call in the same step, then write every file in one selfWriteFile call. Never read them one at " +
      "a time. "
    : "";
  return (
    "## What you run on\n\n" +
    "You run on Chloe, and you can be given more than you have now: Gmail, Calendar and Drive, sending mail, " +
    "Telegram, Slack, WhatsApp, email conversations, a chat box on a website, reading web pages, scripts, jobs on a " +
    "schedule. When you are asked for something you cannot do yet, read the guides it needs, then add it to " +
    "yourself or say what your owner has to do for it. " +
    changing +
    "Never ask for a key, password or secret in a chat: say which line goes in .env, and send your owner to the Keys " +
    "box on the dashboard's Settings page, as a link to /settings?key=<the name>, which writes it into .env without " +
    "you or the chat seeing it. A setting, and the process.env line that hands a key over, go in chloe.config.ts, " +
    "which you cannot write: say the line and where it goes, and your owner changes it on the same page, at " +
    "/settings#config. A sign-in like Google's is done by Chloe itself, with a link, never by you.\n\n" +
    `### Your files\n\n${shown.join("\n") || "None yet."}\n\n` +
    `### The guides\n\n${guides().map((one) => `- **${one.page}**: ${one.about}`).join("\n")}`
  );
}

function systemPrompt(agent: Agent, person: { name: string; source: string; asYouGo: boolean } | "" | undefined, overviews: string, note = "", cannot = "", runsOn = ""): string {
  // Without its own name, the only name a model is shown is Chloe's, and it answers to that.
  const parts = [`Your name is ${agent.label ?? agent.id}.`, agent.instructions];
  if (person) parts.push(talkingWith(person));
  if (runsOn) parts.push(runsOn);
  if (cannot) parts.push(cannot);
  if (note) parts.push(`## Your note on them\n\n${note}`);
  if (overviews) parts.push(overviews);
  if (agent.skills.length > 0) {
    parts.push(
      "## Your skills\n\n" +
        "Open one with the `skillRead` tool before doing the thing it covers.\n\n" +
        agent.skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n"),
    );
  }
  parts.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
  return parts.join("\n\n");
}

function save(runId: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set steps = ?, cost = ?, trace = ? where id = ?").run(
    steps, cost, JSON.stringify(trace), runId,
  );
}

function finish(runId: string, reply: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, reply = ?, summary = ?, steps = ?, cost = ?, trace = ? where id = ?").run(
    new Date().toISOString(), reply, oneLineSummary(reply), steps, cost, JSON.stringify(trace), runId,
  );
}

function fail(runId: string, error: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, error = ?, steps = ?, cost = ?, trace = ? where id = ?").run(
    new Date().toISOString(), error, steps, cost, JSON.stringify(trace), runId,
  );
}

/** How much of one tool's answer the record keeps. */
const CLIPPED = 4000;

/** So one tool answer in the record is not a megabyte of HTML. */
function clip(output: unknown): unknown {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.length > CLIPPED ? `${text.slice(0, CLIPPED)}...[${text.length} bytes]` : output;
}
