// Ask the model, run the tools it asked for, put the answers back, ask again.
// Every step is written to the run as it happens, because a job that goes
// wrong at four in the morning is only debuggable if that record exists.
import { randomUUID } from "node:crypto";

import { isStepCount, tool, type StopCondition, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";

import { duringRun, holdBack, inTrial } from "#chloe/core/current";
import { CUT_OFF, db } from "#chloe/core/db";
import { limited, minutesText, until } from "#chloe/core/limit";
import { oneLineSummary } from "#chloe/core/markdown";
import { settings } from "#chloe/core/settings";
import { abilityOn, type Agent, type ChatHistory } from "#chloe/load/load";
import { ask, type Attachment, type Message, type ToolCall } from "#chloe/model/model";
import { decide } from "#chloe/model/auto";
import { AUTO, modelFor } from "#chloe/model/choices";
import { recall, remember } from "#chloe/model/memory";
import { ownFolderTools, ownReadTools, ownTrialTools } from "#chloe/model/tools/self";
import { approval, check, connectionsUsed, describe, overviewsOf, run, type Call, type ChloeTool, type ToolContext, type ToolKind, type Tools } from "#chloe/model/tool";
import { afterRun, beforeRun } from "#chloe/services/historyService";
import { receivedFolder } from "#chloe/services/receivedService";
import { chatAsk, chatSendFile, type FileToSend } from "#chloe/model/tools/chat";
import { NeedsSignIn } from "#chloe/connections/connection";
import type { Reply } from "#chloe/load/plugin";
import { PLUGINS } from "#chloe/plugins/index";

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
  /**
   * The timezone of the person this reply is to, like "Europe/Madrid", so the
   * model is told their date rather than the server's. A channel that knows
   * where its writer is sets it; one that cannot tell leaves it out and the
   * job's `timezone` decides, else UTC. Default: none.
   */
  timeZone?: string;
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
  guest?: boolean;
  /**
   * Set when the agent's owner wrote this message. Only then does the model
   * get the tools only the owner may use (tools marked `forOwner`): its past
   * runs (`ownListRuns`, `ownReadRun`), which hold what other people said,
   * the guides (`ownReadGuide`), and trying one of its jobs (`ownTryJob`).
   * Reading its own folder (`ownListFiles`, `ownReadFile`) is every turn's.
   * Off by default.
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
   * Sends a file into the conversation this message came from. A channel that
   * can send files passes it, and with it the model gets `chatSendFile`, for a
   * file in the agent's memory or one somebody sent it. Never for a guest.
   * Default: none.
   */
  sendFile?: (file: FileToSend) => Promise<void>;
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
  /**
   * Runs it as a trial: what its tools would send to a person through chloe
   * (a channel, an email) is written into the run's record instead, and
   * nothing goes. A tool from an MCP server, or one that sends with its own
   * `fetch`, is not held back. A turn started inside a trial is a trial too.
   * Default: false.
   */
  trial?: boolean;
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
  /** What the run spent, in dollars, counting only the answers that came with a price. */
  cost: number;
  /** How many model answers came with no price. Above 0, the run spent at least `cost`, and how much more is unknown. */
  unpriced: number;
  /** Every tool call made, in order, with the input it was given and the output it returned. */
  calls: Call[];
  /**
   * Set when the message was handed to the reply already going in its
   * conversation, which answers it: `runId` is that reply's, `text` is empty,
   * and nothing ran.
   */
  joined?: boolean;
  /** Set when the reply ends with a question to pick an answer to (`chatAsk`): the answers, to show as buttons. */
  options?: string[];
  /** Set with `options` when several may be picked. */
  multiple?: boolean;
}

function shown(history: ChatHistory = {}): { limit?: number; days?: number } {
  return { limit: history.messages, days: history.days };
}

/** Dollars, at the size these numbers actually are: $0.0004 and $0.10, not $0.00 and $0.1. */
export function money(amount: number): string {
  return `$${amount.toFixed(4).replace(/(\.\d\d)0+$/, "$1")}`;
}

