// A job that is code, with a model as one step inside it.
//
// `core/turn.ts` is the other half of this runtime: ask a model and let it
// decide. This file is for the jobs where the deciding is already written
// down. Nothing here asks a model unless the job calls `model(...)`, so a job
// made of `step(...)` costs nothing and the run record says so.
//
// The job is an async function, so branching is `if` and looping is `for`.
// That choice has one consequence, and it is the whole of the rest of this
// file: to carry on after a pause, the function is run again from the top and
// every finished step hands back what it returned last time. So:
//
//   Work happens inside a step. Code outside a step only decides.
//
// A line outside a step runs again on every resume. If it sends, writes or
// spends, it does so twice.
import { randomUUID } from "node:crypto";

import { isStepCount, Output as Outputs, type InferGenerateOutput, type OutputInterface as Output, type StopCondition, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";

import { deliver, owner as whoOwns } from "#chloe/model/ask";
import { duringRun } from "#chloe/core/current";
import { db } from "#chloe/core/db";
import { runChanged } from "#chloe/core/events";
import { afterRun, beforeRun } from "#chloe/services/historyService";
import { oneLineSummary } from "#chloe/core/markdown";
import type { Agent, Job } from "#chloe/load/load";
import { modelFor } from "#chloe/model/choices";
import { nameOf, type SdkModel } from "#chloe/model/key";
import { ask as askModel, type Message, type ToolCall } from "#chloe/model/model";
import { loop, money, type Decided } from "#chloe/core/turn";
import { cannotRun, overviewsOf, type Call, type ChloeTool, type Tools } from "#chloe/model/tool";

/**
 * One finished step of a job's run, as saved in the run history.
 *
 * When a paused run continues, each finished step returns its saved result
 * and does not run again.
 */
export interface Line {
  /**
   * The step's place in the run, counting from 0, in the order the job called
   * its steps. When a paused run continues, steps are matched by this number
   * and by `name`.
   */
  seq: number;
  /** The name the job gave the step, like "fetch orders" in `work.step("fetch orders", ...)`. */
  name: string;
  /** The kind of step: `work.step()`, `work.model()`, `work.ask()` or `work.agent()`. */
  kind: "step" | "model" | "ask" | "agent";
  /** When the step finished, as an ISO date string. */
  at: string;
  /** How long the step took, in milliseconds. Always 0 for an ask. */
  ms: number;
  /** What the step spent on models, in dollars. 0 for a step that asked no model. */
  cost: number;
  /** What the step returned. Not set when the step failed. */
  result?: unknown;
  /**
   * For a model or agent step: the name of the model it used.
   * For an ask: who was asked, and whether they answered in time, like "telegram:12345 answered".
   */
  note?: string;
  /** For a model or agent step: the prompt it was given. */
  prompt?: string;
  /** For an ask: the question that was sent. */
  question?: string;
  /** For an ask: what the person typed, before it was checked. Not set when nobody answered. */
  reply?: string;
  /** For an agent step: every tool call, in order, including the calls that were not allowed to run. */
  calls?: Call[];
  /** Why the step failed (the error message). The run usually stops here, unless the job catches the error. */
  failed?: string;
}

/** What a job is waiting on. Null on the run means it is not waiting. */
interface Parked {
  seq: number;
  name: string;
  who: string;
  question: string;
  asked: string;
  expires: string;
  /** What came back, not yet understood. */
  reply?: string;
  /** How many times an answer did not fit. Three and the job gives up. */
  confusions?: number;
  /** Set by the sweep when nobody answered in time. */
  late?: boolean;
  /** Set when it is an agent step waiting on a call somebody has to approve: where to pick the loop up. */
  agent?: AgentWait;
}

/** An agent step stopped at a call a person has to approve, as much as it takes to carry on from there. */
interface AgentWait {
  messages: Message[];
  /** The call waiting for a yes, then the ones after it in the same answer. None of them have run. */
  calls: ToolCall[];
  /** Steps it had taken, which its `stopWhen` counts. */
  steps: number;
  /** What it had spent, which its `budget` counts. */
  spent: number;
  /** The calls it had made, for the line it writes when it finishes. */
  record: Call[];
  /** Which go it was on: the first, or the one after an answer that did not fit. */
  attempt: number;
  complaint: string;
}

/**
 * The shape a model's answer must have. It is one of these:
 * - a zod schema, like `z.object({ name: z.string() })`. This is the same as `Output.object({ schema })`.
 * - `Output.choice({ options })` from the AI SDK, to pick one item from a list.
 * - `Output.array({ element })` from the AI SDK, for a list of items.
 */
export type Shape = z.ZodType | Output;

/** The type of an answer in a given `Shape`, after it has been checked. For a zod schema, this is `z.infer` of it. */
export type Answer<O extends Shape> = O extends z.ZodType ? z.infer<O> : O extends Output ? InferGenerateOutput<O> : never;

/**
 * The options for `work.model()`: one question for a model. The answer must
 * come back in the shape you set, so your code can use it.
 */
export interface ModelStep<O extends Shape> {
  /** The question for the model. Required. */
  prompt: string;
  /**
   * The shape the answer must have: a zod schema, or an AI SDK output like
   * `Output.choice({ options })`. See `Shape`. Required.
   *
   * If the answer does not fit, the model is told what was wrong and asked
   * once more. If it still does not fit, the step fails.
   *
   * `Output.text()` is not allowed: the answer must be data your code can check.
   */
  output: O;
  /**
   * The model for this step only, when it should be different from the rest
   * of the job: a name like "anthropic/claude-haiku-4.5", or an AI SDK model.
   * Default: the model the job runs on.
   */
  model?: string | SdkModel;
  /** Extra instructions for the model, sent before the question. Default: none. */
  instructions?: string;
}

/**
 * The options for `work.agent()`. You give a goal and some tools. The model
 * decides which tools to call, and in what order.
 *
 * Use this only when you cannot know the order of the work in advance. If you
 * know the steps, use `work.step()`. If you know the question, use one
 * `work.model()`.
 */
export interface AgentStep<O extends Shape = Shape, T extends Tools = Tools> {
  /** What you want done (the goal), not how to do it. Required. */
  prompt: string;
  /**
   * The tools the model may call, keyed by name, each made with the AI SDK's
   * `tool()`. The model can call nothing else. Required, and it must not be
   * empty (with no tools, use `work.model()`).
   *
   * Each tool needs an `execute` function. A tool that changes the agent
   * itself, like `selfWriteFile`, is not allowed: only the owner can ask for
   * that, in a chat.
   */
  tools: T;
  /**
   * The shape the final answer must have, as for `work.model()`. If the
   * answer does not fit, the model is told what was wrong and asked once more.
   * Default: none, and the step returns the model's final answer as text.
   */
  output?: O;
  /**
   * When the model must stop, as the AI SDK's `stopWhen`: `isStepCount(8)`,
   * `hasToolCall("done")`, or a list of them. It is checked after each round
   * of tool calls. Default: `isStepCount(10)`, which is 10 rounds of tool calls.
   *
   * If this stops the model before it gives its final answer, the step fails
   * with an error. You never get half an answer.
   */
  stopWhen?: StopCondition<NoInfer<T>> | StopCondition<NoInfer<T>>[];
  /**
   * The most this step may spend, in dollars, like `0.5`. It must be more
   * than 0. Off by default.
   *
   * It is checked each time the model answers. The answer that goes over the
   * limit is already paid for, so the step can spend a little more than this:
   * set it at the point where you want the step to give up. If the model has
   * spent this much and still asks for tools, the step fails with an error.
   *
   * Without a budget, `stopWhen` is the only limit, and 10 rounds with a large
   * model can cost a lot.
   */
  budget?: number;
  /**
   * Decides, before each tool call runs, whether it may run. It sees the input
   * the model chose. This is the AI SDK's `toolApproval`: one function for all
   * calls, or an object with a value or a function per tool name. The values:
   * - "approved": the call runs.
   * - "denied", with a reason: the call does not run, and the model is told the reason.
   * - "user-approval": a person must say yes first.
   *
   * When this gives no answer for a call, the tool's own `needsApproval`
   * decides. Default: none, so every call runs unless the tool's
   * `needsApproval` says a person must say yes.
   *
   * When a person must say yes, the run pauses and asks the run's owner yes or
   * no. On yes, the call runs and the step goes on from there. On no, or if
   * nobody answers in 2 hours, the call does not run and the model is told.
   * A run with no owner never runs such a call.
   */
  toolApproval?: ToolApprovalConfiguration<NoInfer<T>, any>;
  /**
   * The model for this step only, when it should be different from the rest
   * of the job: a name like "anthropic/claude-haiku-4.5", or an AI SDK model.
   * Default: the model the job runs on.
   */
  model?: string | SdkModel;
  /** Extra instructions for the model: what it should know before it starts. Default: none. */
  instructions?: string;
}

/**
 * The options for `work.ask()`: a question for a person. The run pauses until
 * they answer. Code checks their answer against `answer`: no model reads it.
 */
export interface AskStep<S extends z.ZodType> {
  /** The question to send. Required. */
  question: string;
  /**
   * The shape the person's answer must have, as a zod schema, like
   * `z.boolean()` or `z.enum(["small", "large"])`. Required.
   *
   * Plain words count: "yes", "ok" or "no" fit `z.boolean()`, and "12" fits
   * `z.number()`. The question is sent with a short hint, like "(yes or no)".
   * On channels that have buttons, a yes or no question, or a list of 8
   * choices or fewer, is sent with a button for each answer.
   *
   * If an answer does not fit, the person is asked again, up to 3 times. After
   * that, the run stops with an error.
   */
  answer: S;
  /**
   * Who to ask, as an address "channel:who", like "telegram:12345".
   * Default: the run's owner (`work.owner`). If there is no owner and no
   * `who`, the step fails.
   */
  who?: string;
  /** How long to wait for an answer: a number and then `m`, `h` or `d`, like "30m", "4h" or "2d". Default: "2h". */
  within?: string;
  /**
   * The answer to use if nobody answers in time. Default: none, and the run
   * stops with an error that says nobody answered.
   */
  otherwise?: z.infer<S>;
}

/**
 * An object with string keys and values of any type. It is the type of
 * `work.state` and `work.args` when the job has no zod schema for them.
 */
export type Data = Record<string, unknown>;

/**
 * Where a run came from and what was said. It has the same fields for every
 * channel. A job reads it as `work.input`.
 *
 * Every field is a string, and is "" when it is not known. A run the clock
 * started has every field empty.
 */
export interface Envelope {
  /** The text of the message that started the run. */
  text: string;
  /** The channel it came in on, like "telegram". */
  from: string;
  /**
   * The chat it was sent in, as the channel names it. To ask a question back
   * in the same chat, use `${from}:${chat}` as `who` in `work.ask()`.
   */
  chat: string;
  /** The title of the chat, when it has one (a group, for example). */
  chatTitle: string;
  /** The name of the person who sent it. */
  user: string;
  /** The sender's id on that channel: an email address, a Telegram user id, or a web visitor's id. */
  userId: string;
  /** The conversation the message belongs to: one per chat, or one per topic in a forum. */
  thread: string;
  /** The text of the message this one replies to, when it is a reply. */
  replyTo: string;
}

/**
 * What a job's `run` function gets: the steps it can take, and facts about
 * the run.
 *
 * Put every piece of work inside a step. When a run pauses (for `work.ask()`,
 * or for a tool call that needs a yes), it later continues by running `run`
 * again from the top. Each finished step then returns its saved result and
 * does not run again. Code outside a step runs again every time, so if it
 * sends, writes or spends something, that happens twice.
 */
export interface Work<State = Data, Args = Data> {
  /**
   * Runs `fn` once and saves what it returns. Use it for any work you can
   * write as code: a request, a query, a file, an email.
   *
   * When a paused run continues, this returns the saved result and does not
   * call `fn` again. If `fn` throws, the step throws too and the error message
   * is saved. When the run continues, the step throws a plain `Error` with
   * that same message, again without calling `fn`.
   *
   * The result is saved as JSON, so return plain data: a `Date`, for example,
   * comes back as a string when the run continues. It must be under 64,000
   * characters as JSON: return what the next step needs, not everything you
   * read.
   *
   * `name` is shown in the run history. If you edit the job while a run is
   * paused, and the steps no longer match by order and name, that run stops
   * with an error instead of continuing.
   */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /**
   * Asks a model one question and returns the answer in the shape you set in
   * `output`. If the answer does not fit, the model is told what was wrong and
   * asked once more, and then the step fails. What it cost is saved with the
   * run. See `ModelStep` for the options.
   */
  model<O extends Shape>(name: string, options: ModelStep<O>): Promise<Answer<O>>;
  /**
   * Gives a model a goal and some tools, and lets it decide which tools to
   * call and in what order. Returns its final answer in the shape of `output`.
   *
   * This gives the model the most freedom, so use it last: only when you
   * cannot know the order of the work in advance. Set limits with `stopWhen`
   * and `budget`. Every tool call is saved with the run. See `AgentStep` for
   * the options.
   */
  agent<O extends Shape, T extends Tools>(name: string, options: AgentStep<O, T> & { output: O }): Promise<Answer<O>>;
  /**
   * Gives a model a goal and some tools, and lets it decide which tools to
   * call and in what order. With no `output`, returns its final answer as
   * text.
   *
   * This gives the model the most freedom, so use it last: only when you
   * cannot know the order of the work in advance. Set limits with `stopWhen`
   * and `budget`. Every tool call is saved with the run. See `AgentStep` for
   * the options.
   */
  agent<T extends Tools>(name: string, options: Omit<AgentStep<Shape, T>, "output">): Promise<string>;
  /**
   * Sends a person a question, and pauses the run until they answer. Returns
   * their answer, checked against the `answer` schema.
   *
   * The run is saved while it waits, so chloe can restart in the meantime.
   * When the answer comes, `run` starts again from the top, and every
   * finished step returns its saved result. While the run waits, the job does
   * not start again on its schedule.
   *
   * Call it between steps, never inside the function you give `work.step()`:
   * that throws an error. See `AskStep` for the options.
   */
  ask<S extends z.ZodType>(name: string, options: AskStep<S>): Promise<z.infer<S>>;
  /**
   * Data this run keeps between its steps. It starts as what the job's
   * `state` schema makes of `{}` (so fields with a default start filled), or
   * `{}` when the job has no schema. It is saved, so it is still there after
   * the run pauses. Each run starts fresh.
   */
  readonly state: State;
  /** Changes `state`: the fields you give replace the old ones, and the other fields stay. Saved at once. */
  setState(next: Partial<State>): Promise<void>;
  /**
   * What this run was started with, checked against the job's `args` schema.
   * For a run the clock started, it is what the schema makes of `{}`, or `{}`
   * when the job has no schema. It never changes: use `state` for data that
   * changes.
   */
  readonly args: Args;
  /**
   * Where this run came from and what was said: the channel, the chat, the
   * sender and the text of the message. A channel fills it. For a run the API
   * started, it holds what the caller sent. For a run the clock started, every
   * field is "". You do not need an `args` schema to read it.
   */
  readonly input: Envelope;
  /**
   * The address of the run's owner, like "telegram:12345". This is who
   * `work.ask()` asks by default. It is `owner` in the settings, or else the
   * first id in `allowFrom` of the agent's Telegram, Slack or WhatsApp
   * channel. "" when there is none.
   */
  readonly owner: string;
  /** The id of the agent this job belongs to. */
  readonly agentId: string;
  /**
   * The full path of the agent's memory folder. When a job saves files there,
   * read the path from here instead of writing it again in the job.
   */
  readonly memory: string;
  /** The id of this run in the run history. */
  readonly runId: string;
  /**
   * Tells you when the run is being stopped. Pass it to `fetch` and other
   * calls that take an `AbortSignal`. Model and agent steps use it already.
   *
   * It is set only when whoever started the run gave one, as
   * `agent.run({ signal })` can. Runs started by the clock or a channel have
   * none.
   */
  readonly signal?: AbortSignal;
}

/** What a job's run returns, when it finishes or when it pauses to wait for a person. */
export interface Result {
  /** The id of the run in the run history. */
  runId: string;
  /**
   * What the job's `run` returned, as text: a string as it is, anything else
   * as JSON (`{ "ok": true }` when it returned nothing).
   *
   * When the run is waiting for a person: "waiting on" and their address.
   * When the run ended because nobody answered, or because the job was
   * changed while the run was paused: the reason.
   */
  text: string;
  /**
   * The start of `reply` as one plain line, up to 200 characters, for the run
   * list on the dashboard. `null` when the job gave no words. Not set when the
   * run did not finish.
   */
  summary?: string | null;
  /**
   * What a chat is sent: the text the job's `response` made from the result,
   * or else the string `run` returned. If `response` throws, a line that says
   * it failed. Not set when there are no words, or when the run did not finish.
   */
  reply?: string;
  /** How many steps the run has taken so far, counting any that failed. */
  steps: number;
  /** What the run has spent so far, in dollars. */
  cost: number;
  /** `true` when the run is paused, waiting for a person's answer. */
  parked: boolean;
}

/** A step's result has to fit in the run record, which is one database row. */
const MOST = 64_000;
const WAIT = "2h";

/** Not an error: the job stopped on purpose and is waiting for somebody. */
class Waiting extends Error {}
/** Nobody answered, and the ask had nothing to carry on with. */
class Unanswered extends Error {}
/** The file changed under a run that was already part way through. */
class Changed extends Error {}

interface Ctx {
  runId: string;
  agent: Agent;
  job: Job;
  lines: Line[];
  seq: number;
  cost: number;
  state: Data;
  /** What the run was started with. Checked once, then never changed. */
  args: Data;
  /** Where the run was started from. Never changed, so it is kept, not checked. */
  input: Envelope;
  parked?: Parked;
  owner: string;
  /** "code" until a model step runs, then whichever model it used. */
  model: string;
  /** The step running right now, while one is. A job pauses between steps, not inside one. */
  inside?: string;
  signal?: AbortSignal;
}

/**
 * Starts a new run of a job written as code (a job with `run`), and waits
 * until the run finishes or pauses to wait for a person. The clock, the
 * channels and `agent.run()` call this for you.
 *
 * Throws `WrongArgs` before the run starts when `input` does not fit the
 * job's `args` schema. Throws when the job is a prompt, or when a step throws
 * an error that the job does not catch.
 */
export async function work(options: {
  /** The loaded agent the job belongs to. Required. */
  agent: Agent;
  /** The job to run. It must be written as code (have `run`). Required. */
  job: Job;
  /** Where the run came from, like "telegram" or "api". It is saved with the run. Default: "unknown". */
  source?: string;
  /**
   * What to start the job with, as an object. The message keys (`text`,
   * `from`, `chat` and the other `Envelope` fields) go to `work.input`.
   * Everything else is checked against the job's `args` schema and goes to
   * `work.args`. Default: nothing.
   */
  input?: unknown;
  /** Stops the run's model calls when it is aborted. The job sees it as `work.signal`. Default: none. */
  signal?: AbortSignal;
}): Promise<Result> {
  const { agent, job } = options;
  if (!job.run) throw new Error(`${agent.id}/${job.id} is a prompt, not code.`);

  // Before the run exists, so a caller that sent the wrong thing is told so
  // rather than left reading a failed run to find out.
  const args = checkArgs(job, options.input);
  const input = envelopeOf(options.input);

  const runId = randomUUID();
  const owner = whoOwns(agent.id);
  const state = starting(job);
  db.prepare(
    `insert into runs (id, agent, started, source, job, model, prompt, kind, owner, state, args, input)
     values (?, ?, ?, ?, ?, 'code', '', 'job', ?, ?, ?, ?)`,
  ).run(
    runId,
    agent.id,
    new Date().toISOString(),
    options.source ?? "unknown",
    job.id,
    owner || null,
    JSON.stringify(state),
    JSON.stringify(args),
    JSON.stringify(input),
  );
  runChanged(runId);

  return drive({
    runId,
    agent,
    job,
    lines: [],
    seq: 0,
    cost: 0,
    state,
    args,
    input,
    owner,
    model: "code",
    signal: options.signal,
  });
}

/**
 * The keys a channel always sends with a message. They are read into
 * `work.input` and kept out of `args`, so a job that declares no shape is
 * never refused for being sent a message.
 */
const ENVELOPE_KEYS = ["text", "from", "chat", "chatTitle", "user", "userId", "thread", "replyTo"] as const satisfies (keyof Envelope)[];

/** Where a run was started from, read off what started it. */
function envelopeOf(sent: unknown): Envelope {
  const given = sent && typeof sent === "object" ? (sent as Data) : {};
  return Object.fromEntries(
    ENVELOPE_KEYS.map((key) => [key, typeof given[key] === "string" ? given[key] : ""]),
  ) as unknown as Envelope;
}

/** What was sent, less the envelope: what a job's `args` shape is checked against. */
function withoutEnvelope(sent: unknown): Data {
  const given = sent && typeof sent === "object" ? (sent as Data) : {};
  return Object.fromEntries(Object.entries(given).filter(([key]) => !(ENVELOPE_KEYS as readonly string[]).includes(key)));
}

/** The error thrown when what a job is started with does not fit its `args` schema. The message says what is wrong. */
export class WrongArgs extends Error {}

/**
 * Checks what a job is started with against the job's `args` schema, and
 * returns the checked values. Throws `WrongArgs` when they do not fit.
 *
 * The message keys (`text`, `from`, `chat` and the other `Envelope` fields)
 * are removed first: they go to `work.input`, never to `args`. Then:
 * - A job with no `args` schema takes nothing else. Any other key is an error.
 * - A job with a schema that the clock starts is checked with `{}`. So a job
 *   with a required field and a cron line fails on its first scheduled run.
 *
 * It runs before the run is created, so whoever started the job gets the
 * error at once.
 */
export function checkArgs(job: Job, sent: unknown): Data {
  const rest = withoutEnvelope(sent);
  if (!job.args) {
    const keys = Object.keys(rest);
    if (keys.length) {
      throw new WrongArgs(
        `${job.agent}/${job.id} does not take anything, so it cannot be started with ${keys.join(", ")}. ` +
          "Give the job an `args` shape if it should.",
      );
    }
    return {};
  }
  const checked = job.args.safeParse(rest);
  if (!checked.success) throw new WrongArgs(`${job.agent}/${job.id}: ${z.prettifyError(checked.error)}`);
  return checked.data as Data;
}

/**
 * Continues a run that paused to wait for a person. It runs the job again
 * from the top, and each finished step returns its saved result. You usually
 * call `answer()` or `sweep()`, which call this.
 *
 * `agents` is every loaded agent by id, as `loadAll()` returns them.
 * `signal`, when given, becomes `work.signal`.
 *
 * Throws when the run does not exist or is not waiting, or when its agent or
 * job is gone or is no longer code.
 */
export async function resume(runId: string, agents: Map<string, Agent>, signal?: AbortSignal): Promise<Result> {
  const row = db.prepare("select * from runs where id = ?").get(runId) as Row | undefined;
  if (!row) throw new Error(`There is no run ${JSON.stringify(runId)}.`);
  if (!row.parked) throw new Error(`Run ${JSON.stringify(runId)} is not waiting for anything.`);

  const agent = agents.get(row.agent);
  if (!agent) throw new Error(`${row.agent} is not an agent here any more, so run ${runId} cannot carry on.`);
  const job = agent.jobs.find((s) => s.id === row.job);
  if (!job?.run) throw new Error(`${row.agent}/${row.job} is not code any more, so run ${runId} cannot carry on.`);

  return drive({
    runId,
    agent,
    job,
    args: (row.args ? JSON.parse(row.args) : {}) as Data,
    input: row.input ? (JSON.parse(row.input) as Envelope) : envelopeOf(row.args ? JSON.parse(row.args) : {}),
    lines: JSON.parse(row.trace) as Line[],
    seq: 0,
    cost: row.cost,
    state: row.state ? (JSON.parse(row.state) as Data) : starting(job),
    parked: JSON.parse(row.parked) as Parked,
    owner: row.owner ?? whoOwns(agent.id),
    model: row.model,
    signal,
  });
}

async function drive(ctx: Ctx): Promise<Result> {
  const api: Work = {
    step: (name, fn) => once(ctx, name, "step", async () => ({ value: await fn() })),
    model: (name, options) => modelStep(ctx, name, options),
    agent: ((name: string, options: AgentStep) => agentStep(ctx, name, options)) as Work["agent"],
    ask: (name, options) => askStep(ctx, name, options),
    get state() {
      return ctx.state;
    },
    setState: async (next) => {
      ctx.state = { ...ctx.state, ...next };
      save(ctx);
    },
    args: ctx.args,
    input: ctx.input,
    owner: ctx.owner,
    agentId: ctx.agent.id,
    memory: ctx.agent.memory.folder,
    runId: ctx.runId,
    signal: ctx.signal,
  };

  // Whatever the memory holds when the run stops, finished or waiting, is what it did.
  const committed = (end: { summary?: string | null; error?: string }) =>
    afterRun(ctx.agent, ctx.runId, { job: ctx.job.id, source: sourceOf(ctx.runId), ...end });
  await beforeRun(ctx.agent, ctx.runId);

  try {
    const value = await duringRun(ctx.runId, () => ctx.job.run!(api));
    ctx.parked = undefined;
    const reply = typeof value === "string" ? value : JSON.stringify(value ?? { ok: true }, null, 2);
    const { words, summary } = said(ctx.job, value);
    finish(ctx, reply, summary);
    await committed({ summary });
    return { runId: ctx.runId, text: reply, summary, reply: words ?? summary ?? undefined, steps: ctx.lines.length, cost: ctx.cost, parked: false };
  } catch (error) {
    if (error instanceof Waiting) {
      save(ctx);
      await committed({ summary: `waiting on ${ctx.parked?.who ?? "an answer"}` });
      return { runId: ctx.runId, text: error.message, steps: ctx.lines.length, cost: ctx.cost, parked: true };
    }
    ctx.parked = undefined;
    const why = error instanceof Error ? error.message : String(error);
    fail(ctx, why);
    await committed({ error: why });
    if (error instanceof Unanswered || error instanceof Changed) {
      return { runId: ctx.runId, text: why, steps: ctx.lines.length, cost: ctx.cost, parked: false };
    }
    throw error;
  }
}

/** The channel a run came in on, as its row says. */
function sourceOf(runId: string): string {
  return (db.prepare("select source from runs where id = ?").get(runId) as { source?: string } | undefined)?.source ?? "unknown";
}

/**
 * The replay. A step that is already in the record hands back what it returned
 * and does not run. The name is checked as well as the place, because a job
 * that was edited while a run was parked would otherwise hand the wrong answer
 * to the wrong step and look like it worked.
 */
async function once<T>(
  ctx: Ctx,
  name: string,
  kind: Line["kind"],
  fn: (charge: (amount: number) => number, calls: Call[]) => Promise<{ value: T; note?: string; prompt?: string }>,
): Promise<T> {
  const seen = ctx.lines[ctx.seq];
  if (seen) {
    if (seen.name !== name || seen.kind !== kind) {
      throw new Changed(
        `This job changed while the run was waiting: step ${ctx.seq} was ${JSON.stringify(seen.name)} ` +
          `and is now ${JSON.stringify(name)}. Start it again rather than carrying on from the middle.`,
      );
    }
    ctx.seq++;
    // A step that failed is in the record too, so replay has to fail the same
    // way rather than hand back the nothing it returned. A job that caught it
    // the first time catches it again.
    if (seen.failed !== undefined) throw new Error(seen.failed);
    return seen.result as T;
  }

  const began = Date.now();
  // An agent step that waited on a person carries on with what it had spent and called.
  const carried = ctx.parked?.seq === ctx.seq ? ctx.parked.agent : undefined;
  let spent = carried?.spent ?? 0;
  /**
   * Charged to the run the moment it is spent, not when the step returns, so a
   * step that fails, or a run cut off part way through one, is still charged
   * for what it used. Returns this step's total.
   */
  const charge = (amount: number): number => {
    ctx.cost += amount;
    return (spent += amount);
  };
  /** Written as the step goes, for the same reason. */
  const calls: Call[] = [...(carried?.record ?? [])];
  const outer = ctx.inside;
  ctx.inside = name;
  try {
    const { value, note, prompt } = await fn(charge, calls);
    const size = JSON.stringify(value ?? null)?.length ?? 0;
    if (size > MOST) {
      throw new Error(
        `Step ${JSON.stringify(name)} returned ${size} characters, and a step's result has to fit in the run ` +
          `record. Return what the next step needs rather than everything it read.`,
      );
    }
    ctx.lines.push({
      seq: ctx.seq,
      name,
      kind,
      at: new Date().toISOString(),
      ms: Date.now() - began,
      cost: spent,
      result: value,
      note,
      prompt,
      calls: calls.length > 0 ? calls : undefined,
    });
    ctx.seq++;
    save(ctx);
    return value;
  } catch (error) {
    // Waiting on a person is not finishing: the step is written down when it does.
    if (error instanceof Waiting) throw error;
    // A step that failed is still a step that happened. What it spent and what
    // it called are written down before the run gives up, because that is what
    // somebody reading the failure needs.
    ctx.lines.push({
      seq: ctx.seq,
      name,
      kind,
      at: new Date().toISOString(),
      ms: Date.now() - began,
      cost: spent,
      calls: calls.length > 0 ? calls : undefined,
      failed: error instanceof Error ? error.message : String(error),
    });
    ctx.seq++;
    throw error;
  } finally {
    ctx.inside = outer;
  }
}

/** One question, one shape, and the run priced for it. */
function modelStep<O extends Shape>(ctx: Ctx, name: string, options: ModelStep<O>): Promise<Answer<O>> {
  return once(ctx, name, "model", async (charge) => {
    const using = options.model ? nameOf(options.model) : modelFor(ctx.agent, ctx.job);
    const output = outputOf(options.output);
    const shape = await shapeOf(output);
    if (!shape) {
      throw new Error(
        `model(${JSON.stringify(name)}) was given ${output.name} output. A model step answers in a shape, ` +
          `a zod schema or an AI SDK output, because free text cannot steer the next step.`,
      );
    }

    // The shape goes in the words rather than in a provider flag, so this
    // works the same on every model the gateway can reach.
    const messages: Message[] = [
      {
        role: "system",
        content:
          (options.instructions ? `${options.instructions}\n\n` : "") +
          "Answer with JSON and nothing else: no explanation, no code fence. " +
          `It has to fit this shape exactly:\n${JSON.stringify(shape)}`,
      },
      { role: "user", content: options.prompt },
    ];

    let complaint = "";
    // Twice: a model told exactly what did not fit usually fixes it, and a
    // third go has never been the difference.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await askModel({ model: using, messages, signal: ctx.signal });
      // Charged whether or not it came back usable, which is why this is not
      // left until the end.
      charge(answer.cost);
      ctx.model = using;
      const checked = await parsed(output, answer.text);
      if (checked.ok) return { value: checked.value as Answer<O>, note: using, prompt: options.prompt };
      complaint = checked.why;
      messages.push({ role: "assistant", content: answer.text });
      messages.push({ role: "user", content: `That did not fit: ${complaint}. Answer again, JSON only.` });
    }
    throw new Error(`The model step ${JSON.stringify(name)} did not answer in the shape asked for: ${complaint}`);
  });
}

