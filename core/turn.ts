// Ask the model, run the tools it asked for, put the answers back, ask again.
// Every step is written to the run as it happens, because a job that goes
// wrong at four in the morning is only debuggable if that record exists.
import { randomUUID } from "node:crypto";

import { isStepCount, tool, type StopCondition, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";

import { duringRun } from "#chloe/core/current";
import { CUT_OFF, db } from "#chloe/core/db";
import { runChanged } from "#chloe/core/events";
import { oneLineSummary } from "#chloe/core/markdown";
import type { Agent, ChatHistory, Skill } from "#chloe/load/load";
import { ask, type Attachment, type Message, type ToolCall } from "#chloe/model/model";
import { modelFor } from "#chloe/model/choices";
import { recall, remember } from "#chloe/model/memory";
import { userNotes } from "#chloe/model/tools/memory";
import { approval, check, connectionsUsed, describe, overviewsOf, run, type Call, type ToolContext, type Tools } from "#chloe/model/tool";
import { afterRun, beforeRun } from "#chloe/services/historyService";
import { NeedsSignIn } from "#chloe/connections/connection";

export interface Ask {
  agent: Agent;
  prompt: string;
  /** What the person wrote, when `prompt` carries more than that. The log shows it as the run's line. */
  asked?: string;
  /** Photos and PDFs that came with the prompt. Seen this turn only: the thread keeps the words. */
  attachments?: Attachment[];
  /** When this job wants one the agent does not normally use. Unsaid, what was chosen for the agent, else what it names. */
  model?: string;
  /** Without one, the turn starts fresh. */
  thread?: string;
  /**
   * The channel it came in on: "telegram", "chat", "api", "terminal",
   * "schedule", "eval", or the name of a channel an agent brings.
   */
  source: string;
  /** The job this turn is, when it is one. */
  job?: string;
  /** How much of `thread` to show: the channel's `chatHistory`. The last 10 messages when unsaid. */
  history?: ChatHistory;
  /**
   * Handed what the model writes before it asks for a tool, as soon as it is
   * written. Never the final answer, which is what turn() returns.
   */
  said?: (text: string) => void;
  /** Handed each tool's name, and its title when it has one, as it starts: for a channel that shows what the agent is doing. */
  calling?: (tool: { name: string; title?: string }) => void;
  /**
   * Handed the model's words as they are written, on a route on a key. Words
   * written before a tool call come this way too, and then to `said`.
   */
  writing?: (delta: string) => void;
  /**
   * The person on the other end of a channel, by name. The model is told it is
   * talking to them, so it writes to them as "you" rather than about them.
   */
  talkingTo?: string;
  /** Who this run is for, as an address. One column, and the team version reads it. */
  owner?: string;
  /** Tools this turn is not given, by name, though the agent has them: a channel that should not reach them. */
  without?: string[];
  /** Somebody nobody vouched for, like a visitor on a web page: a sign-in a tool needs is never started for them. */
  stranger?: boolean;
  /**
   * Who the turn is for, as `channel:id`: handed to every tool as `context.user`,
   * and, for an agent with `memoryPerUser`, whose note it is shown.
   */
  user?: string;
  /** Answer tools from here instead of running them. For evals. */
  instead?: (name: string, args: unknown) => Promise<unknown> | unknown;
  signal?: AbortSignal;
}

/** What one turn came back with, including every tool call it made on the way. */
export interface Result {
  runId: string;
  text: string;
  steps: number;
  cost: number;
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
 * Runs a prompt: ask a model, run the tools it asked for, put the answers
 * back, ask again, until it stops asking.
 */
export async function turn({ agent, prompt, asked, attachments, model, thread, source, job, history, said, calling, writing, talkingTo, owner, without, stranger, user, instead, signal }: Ask): Promise<Result> {
  const runId = randomUUID();
  const using = model ?? modelFor(agent);

  const started = new Date().toISOString();
  db.prepare(
    "insert into runs (id, agent, started, source, job, model, prompt, asked, kind, owner, thread) values (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?)",
  ).run(runId, agent.id, started, source, job ?? null, using, prompt, asked ?? null, owner ?? null, thread ?? null);
  runChanged(runId);

  const overviews = await overviewsOf(toolsFor(agent, without));
  // In the instructions rather than the message, so it is not kept in the conversation again each turn.
  const note = user && toolsFor(agent, without).memoryWriteUserNotes ? await userNotes(agent.memory.folder, user) : "";
  const messages: Message[] = [
    { role: "system", content: systemPrompt(agent, talkingTo && { name: talkingTo, source, asYouGo: Boolean(said) }, overviews, note) },
    ...(thread ? recall(thread, { ...shown(history), tools: true }) : []),
    { role: "user", content: prompt, attachments },
  ];
  // Keep the initial request as the model received it. Attachments stay out of
  // the record because their bytes are already kept by the channel, not the run.
  db.prepare("update runs set context = ? where id = ?").run(JSON.stringify(messages.map(contextMessage)), runId);
  if (thread) remember(thread, "user", prompt);

  return go({ agent, runId, model: using, messages, trace: [], job, source, thread, said, calling, writing, without, stranger, user, instead, signal });
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
  runChanged(runId);

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
  user?: string;
  instead?: Ask["instead"];
  /** Steps already taken, which the agent's `stopWhen` counts. */
  before?: number;
  carried?: boolean;
  signal?: AbortSignal;
}): Promise<Result> {
  const { agent, runId, trace, job, source, thread, said, calling, writing, instead } = options;
  const tools = toolsFor(agent, options.without);
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
      if (options.tools[call.function.name]) options.onCall?.(call.function.name);
      const ran = await runTool(options.tools, call, { context: options.context, instead: options.instead, toolApproval: options.toolApproval, canAsk: options.canAsk, decided });
      if ("person" in ran) {
        return { text: "", steps, cost, calls, stopped: "person", waiting: { calls: toolCalls.slice(n), reason: ran.person, input: ran.args } };
      }
      const { output, args, failed, refused, signIn } = ran;
      step.toolCalls.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: args });
      step.toolResults.push({ type: "tool-result", toolCallId: call.id, toolName: call.function.name, input: args, output });
      calls.push({ toolName: call.function.name, input: args, output, ...(refused && { refused }) });
      options.onStep?.({ step: steps, at, tool: call.function.name, args, result: clip(output), ...(failed && { failed }), ...(refused && { refused }) });
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
function skillTool(skills: Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return tool({
    description:
      "Open one of your skills and read what it says. A skill tells you when to do something and " +
      "how. Open the skill before doing the thing it covers.",
    inputSchema: z.object({ name: z.string().describe("The skill's name, from the list in your instructions.") }),
    execute: ({ name }) => {
      const found = byName.get(name);
      if (!found) throw new Error(`No skill called ${JSON.stringify(name)}. You have: ${[...byName.keys()].join(", ")}`);
      return found.body;
    },
  });
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

/** The tools a turn of this agent has: its own and `skillRead`, less any its channel leaves out. */
function toolsFor(agent: Agent, without: string[] = []): Tools {
  const tools: Tools = { ...(agent.tools ?? {}), skillRead: skillTool(agent.skills) };
  for (const name of without) delete tools[name];
  return tools;
}

function systemPrompt(agent: Agent, person: { name: string; source: string; asYouGo: boolean } | "" | undefined, overviews: string, note = ""): string {
  const parts = [agent.instructions];
  if (person) parts.push(talkingWith(person));
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
  runChanged(runId);
}

function fail(runId: string, error: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, error = ?, steps = ?, cost = ?, trace = ? where id = ?").run(
    new Date().toISOString(), error, steps, cost, JSON.stringify(trace), runId,
  );
  runChanged(runId);
}

/** How much of one tool's answer the record keeps. */
const CLIPPED = 4000;

/** So one tool answer in the record is not a megabyte of HTML. */
function clip(output: unknown): unknown {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.length > CLIPPED ? `${text.slice(0, CLIPPED)}...[${text.length} bytes]` : output;
}