/** What a run spent, in words: "$0.02", or "unknown", or "at least $0.02" when some of its answers came with no price. */
export function spentText(cost: number, unpriced = 0): string {
  if (!unpriced) return money(cost);
  return cost > 0 ? `at least ${money(cost)}` : "unknown";
}

/** What stops a turn when its agent's `stopWhen` says nothing: forty steps that ran tools. */
const STOP_WHEN = isStepCount(40);
/**
 * How many minutes one tool call may take when its tool says nothing, as long
 * as one model call may (`model.timeLimit`). With both, every wait in a turn
 * has an end, and `stopWhen` caps how many there are, so a turn that keeps
 * making progress may run as long as it needs and one stuck on a call cannot.
 */
const TOOL_MINUTES = 10;

/** An agent's `stopWhen` as a list, the way the loop checks it. */
function stopWhenOf(agent: Agent): StopCondition<any>[] {
  const said = agent.stopWhen ?? STOP_WHEN;
  return Array.isArray(said) ? said : [said];
}

/**
 * The reply going now in each conversation. A message from the same person
 * while it runs is handed to it before its next step, so it is never answered
 * by a second reply beside the first, which would not see the first's answer.
 */
const going = new Map<string, Going>();

interface Going {
  runId: string;
  /** Who it is answering, as `turn()`'s `user`. Only their messages join it. */
  user: string;
  /** Messages sent since the model was last asked. */
  waiting: string[];
  /** False once the reply has given its last answer: a message after that waits for `done`. */
  open: boolean;
  done: Promise<void>;
  stop: AbortController;
}

/** What a reply stopped with `stopReply` throws. */
export class ReplyStopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

/**
 * Stops the reply going in a conversation, as its next step starts or the
 * call it is waiting on is cut off. Returns the reply's run id, or undefined
 * when none is going.
 */
export function stopReply(thread: string): string | undefined {
  const now = going.get(thread);
  now?.stop.abort(new ReplyStopped());
  return now?.runId;
}

/**
 * Sends one message to an agent and returns its reply. The model may call
 * tools: each time it does, the tools run and their answers go back to the
 * model, until it answers without calling a tool.
 *
 * The model gets the agent's purpose, its tools and its skills. Each
 * step is saved to the run history as it happens.
 *
 * The run stops early when the agent's `stopWhen` is met (default: 40 rounds
 * of tool calls), and `text` then says so. A tool that fails does not stop
 * the run: the model is told what went wrong. Throws when asking the model
 * fails.
 *
 * One reply at a time in a conversation. A message there while a reply is
 * going joins it, when it is from the same `user` and carries no attachments:
 * the model reads it before its next step, the reply answers both, and this
 * call returns at once with `joined`. Any other message waits for that reply
 * to end, then has its own.
 */
export async function turn(options: Ask): Promise<Result> {
  const { thread, user, attachments } = options;
  for (let now = thread ? going.get(thread) : undefined; now; now = going.get(thread!)) {
    if (now.open && user && now.user === user && !attachments?.length) {
      now.waiting.push(options.prompt);
      return { runId: now.runId, text: "", steps: 0, cost: 0, unpriced: 0, calls: [], joined: true };
    }
    await now.done;
  }
  const runId = randomUUID();
  // Set before anything is awaited, so a message sent from here on finds it.
  let ended = () => {};
  const mine: Going | undefined = thread && user
    ? { runId, user, waiting: [], open: true, done: new Promise<void>((resolve) => (ended = resolve)), stop: new AbortController() }
    : undefined;
  if (mine) going.set(thread!, mine);
  const signal = mine && options.signal ? AbortSignal.any([options.signal, mine.stop.signal]) : (mine?.stop.signal ?? options.signal);
  try {
    return await answer({ ...options, signal }, runId, mine);
  } finally {
    if (mine && going.get(thread!) === mine) going.delete(thread!);
    ended();
  }
}