/** What stops an agent step when it says nothing: ten steps that ran tools. */
const AGENT_STOP_WHEN = isStepCount(10);

/**
 * The most autonomy a job can hand over, and the least of it that works is the
 * right amount. The model chooses the order and this runs what it asks for, so
 * the job keeps the limits: the tools are what it may do at all, `toolApproval` is
 * which of those calls may run, and `stopWhen` and `budget` are how far it may
 * go before it has to stop.
 *
 * Every tool it ran is written into the run's line, and the whole step is
 * recorded once, so a run that resumes does not live through it twice.
 */
function agentStep<O extends Shape>(ctx: Ctx, name: string, options: AgentStep<O>): Promise<unknown> {
  return once<unknown>(ctx, name, "agent", async (charge, calls) => {
    const using = options.model ? nameOf(options.model) : modelFor(ctx.agent, ctx.job);
    const tools = options.tools;
    for (const [id, one] of Object.entries(tools)) {
      const wrong = cannotRun(id, one);
      if (wrong) throw new Error(`agent(${JSON.stringify(name)}): ${wrong}`);
      if ((one as ChloeTool).changesAgent) {
        throw new Error(`agent(${JSON.stringify(name)}) was given ${id}, which changes the agent. Only its owner asking in a chat may do that, never a job.`);
      }
    }
    if (Object.keys(tools).length === 0) {
      throw new Error(
        `agent(${JSON.stringify(name)}) was given no tools. An agent step with nothing to call is a model step: use model(...).`,
      );
    }
    // A budget that is not a number of dollars would let every check below it
    // pass without stopping anything, which is the opposite of asking for one.
    if (options.budget !== undefined && !(options.budget > 0)) {
      throw new Error(
        `agent(${JSON.stringify(name)}) was given a budget of ${JSON.stringify(options.budget)}. ` +
          `A budget is an amount of dollars above zero, or leave it out.`,
      );
    }

    const output = options.output ? outputOf(options.output) : undefined;
    const shape = output ? await shapeOf(output) : undefined;
    const waited = ctx.parked?.seq === ctx.seq ? ctx.parked : undefined;
    const carried = waited?.agent;
    if (waited && (!carried || waited.name !== name)) {
      throw new Changed(
        `This job changed while the run was waiting: step ${ctx.seq} was ${JSON.stringify(waited.name)} ` +
          `and is now ${JSON.stringify(name)}. Start it again rather than carrying on from the middle.`,
      );
    }
    const messages: Message[] = carried?.messages ?? [
      {
        role: "system",
        content: [
          options.instructions,
          await overviewsOf(tools),
          "You have a goal and some tools. Work out the order yourself: call a tool, read what comes back, " +
            "decide what to do next, and stop when the goal is met. Call nothing you were not given.",
          shape
            ? `When you are done, answer with JSON and nothing else, no explanation and no code fence. It has to fit this shape exactly:\n${JSON.stringify(shape)}`
            : "When you are done, say what you found in a few plain sentences.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      { role: "user", content: options.prompt },
    ];

    const said = options.stopWhen ?? AGENT_STOP_WHEN;
    const stopWhen = Array.isArray(said) ? said : [said];
    let spent = carried?.spent ?? 0;
    let complaint = carried?.complaint ?? "";
    // A call that waited for a person, and what they said, when this is the run carrying on.
    let resume: { calls: ToolCall[]; decided: Decided } | undefined;
    let before = carried?.steps ?? 0;
    if (waited && carried) {
      const decided = await decision(ctx, waited);
      resume = { calls: carried.calls, decided };
      ctx.parked = undefined;
    }

    const tooDear = (): Error =>
      new Error(
        `The agent step ${JSON.stringify(name)} spent ${money(spent)} of its ${money(options.budget ?? 0)} budget ` +
          `without finishing. Raise budget, narrow the prompt, or do the parts you already know as step calls.`,
      );
    const wrongShape = (): Error =>
      new Error(`The agent step ${JSON.stringify(name)} did not answer in the shape asked for: ${complaint}`);

    // Twice, and only over the shape: a model told exactly what did not fit
    // usually fixes it, and the tools it already ran are not run again.
    for (let attempt = carried?.attempt ?? 0; attempt < 2; attempt++) {
      if (options.budget !== undefined && spent >= options.budget) throw tooDear();
      const done = await loop({
        model: using,
        messages,
        tools,
        context: { agent: ctx.agent },
        stopWhen: attempt === 0 ? stopWhen : [isStepCount(1)],
        before,
        budget: options.budget === undefined ? undefined : options.budget - spent,
        toolApproval: options.toolApproval,
        // Somebody to ask is the run's owner, as for `ask`. With nobody, a call
        // that needs a person is refused.
        canAsk: Boolean(ctx.owner),
        resume,
        signal: ctx.signal,
        // Each turn and each call as it happens, rather than at the end, so a
        // step that fails half way through still says what it spent and ran.
        onStep: (line) => {
          if (line.cost) spent = charge(line.cost);
          if (line.tool) calls.push({ toolName: line.tool, input: line.args, output: line.result, ...(line.refused && { refused: true }) });
        },
      });
      ctx.model = using;
      resume = undefined;

      if (done.stopped === "person" && done.waiting) {
        await waitFor(ctx, name, done.waiting, { messages, calls: done.waiting.calls, steps: before + done.steps, spent, record: [...calls], attempt, complaint });
      }
      before = 0;
      if (done.stopped === "budget") throw tooDear();
      // A job has nobody to send a link to, so it ends saying what is needed.
      if (done.stopped === "sign-in") throw new Error(done.text);
      if (done.stopped === "steps") {
        if (attempt === 1) throw wrongShape();
        throw new Error(
          `The agent step ${JSON.stringify(name)} was stopped by its stopWhen after ${done.steps} steps without finishing. ` +
            `Loosen stopWhen, narrow the prompt, or do the parts you already know as step calls.`,
        );
      }

      if (!shape) return { value: done.text, note: using, prompt: options.prompt };

      const checked = await parsed(output!, done.text);
      if (checked.ok) return { value: checked.value, note: using, prompt: options.prompt };
      complaint = checked.why;
      if (attempt === 1) throw wrongShape();
      messages.push({ role: "assistant", content: done.text });
      messages.push({ role: "user", content: `That did not fit: ${complaint}. Answer again, JSON only.` });
    }
    throw new Error(`The agent step ${JSON.stringify(name)} did not finish.`);
  });
}

/**
 * Park an agent step on a call somebody has to approve: write down where the
 * loop was, send the run's owner the call to say yes or no to, and stop.
 */
async function waitFor(ctx: Ctx, name: string, waiting: { calls: ToolCall[]; reason: string; input: unknown }, agent: AgentWait): Promise<never> {
  const tool = waiting.calls[0].function.name;
  const input = JSON.stringify(waiting.input, null, 2);
  const question =
    `${ctx.agent.label ?? ctx.agent.id} wants to use ${tool} in ${JSON.stringify(name)}` +
    `${waiting.reason ? `, which needs a yes: ${waiting.reason}` : ""}.\n` +
    `${input.length > 1500 ? `${input.slice(0, 1500)}…` : input}\nShould it go ahead?`;
  ctx.parked = {
    seq: ctx.seq,
    name,
    who: ctx.owner,
    question,
    asked: new Date().toISOString(),
    expires: new Date(Date.now() + minutes(WAIT) * 60_000).toISOString(),
    agent,
  };
  save(ctx);
  await deliver(ctx.owner, `${question}\n${hint(z.boolean())}`, ctx.agent.id, choices(z.boolean()));
  throw new Waiting(`waiting on ${ctx.owner}`);
}

/**
 * What the person said about the call an agent step waited on: yes, no, or
 * nothing in time. An answer that is not a yes or a no is asked again, three
 * times, and then counts as a no.
 */
async function decision(ctx: Ctx, waited: Parked): Promise<Decided> {
  if (waited.late) return "late";
  if (waited.reply === undefined) throw new Waiting(`waiting on ${waited.who}`);
  const understood = understand(waited.reply, z.boolean());
  if (understood.ok) return understood.value ? "yes" : "no";
  const confusions = (waited.confusions ?? 0) + 1;
  if (confusions > 3) return "no";
  ctx.parked = { ...waited, reply: undefined, confusions };
  save(ctx);
  await deliver(waited.who, `I did not understand that. ${waited.question}\n${hint(z.boolean())}`, ctx.agent.id, choices(z.boolean()));
  throw new Waiting(`waiting on ${waited.who}`);
}

/**
 * Stop and wait for a person.
 *
 * Parking writes down where the job is and what it asked, so the process can
 * restart while it waits. The answer arrives through whichever channel the
 * address names, and the job then runs again from the top with every finished
 * step handing back what it returned.
 */
async function askStep<S extends z.ZodType>(ctx: Ctx, name: string, options: AskStep<S>): Promise<z.infer<S>> {
  if (ctx.inside) {
    throw new Error(
      `ask(${JSON.stringify(name)}) was called inside the step ${JSON.stringify(ctx.inside)}. A job pauses between ` +
        `steps and not inside one, so this would park where that step belongs and run it again on the way back. ` +
        `Ask before the step and hand the answer in.`,
    );
  }
  const seen = ctx.lines[ctx.seq];
  if (seen) {
    if (seen.name !== name || seen.kind !== "ask") {
      throw new Changed(
        `This job changed while the run was waiting: step ${ctx.seq} was ${JSON.stringify(seen.name)} ` +
          `and is now ${JSON.stringify(name)}. Start it again rather than carrying on from the middle.`,
      );
    }
    ctx.seq++;
    return seen.result as z.infer<S>;
  }

  const who = options.who ?? ctx.owner;
  if (!who) {
    throw new Error(
      `ask(${JSON.stringify(name)}) has nobody to ask. Give the agent a channel with a chat in it, or pass who.`,
    );
  }

  const waiting = ctx.parked?.seq === ctx.seq ? ctx.parked : undefined;

  if (waiting?.late) {
    if ("otherwise" in options) return settle(ctx, name, options.otherwise as z.infer<S>, `${who} did not answer in time`, options.question);
    throw new Unanswered(`Nobody answered ${JSON.stringify(options.question)} within ${options.within ?? WAIT}.`);
  }

  if (waiting?.reply !== undefined) {
    const understood = understand(waiting.reply, options.answer);
    if (understood.ok) return settle(ctx, name, understood.value as z.infer<S>, `${who} answered`, options.question, waiting.reply);

    // Not understood: ask again rather than guessing, and give up rather than
    // going round forever.
    const confusions = (waiting.confusions ?? 0) + 1;
    if (confusions > 3) {
      throw new Unanswered(`${who} answered ${JSON.stringify(options.question)} three times and none of it fitted.`);
    }
    ctx.parked = { ...waiting, reply: undefined, confusions };
    save(ctx);
    await deliver(who, `I did not understand that. ${options.question}\n${hint(options.answer)}`, ctx.agent.id, choices(options.answer));
    throw new Waiting(`waiting on ${who}`);
  }

  ctx.parked = {
    seq: ctx.seq,
    name,
    who,
    question: options.question,
    asked: new Date().toISOString(),
    expires: new Date(Date.now() + minutes(options.within ?? WAIT) * 60_000).toISOString(),
  };
  save(ctx);
  await deliver(who, `${options.question}\n${hint(options.answer)}`, ctx.agent.id, choices(options.answer));
  throw new Waiting(`waiting on ${who}`);
}

/** Write the answer down as the ask's result and carry on past it. */
function settle<T>(ctx: Ctx, name: string, value: T, note: string, question: string, reply?: string): T {
  ctx.lines.push({
    seq: ctx.seq,
    name,
    kind: "ask",
    at: new Date().toISOString(),
    ms: 0,
    cost: 0,
    result: value,
    note,
    question,
    reply,
  });
  ctx.seq++;
  ctx.parked = undefined;
  save(ctx);
  return value;
}

/**
 * What a person typed, in the shape the job asked for.
 *
 * A person answers a yes or no question with "yes", not with `true`, so the
 * plain ways of saying it are tried before the schema sees anything.
 */
function understand(text: string, schema: z.ZodType): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const low = trimmed.toLowerCase();
  const tries: unknown[] = [];

  if (["yes", "y", "yep", "ok", "okay", "sure", "go", "go ahead", "do it", "true"].includes(low)) tries.push(true);
  if (["no", "n", "nope", "stop", "dont", "don't", "no thanks", "false"].includes(low)) tries.push(false);
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) tries.push(Number(trimmed));
  try {
    tries.push(JSON.parse(trimmed));
  } catch {
    // Not JSON, which is the normal case for a person.
  }
  tries.push(trimmed);

  for (const one of tries) {
    const checked = schema.safeParse(one);
    if (checked.success) return { ok: true, value: checked.data };
  }
  return { ok: false };
}

/** One line telling the person what kind of answer fits. */
function hint(schema: z.ZodType): string {
  const shape = schemaOf(schema) as { type?: string; enum?: unknown[] };
  if (shape.enum) return `(${shape.enum.join(", ")})`;
  if (shape.type === "boolean") return "(yes or no)";
  if (shape.type === "number" || shape.type === "integer") return "(a number)";
  if (shape.type === "string") return "";
  return `(as JSON: ${JSON.stringify(shape)})`;
}

/** The answers that fit, when they can be listed. Each one is understood back by understand(). */
function choices(schema: z.ZodType): string[] | undefined {
  const shape = schemaOf(schema) as { type?: string; enum?: unknown[] };
  if (shape.enum && shape.enum.length <= 8) return shape.enum.map(String);
  if (shape.type === "boolean") return ["yes", "no"];
  return undefined;
}

/** A shape as an AI SDK output: a zod schema is `Output.object` of it. */
function outputOf(shape: Shape): Output {
  return typeof (shape as Output).parseCompleteOutput === "function" ? (shape as Output) : Outputs.object({ schema: shape as z.ZodType });
}

/** The JSON schema an AI SDK output asks for, or nothing when it asks for text. */
async function shapeOf(output: Output): Promise<Record<string, unknown> | undefined> {
  const format = await output.responseFormat;
  if (format?.type !== "json" || !format.schema) return undefined;
  const { $schema: _, ...shape } = format.schema as Record<string, unknown>;
  return shape;
}