/** One reply, recorded as `runId`. `mine` is its place in `going`, when it is in a conversation with somebody. */
async function answer({ agent, prompt, asked, attachments, model, thread, source, job, history, said, calling, writing, talkingTo, timeZone, owner, without, guest, fromOwner, mayChangeAgent, sendFile, user, instead, signal, trial }: Ask, runId: string, mine?: Going): Promise<Result> {
  // Auto when the chat's pick says so, or the agent does and nothing picked another.
  const auto = model === AUTO || (!model && agent.auto) ? await decide(agent, asked ?? prompt, thread, signal) : undefined;
  const using = auto?.model ?? model ?? modelFor(agent);
  const trace: LoopStep[] = auto ? [{ step: 0, at: new Date().toISOString(), chose: auto.why, ...(auto.cost !== undefined && { cost: auto.cost }), ...(auto.unpriced && { unpriced: true }) }] : [];

  const started = new Date().toISOString();
  db.prepare(
    "insert into runs (id, agent, started, source, job, model, prompt, asked, kind, owner, thread, held) values (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?, ?)",
  ).run(runId, agent.id, started, source, job ?? null, using, prompt, asked ?? null, owner ?? null, thread ?? null, trial || inTrial() ? "[]" : null);

  const tools = toolsFor(agent, without, { fromOwner, mayChangeAgent, sendFile, guest, chat: Boolean(thread) });
  const overviews = await overviewsOf(tools);
  const messages: Message[] = [
    { role: "system", content: systemPrompt(agent, talkingTo && { name: talkingTo, source, asYouGo: Boolean(said) }, overviews, await pluginWords(agent, { tools, guest: Boolean(guest), user }), todayIn(zoneFor(timeZone, agent, job))) },
    ...(thread ? recall(thread, { ...shown(history), tools: true }) : []),
    { role: "user", content: prompt, attachments },
  ];
  // Keep the initial request as the model received it. Attachments stay out of
  // the record because their bytes are already kept by the channel, not the run.
  db.prepare("update runs set context = ? where id = ?").run(JSON.stringify(messages.map(contextMessage)), runId);
  if (thread) remember(thread, "user", prompt);

  const inbox: Inbox | undefined = mine && {
    take: () => mine.waiting.splice(0),
    takeLast: () => {
      const taken = mine.waiting.splice(0);
      if (taken.length === 0) mine.open = false;
      return taken;
    },
  };
  const result = await go({ agent, runId, model: using, messages, trace, job, source, thread, said, calling, writing, without, guest, fromOwner, mayChangeAgent, sendFile, user, instead, signal, inbox });
  // A reply that stopped early (out of steps, a sign-in) never asked for its
  // last messages, and nothing else will read them.
  if (!mine) return result;
  mine.open = false;
  if (mine.waiting.length === 0) return result;
  return { ...result, text: `${result.text}\n\n(You wrote again after I had stopped, so I have not read it. Send it again.)` };
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
  guest?: boolean;
  fromOwner?: boolean;
  mayChangeAgent?: boolean;
  sendFile?: Ask["sendFile"];
  user?: string;
  instead?: Ask["instead"];
  /** Steps already taken, which the agent's `stopWhen` counts. */
  before?: number;
  carried?: boolean;
  signal?: AbortSignal;
  inbox?: Inbox;
}): Promise<Result> {
  const { agent, runId, trace, job, source, thread, said, calling, writing, instead } = options;
  const tools = toolsFor(agent, options.without, { ...options, chat: Boolean(thread) });
  const before = answers(trace);
  const calls: Result["calls"] = [];
  // An eval answers every tool itself, so nothing it does is written anywhere.
  const committed = (end: { summary?: string; error?: string }) =>
    instead ? Promise.resolve() : afterRun(agent, runId, { job, source, ...end });
  if (!instead && !options.carried) await beforeRun(agent, runId);
  // An answer the model gave before a message arrived, kept in the
  // conversation once, before what arrived.
  let answered: LoopStep | undefined;

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
        inbox: options.inbox,
        onCall: calling && ((name) => calling({ name, title: tools[name]?.title })),
        onText: writing,
        onStep: (line) => {
          trace.push({ ...line, step: line.step + before });
          if (said && line.say?.trim() && line.wants?.length) said(line.say);
          if (line.say !== undefined) answered = line.wants?.length ? undefined : line;
          if (line.heard !== undefined && thread) {
            if (answered?.say) remember(thread, "assistant", answered.say);
            answered = undefined;
            remember(thread, "user", line.heard);
          }
          if (line.tool) calls.push({ toolName: line.tool, input: line.args, output: line.result });
          save(runId, answers(trace), costOf(trace), unpricedOf(trace), trace);
        },
      }),
    );
    // A run that carried on has steps and spending from before it stopped.
    const steps = answers(trace);
    const cost = costOf(trace);
    const unpriced = unpricedOf(trace);
    // A sign-in somebody can do from here is an answer, not a failure: the
    // runtime starts it and the reply is the connection's own words and link.
    const signIn = done.stopped === "sign-in" && done.signIn && !options.guest ? await signInReply(tools, done.signIn, Boolean(thread)) : undefined;
    if (done.stopped && !signIn) {
      fail(runId, done.text, steps, cost, unpriced, trace);
      await committed({ error: done.text });
      return { runId, text: done.text, steps, cost, unpriced, calls };
    }
    const last = signIn ?? done.ended?.text ?? done.text;
    // Each answer it gave before a message arrived is part of the reply, since
    // only a channel that sends as it goes has sent it.
    const text = [...done.earlier, last].join("\n\n");
    finish(runId, text, steps, cost, unpriced, trace);
    await committed({ summary: oneLineSummary(text) });
    if (thread) remember(thread, "assistant", last, calls);
    const picking = done.ended?.options?.length ? { options: done.ended.options, ...(done.ended.multiple && { multiple: true }) } : {};
    return { runId, text, steps, cost, unpriced, calls, ...picking };
  } catch (error) {
    const why = String(error instanceof Error ? error.message : error);
    fail(runId, why, answers(trace), costOf(trace), unpricedOf(trace), trace);
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
  /** What the tool does, in one word, when the tool says it (`kind` in model/tool.ts). */
  kind?: ToolKind;
  /** Set on a call to a tool that only touches the agent itself (`own`). */
  own?: boolean;
  args?: unknown;
  result?: unknown;
  failed?: boolean;
  /** Set on a call the job would not allow. It never ran. */
  refused?: boolean;
  cost?: number;
  /** Set on a model answer that came with no price. */
  unpriced?: boolean;
  /** Set on the line where a run the service stopped picked up again: what happened, in words. */
  carried?: string;
  /** Set on the first line of a reply on Auto: which model it went to, and why, in words. */
  chose?: string;
  /** A message the person sent while the reply was going, handed to the model here. */
  heard?: string;
}