/**
 * A model's answer read by the AI SDK output it was asked for, or what did not
 * fit, in words the model is told on its second go.
 */
async function parsed(output: Output, text: string): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
  const inside = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const context = { response: { id: "", timestamp: new Date(), modelId: "" }, usage: {} as never, finishReason: "stop" as const };
  try {
    return { ok: true, value: await output.parseCompleteOutput({ text: inside }, context) };
  } catch (error) {
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
      const issues = (cause as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (Array.isArray(issues)) return { ok: false, why: issues.map((i) => `${i.path.join(".") || "the answer"} ${i.message}`).join("; ") };
      if ((cause as Error).name === "AI_JSONParseError") return { ok: false, why: "the answer was not JSON" };
    }
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/** A zod schema as JSON schema, for the answers a person can give to `ask`. */
function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const shape = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete shape.$schema;
  return shape;
}

function minutes(within: string): number {
  const match = within.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) throw new Error(`${JSON.stringify(within)} is not a length of time. Write it as "30m", "4h" or "2d".`);
  const size = Number(match[1]);
  return match[2].toLowerCase() === "m" ? size : match[2].toLowerCase() === "h" ? size * 60 : size * 1440;
}

function starting(job: Job): Data {
  if (!job.state) return {};
  const empty = job.state.safeParse({});
  return empty.success ? (empty.data as Data) : {};
}