/** Messages sent into a conversation while its reply is going, for `loop` to hand to the model. */
export interface Inbox {
  /** The messages sent since it was last asked. */
  take(): string[];
  /** The same, and when there are none, a message after this is not taken in: it waits for the next reply. */
  takeLast(): string[];
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
   * over the line is paid for. An answer with no price stops it too, since
   * what was spent can no longer be counted.
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
  /**
   * Messages sent while it runs. Each is handed to the model after the tools
   * it asked for have answered, and an answer with no tool calls is not the
   * last while there are more: the model is asked again with them.
   */
  inbox?: Inbox;
  /** Handed the name of each tool it has as the call starts, before it is known whether it may run. */
  onCall?: (name: string) => void;
  /** Handed the model's words as they are written, on a route that streams them. */
  onText?: (delta: string) => void;
}): Promise<{
  text: string;
  steps: number;
  cost: number;
  /** How many answers came with no price. */
  unpriced: number;
  calls: Result["calls"];
  /** The answers it gave before a message from the inbox arrived, in order. `text` is the last one. */
  earlier: string[];
  stopped: false | "steps" | "budget" | "unpriced" | "person" | "sign-in";
  waiting?: { calls: ToolCall[]; reason: string; input: unknown };
  /** With "sign-in": the connection a tool needs somebody to sign in to, and what failed, in words. */
  signIn?: { connection: string; why: string };
  /** What a tool marked `endsReply` returned, which is the reply. */
  ended?: { text: string; options?: string[]; multiple?: boolean };
}> {
  const specs = await Promise.all(Object.entries(options.tools).map(([name, one]) => describe(name, one)));
  const calls: Result["calls"] = [];
  let cost = 0;
  let unpriced = 0;
  // What the stop conditions read: each step's text, the calls it made and what came back.
  const taken: Taken[] = Array.from({ length: options.before ?? 0 }, () => ({ text: "", toolCalls: [], toolResults: [] }));
  let resume = options.resume;
  // The first tool to answer in this reply that is not `own`. After it, a tool
  // that changes the agent, or one marked `afterOutside`, is refused: what it
  // read could be asking for it. The owner's next message starts clean.
  let readOutside = "";
  const earlier: string[] = [];
  const hand = (texts: string[], step: number) => {
    for (const text of texts) {
      options.messages.push({ role: "user", content: text });
      options.onStep?.({ step, at: new Date().toISOString(), heard: text });
    }
  };

  for (let steps = 0; ; steps++) {
    options.signal?.throwIfAborted();
    let toolCalls: ToolCall[];
    const step: Taken = { text: "", toolCalls: [], toolResults: [] };
    if (resume) {
      toolCalls = resume.calls;
    } else {
      const answer = await until(options.signal, ask({ model: options.model, messages: options.messages, tools: specs, signal: options.signal, onText: options.onText }));
      if (answer.cost === undefined) unpriced++;
      cost += answer.cost ?? 0;
      options.onStep?.({
        step: steps,
        at: new Date().toISOString(),
        say: answer.text,
        ...(answer.dropped && { dropped: answer.dropped }),
        wants: answer.toolCalls.map((c) => c.function.name),
        ...(answer.cost === undefined ? { unpriced: true } : { cost: answer.cost }),
      });

      if (answer.toolCalls.length === 0) {
        const more = options.inbox?.takeLast() ?? [];
        if (more.length === 0) return { text: answer.text, steps: steps + 1, cost, unpriced, calls, earlier, stopped: false };
        options.messages.push({ role: "assistant", content: answer.text });
        earlier.push(answer.text);
        hand(more, steps);
        continue;
      }

      // Out of money before running what it asked for, because running the tools
      // only leads to a turn there is nothing left to pay for.
      if (options.budget !== undefined && answer.cost === undefined) {
        return { text: `Stopped: ${options.model} named no price for its answer, so a budget cannot be kept.`, steps: steps + 1, cost, unpriced, calls, earlier, stopped: "unpriced" };
      }
      if (options.budget !== undefined && cost >= options.budget) {
        return { text: `Stopped after spending ${money(cost)} without finishing.`, steps: steps + 1, cost, unpriced, calls, earlier, stopped: "budget" };
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
        (one?.changesAgent || one?.afterOutside) && readOutside
          ? refusedCall(call, `this reply used ${readOutside}, and what it read may be what asked for this. Say what you would ${one?.changesAgent ? "change" : "run"}, and your owner can ask for it in their next message`)
          : await runTool(options.tools, call, { context: options.context, instead: options.instead, toolApproval: options.toolApproval, canAsk: options.canAsk, decided, signal: options.signal });
      if ("person" in ran) {
        return { text: "", steps, cost, unpriced, calls, earlier, stopped: "person", waiting: { calls: toolCalls.slice(n), reason: ran.person, input: ran.args } };
      }
      const { output, args, failed, refused, signIn } = ran;
      if (one && !one.own && !refused && !readOutside) readOutside = call.function.name;
      step.toolCalls.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: args });
      step.toolResults.push({ type: "tool-result", toolCallId: call.id, toolName: call.function.name, input: args, output });
      calls.push({ toolName: call.function.name, input: args, output, ...(refused && { refused }) });
      options.onStep?.({ step: steps, at, tool: call.function.name, ...(one?.kind && { kind: one.kind }), args, result: clip(output), ...(one?.own && { own: true }), ...(failed && { failed }), ...(refused && { refused }) });
      // Fixed by somebody signing in, which the runtime starts, so the model is
      // not asked again: it would only try to get round it.
      if (signIn) {
        const why = String(output).replace(/^[\w-]+ failed: /, "");
        return { text: `${why} Somebody signs in from a chat with this agent, or from the dashboard.`, steps: steps + 1, cost, unpriced, calls, earlier, stopped: "sign-in", signIn: { connection: signIn, why } };
      }
      if (one?.endsReply && !failed && !refused) {
        const reply = output as { text?: unknown; options?: unknown; multiple?: unknown };
        const ended = {
          text: String(reply?.text ?? ""),
          ...(Array.isArray(reply?.options) && { options: reply.options.map(String) }),
          ...(reply?.multiple === true && { multiple: true }),
        };
        return { text: ended.text, steps: steps + 1, cost, unpriced, calls, earlier, stopped: false, ended };
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
    if (met.some(Boolean)) return { text: outOfStepsText(steps + 1), steps: steps + 1, cost, unpriced, calls, earlier, stopped: "steps" };
    hand(options.inbox?.take() ?? [], steps);
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

/** How many answers in the trace came with no price. */
function unpricedOf(trace: unknown[]): number {
  return trace.filter((one) => (one as { unpriced?: boolean }).unpriced).length;
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
  how: { context: ToolContext; instead?: Ask["instead"]; toolApproval?: ToolApprovalConfiguration<any, any>; canAsk?: boolean; decided?: Decided; signal?: AbortSignal },
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

  // Held back by default: a tool that forgot to say it only reads is written
  // down rather than let through.
  if (!how.instead && !one.own && !one.onlyReads && holdBack({ kind: "tool", to: name, text: JSON.stringify(checked.value) })) {
    return { output: `This is a trial run: ${name} was written down and not called. Carry on as if it had worked.`, args: checked.value };
  }

  const minutes = one.timeLimit ?? TOOL_MINUTES;
  const limit = limited(how.signal, minutes, `it ran out of time after ${minutesText(minutes)} and was told to stop`);
  try {
    const output = await until(limit.signal, Promise.resolve(how.instead ? how.instead(name, checked.value) : run(one, checked.value, call.id, how.context, limit.signal)));
    return { output: output ?? { ok: true }, args: checked.value };
  } catch (error) {
    // The turn or the step being stopped ends it. A call that ran out of its
    // own time failed like any other, and the model can try another way.
    if (how.signal?.aborted) throw how.signal.reason;
    const output = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    return { output, args: checked.value, failed: true, ...(error instanceof NeedsSignIn && { signIn: error.connection }) };
  } finally {
    limit.done();
  }
}

/**
 * One section of the words a reply starts with. Every contributor hands over
 * whole sections, and each section's heading names who put it there, so where
 * an instruction comes from is readable in the prompt itself and a new feature
 * is a new section rather than a patch on another one's words.
 */
interface Section {
  /** What the section is about, shown as its heading, like "Your skills". */
  about: string;
  /** Who put it there, shown in the heading, like "the runtime" or "the memory plugin". */
  from: string;
  /** The words of the instruction, with no heading of their own. */
  text: string;
}

/** One section as it stands in the prompt: a heading naming what it covers and who put it there, then the words. */
const said = ({ about, from, text }: Section): string => `## ${about} (from ${from})\n\n${text}`;

/**
 * The agent's own purpose talks about people in the third person, because
 * they describe them. This is what stops that carrying over into a
 * conversation with one of them.
 */
function talkingWith({ name, source, asYouGo }: { name: string; source: string; asYouGo: boolean }): Section {
  return {
    about: "Who you are talking to",
    from: "the runtime",
    text:
      `You are talking with ${name} on ${source}, directly. Write to them as "you", never by name or in the third person.` +
      (asYouGo ? " What you write before calling a tool is sent to them straight away, so write that to them too." : ""),
  };
}

/**
 * What a reply read on a page of the dashboard is shown as, so writing the
 * person will copy and use somewhere else comes out as a card with a copy
 * button. Its own section, so what a future page shows is added here as a new
 * section rather than patched into another one's words.
 */
function howShown(source: string): Section | undefined {
  // Whether a reply is read on the dashboard's own chat, which shows a `writing` fence as a card to copy.
  const onPage = source === "chat" || source === DASHBOARD;
  if (!onPage) return undefined;
  return {
    about: "How your reply is shown",
    from: "the runtime",
    text:
      "Your reply is shown as markdown. Writing they will copy and use somewhere else, like a song, a poem, an email or a message to send, " +
      "goes inside a fenced block marked `writing`, which shows as a card with a copy button. Anything you say about it goes outside the block.",
  };
}

/** Its skills as one section: what each covers, for the model to open the one it needs. Undefined when it has none. */
function skillsOf(agent: Agent): Section | undefined {
  if (agent.skills.length === 0) return undefined;
  return {
    about: "Your skills",
    from: "the runtime",
    text:
      "Read one's file with ownReadFile before doing the thing it covers. They are in your own folder, not your memory.\n\n" +
      agent.skills.map((s) => `- **${s.name}** (${s.file}): ${s.description}`).join("\n"),
  };
}

/** What each plugin adds to this reply's purpose, each section carrying the plugin's own name. */
async function pluginWords(agent: Agent, reply: Reply): Promise<Section[]> {
  const each = await Promise.all(
    PLUGINS.map(async (one) =>
      ((await one.words?.(agent, reply)) ?? []).map(({ about, text }) => ({ about, from: `the ${one.name} plugin`, text })),
    ),
  );
  return each.flat();
}

/**
 * A timezone name `Intl` can read, or undefined when there is not one. The
 * writer's word for where they are is not trusted to be one: a browser or a
 * token caller can send anything.
 */
function zoneOf(said: string | undefined): string | undefined {
  if (!said) return undefined;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: said });
    return said;
  } catch {
    return undefined;
  }
}

/**
 * Which timezone's date the model is told: the writer's when the channel
 * carried it, else the job's, else UTC.
 */
function zoneFor(timeZone: string | undefined, agent: Agent, job: string | undefined): string {
  return zoneOf(timeZone) ?? zoneOf(agent.jobs.find((one) => one.id === job)?.timezone) ?? "UTC";
}

/** Today's date in `zone`, as YYYY-MM-DD, with daylight saving handled through `Intl`. */
function todayIn(zone: string): string {
  const date = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...date, timeZone: zone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...date, timeZone: "UTC" }).format(new Date());
  }
}

/**
 * The tools a turn of this agent has: its own, less any its
 * channel leaves out, less those for its owner unless the owner wrote, and
 * less those that change it unless the owner may. Every turn reads its own
 * folder (`ownListFiles`, `ownReadFile`); a turn its owner wrote also reads
 * its runs and the guides, and may try one of its jobs. A turn in a
 * conversation (`chat`) may end with a question to pick from (`chatAsk`).
 */
function toolsFor(agent: Agent, without: string[] = [], who: { fromOwner?: boolean; mayChangeAgent?: boolean; sendFile?: Ask["sendFile"]; guest?: boolean; chat?: boolean } = {}): Tools {
  const owner = Boolean(who.fromOwner || who.mayChangeAgent);
  const tools: Tools = {
    ...ownFolderTools()(agent),
    ...(owner ? { ...ownReadTools()(agent), ...ownTrialTools(agent) } : {}),
    ...(agent.tools ?? {}),
    ...(who.sendFile && !who.guest ? { chatSendFile: chatSendFile(who.sendFile, [agent.memory.folder, receivedFolder(agent.id)]) } : {}),
    ...(who.chat ? { chatAsk: chatAsk() } : {}),
  };
  for (const name of without) delete tools[name];
  for (const [name, one] of Object.entries(tools)) {
    if ((one.forOwner && !owner) || (one.changesAgent && !who.mayChangeAgent)) delete tools[name];
  }
  return tools;
}