/** A run that is waiting for a person's answer: what it asked, who it asked, and when the wait ends. */
export interface ParkedRun {
  /** The id of the run. */
  id: string;
  /** The id of the agent. */
  agent: string;
  /** The id of the job. */
  job: string;
  /** The address the question went to, like "telegram:12345". */
  who: string;
  /** The question that was sent. */
  question: string;
  /** When the question was sent, as an ISO date string. */
  asked: string;
  /** When the wait ends, as an ISO date string. After that, `sweep()` stops waiting and continues the run. */
  expires: string;
}

/** Returns every run that is waiting for a person right now. */
export function parkedRuns(): ParkedRun[] {
  const rows = db.prepare("select id, agent, job, parked from runs where parked is not null").all() as {
    id: string;
    agent: string;
    job: string;
    parked: string;
  }[];
  return rows.map((row) => {
    const parked = JSON.parse(row.parked) as Parked;
    return {
      id: row.id,
      agent: row.agent,
      job: row.job,
      who: parked.who,
      question: parked.question,
      asked: parked.asked,
      expires: parked.expires,
    };
  });
}

/**
 * Returns the oldest question sent to this address that has no answer yet, or
 * `undefined` when there is none. `who` is an address like "telegram:12345".
 * Give `agent` (an agent id) to look only at that agent's questions.
 */