/**
 * The tools every agent has with nothing to switch: reading its own folder and
 * skills in every turn, asking a question to pick from in a conversation, and
 * for its owner's turns its runs, the guides and trying a job. Each says
 * whether it is for the owner's turns only.
 */
export function alwaysOnTools(agent: Agent): { name: string; tool: ChloeTool; ownerOnly: boolean }[] {
  const all = toolsFor(agent, [], { fromOwner: true, chat: true });
  return Object.entries(all)
    .filter(([name]) => !(name in (agent.tools ?? {})) && !(name in (agent.toolsOff ?? {})))
    .map(([name, one]) => ({ name, tool: one, ownerOnly: Boolean(one.forOwner) }));
}

/** The dashboard's address from other machines, `serve.url`, without a trailing slash. Empty when unset. */
export function dashboardAddress(): string {
  return settings.serve.url.replace(/\/+$/, "");
}

/**
 * The instructions a reply of this agent starts with when its owner writes from
 * the dashboard: its purpose and everything the runtime and its plugins add.
 * A reply on another channel, to somebody else or with other tools differs only
 * in the parts those change. `purpose` stands in for the agent's own, to show
 * the rest without it, and `timeZone` is the owner's, so the date is the one
 * their replies are told.
 */
export async function ownerPrompt(agent: Agent, purpose = agent.purpose, timeZone?: string): Promise<string> {
  const tools = toolsFor(agent, [], { fromOwner: true, mayChangeAgent: true, chat: true });
  const words = await pluginWords(agent, { tools, guest: false });
  return systemPrompt({ ...agent, purpose }, { name: "your owner", source: DASHBOARD, asYouGo: true }, await overviewsOf(tools), words, todayIn(zoneFor(timeZone, agent, undefined)));
}

/** Where the System Prompt page says the owner is writing from. */
const DASHBOARD = "the dashboard";

/** What the System Prompt page shows where the agent's purpose goes: it is on a page of its own. */
export const PURPOSE_HERE = "<Purpose goes here>";

/**
 * The words one reply starts with: the agent's name and its purpose, then
 * sections that each say who put them there, then today's date in the writer's
 * timezone. `plugins` are the plugin sections; the overviews of its tools stand
 * between them and its skills, self-headed as each one is.
 */
function systemPrompt(agent: Agent, person: { name: string; source: string; asYouGo: boolean } | "" | undefined, overviews: string, plugins: Section[], today: string): string {
  // Without its own name, the only name a model is shown is Chloe's, and it answers to that.
  const parts = [`Your name is ${agent.name ?? agent.id}.`, agent.purpose];
  if (person) {
    parts.push(said(talkingWith(person)));
    const shown = howShown(person.source);
    if (shown) parts.push(said(shown));
  }
  parts.push(...plugins.map(said));
  if (overviews) parts.push(overviews);
  const skills = skillsOf(agent);
  if (skills) parts.push(said(skills));
  parts.push(`Today is ${today}.`);
  return parts.join("\n\n");
}

function save(runId: string, steps: number, cost: number, unpriced: number, trace: unknown[]): void {
  db.prepare("update runs set steps = ?, cost = ?, unpriced = ?, trace = ? where id = ?").run(
    steps, cost, unpriced, JSON.stringify(trace), runId,
  );
}

function finish(runId: string, reply: string, steps: number, cost: number, unpriced: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, reply = ?, summary = ?, steps = ?, cost = ?, unpriced = ?, trace = ? where id = ?").run(
    new Date().toISOString(), reply, oneLineSummary(reply), steps, cost, unpriced, JSON.stringify(trace), runId,
  );
}

function fail(runId: string, error: string, steps: number, cost: number, unpriced: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, error = ?, steps = ?, cost = ?, unpriced = ?, trace = ? where id = ?").run(
    new Date().toISOString(), error, steps, cost, unpriced, JSON.stringify(trace), runId,
  );
}

/** How much of one tool's answer the record keeps. */
const CLIPPED = 4000;

/** So one tool answer in the record is not a megabyte of HTML. */
function clip(output: unknown): unknown {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.length > CLIPPED ? `${text.slice(0, CLIPPED)}...[${text.length} bytes]` : output;
}