export function waitingOn(who: string, agent = ""): ParkedRun | undefined {
  return parkedRuns()
    .filter((one) => one.who === who && (!agent || one.agent === agent))
    .sort((a, b) => a.asked.localeCompare(b.asked))[0];
}

/**
 * Returns `true` when this agent's job has a run waiting for a person. The
 * clock does not start such a job on its schedule until the wait ends.
 * `agent` and `job` are ids.
 */
export function waitingFor(agent: string, job: string): boolean {
  const row = db
    .prepare("select 1 from runs where agent = ? and job = ? and parked is not null limit 1")
    .get(agent, job);
  return row !== undefined;
}

/**
 * Gives a person's reply to the run that is waiting for it, and continues the
 * run. Returns the run's result: finished, or paused again (for example
 * when the reply did not fit and the question was sent again).
 *
 * `agents` is every loaded agent by id, as `loadAll()` returns them. Throws
 * when the run is not waiting for an answer.
 */
export async function answer(runId: string, reply: string, agents: Map<string, Agent>): Promise<Result> {
  const row = db.prepare("select parked from runs where id = ?").get(runId) as { parked?: string } | undefined;
  if (!row?.parked) throw new Error(`Run ${JSON.stringify(runId)} is not waiting for an answer.`);
  const parked = { ...(JSON.parse(row.parked) as Parked), reply };
  db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), runId);
  return resume(runId, agents);
}

/**
 * Stops waiting for every question whose time to answer has passed, and
 * continues each of those runs:
 * - an `ask` with `otherwise` goes on with that value;
 * - an `ask` without it ends the run with an error;
 * - a tool call waiting for a yes does not run, and the model is told.
 *
 * The clock calls this every minute. A waiting run keeps its job from
 * starting again, so this is what lets the job run again.
 */
export async function sweep(agents: Map<string, Agent>): Promise<void> {
  const now = new Date().toISOString();
  for (const one of parkedRuns()) {
    if (one.expires > now) continue;
    const row = db.prepare("select parked from runs where id = ?").get(one.id) as { parked?: string } | undefined;
    if (!row?.parked) continue;
    const parked = { ...(JSON.parse(row.parked) as Parked), late: true };
    db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), one.id);
    await resume(one.id, agents).catch((error: unknown) => {
      console.error(`${one.agent}/${one.job}: giving up on an unanswered question failed`, error);
    });
  }
}

interface Row {
  agent: string;
  job: string;
  model: string;
  cost: number;
  trace: string;
  state?: string;
  args?: string;
  input?: string;
  parked?: string;
  owner?: string;
}

function save(ctx: Ctx): void {
  db.prepare("update runs set steps = ?, cost = ?, trace = ?, state = ?, parked = ?, model = ? where id = ?").run(
    ctx.lines.length,
    ctx.cost,
    JSON.stringify(ctx.lines),
    JSON.stringify(ctx.state),
    ctx.parked ? JSON.stringify(ctx.parked) : null,
    ctx.model,
    ctx.runId,
  );
}

function finish(ctx: Ctx, reply: string, summary: string | null): void {
  save(ctx);
  db.prepare("update runs set finished = ?, reply = ?, summary = ? where id = ?")
    .run(new Date().toISOString(), reply, summary, ctx.runId);
  runChanged(ctx.runId);
}

/**
 * What the job's `response` made of what `run` returned, or the string it returned.
 * A `response` that throws costs the run its words and nothing else: the work is
 * already done, so the overview shows why and the chat gets the summary.
 */
function said(job: Job, value: unknown): { words?: string; summary: string | null } {
  try {
    const words = job.response?.(value) || (typeof value === "string" ? value : undefined);
    return { words, summary: words === undefined ? null : oneLineSummary(words) };
  } catch (error) {
    return { summary: `(its response failed: ${error instanceof Error ? error.message : String(error)})` };
  }
}

function fail(ctx: Ctx, why: string): void {
  save(ctx);
  db.prepare("update runs set finished = ?, error = ? where id = ?").run(new Date().toISOString(), why, ctx.runId);
  runChanged(ctx.runId);
}
