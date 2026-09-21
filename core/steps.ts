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

import { z } from "zod";

import { deliver, owner as whoOwns } from "#chloe/model/ask.ts";
import { db } from "#chloe/core/db.ts";
import { oneLineSummary } from "#chloe/core/markdown.ts";
import type { Agent, Job } from "#chloe/load/load.ts";
import { ask as askModel, type Message } from "#chloe/model/model.ts";
import { loop, money } from "#chloe/core/turn.ts";
import type { Approve, Call, Tool, Tools } from "#chloe/model/tool.ts";

/** One finished step, and the record that lets it not run twice. */
export interface Line {
  /** Its place in the order the job called things. This is the replay key. */
  seq: number;
  name: string;
  kind: "step" | "model" | "ask" | "agent";
  at: string;
  ms: number;
  cost: number;
  result?: unknown;
  /** For an ask: who was asked, and what they were asked. */
  note?: string;
  /** For a model step: what it was asked. */
  prompt?: string;
  /** For an ask: the question, and what the person typed before it was understood. */
  question?: string;
  reply?: string;
  /** For an agent step: every tool it ran, in the order it ran them, and the ones it was not allowed to. */
  calls?: Call[];
  /** Why this step did not finish. The run usually stops here, unless the job caught it. */
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
}

/**
 * One question for a model, inside a workflow that stays code: you know what to
 * ask, and the answer has to come back in the shape you asked for.
 */
export interface ModelStep<S extends z.ZodType> {
  prompt: string;
  /** The shape the answer has to be in. Free text cannot steer the next step. */
  output: S;
  /** When this one step wants a model the rest of the job does not. */
  model?: string;
  system?: string;
}

/**
 * Bounded autonomy. You give the goal and the tools, the model works out the
 * order. Reach for this only when the order cannot be known in advance: when
 * you know the steps, they are `step` calls, and when you know the question, it
 * is one `model` call.
 */
export interface AgentStep<S extends z.ZodType = z.ZodType> {
  /** What you want done, not how to do it. */
  goal: string;
  /** Everything it may do. Nothing outside this list is reachable from inside. */
  tools: Tool[] | Tools;
  /** The shape the final answer has to be in. Without one, you get its words. */
  output?: S;
  /** Most turns of the loop before it has to stop. Ten by default. */
  maxSteps?: number;
  /**
   * What it may spend, in dollars, before it has to stop. Checked between
   * turns, so the turn that crosses the line is paid for and nothing after it
   * is: size it as the point where you want the step to give up, not as a
   * ceiling it cannot pass. Without one, `maxSteps` is the only limit, and ten
   * turns of a large model is not a small number. Going over is an error, like
   * running out of steps.
   */
  budget?: number;
  /**
   * Asked before each tool runs, with the arguments the model chose. The tools
   * say what it may do at all; this says which particular calls are allowed.
   * It decides now, in code: to have a person decide, ask them with `ask`
   * before the step and let this read the answer.
   */
  approve?: Approve;
  /** When this step wants a model the rest of the job does not. */
  model?: string;
  /** What it should know before it starts. */
  system?: string;
}

/**
 * A question for a person. The run parks, the question goes out to an address,
 * and what they type is matched against the shape rather than read by a model.
 */
export interface AskStep<S extends z.ZodType> {
  question: string;
  /** The shape the person's answer has to be in. */
  answer: S;
  /** An address, "channel:who". Defaults to the run's owner. */
  who?: string;
  /** How long to wait: "30m", "4h", "2d". Two hours by default. */
  within?: string;
  /** What to carry on with when nobody answers. Without one, the job stops. */
  otherwise?: z.infer<S>;
}

/** What a job's `run` is handed. */
export interface Work<State = Record<string, unknown>, Input = Record<string, unknown>> {
  /** Do something, once, and write down what it returned. */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /** Ask a model one question and get an answer in the shape you asked for. */
  model<S extends z.ZodType>(name: string, options: ModelStep<S>): Promise<z.infer<S>>;
  /** Hand a goal and some tools to a model and let it pick the order. The most autonomy, so the last resort. */
  agent<S extends z.ZodType>(name: string, options: AgentStep<S> & { output: S }): Promise<z.infer<S>>;
  agent(name: string, options: Omit<AgentStep, "output">): Promise<string>;
  /** Stop and wait for a person. The process may restart while it waits. */
  ask<S extends z.ZodType>(name: string, options: AskStep<S>): Promise<z.infer<S>>;
  /** The shared store. Survives a pause. */
  readonly state: State;
  setState(next: Partial<State>): Promise<void>;
  /**
   * What this run was started with, already checked against the job's `input`
   * shape. Empty for a run the clock started. It does not change, so there is
   * nothing to set: the store above is the part that moves.
   */
  readonly input: Input;
  readonly owner: string;
  /** Whose job this is. Notes, scripts and folders are filed under it. */
  readonly agentName: string;
  /**
   * Where that agent remembers things: its memory folder. A job that files
   * something there reads the path from here rather than writing it down again,
   * so the agent's definition is the one place that says where.
   */
  readonly memory: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

/** What a run of a job came back with, whether it finished or parked. */
export interface Result {
  runId: string;
  text: string;
  steps: number;
  cost: number;
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
  state: Record<string, unknown>;
  /** What the run was started with. Checked once, then never changed. */
  input: Record<string, unknown>;
  parked?: Parked;
  owner: string;
  /** "code" until a model step runs, then whichever model it used. */
  model: string;
  /** The step running right now, while one is. A job pauses between steps, not inside one. */
  inside?: string;
  signal?: AbortSignal;
}

/** Start a job from the beginning. */
export async function work(options: {
  agent: Agent;
  job: Job;
  /** The channel it came in on, like "telegram" or "api". Left out, it is "unknown". */
  source?: string;
  /** What to start it with. Checked against the job's `input` shape first. */
  input?: unknown;
  signal?: AbortSignal;
}): Promise<Result> {
  const { agent, job } = options;
  if (!job.run) throw new Error(`${agent.name}/${job.id} is a prompt, not code.`);

  // Before the run exists, so a caller that sent the wrong thing is told so
  // rather than left reading a failed run to find out.
  const input = checkInput(job, options.input);

  const runId = randomUUID();
  const owner = whoOwns(agent.name);
  const state = starting(job);
  db.prepare(
    `insert into runs (id, agent, started, source, job, model, prompt, kind, owner, state, input)
     values (?, ?, ?, ?, ?, 'code', '', 'job', ?, ?, ?)`,
  ).run(
    runId,
    agent.name,
    new Date().toISOString(),
    options.source ?? "unknown",
    job.id,
    owner || null,
    JSON.stringify(state),
    JSON.stringify(input),
  );

  return drive({
    runId,
    agent,
    job,
    lines: [],
    seq: 0,
    cost: 0,
    state,
    input,
    owner,
    model: "code",
    signal: options.signal,
  });
}

/** What was sent to start a job does not fit the shape that job declares. */
export class WrongInput extends Error {}

/**
 * Checks what a job is being started with against its `input` shape, and hands
 * back the parsed values. Throws `WrongInput` when they do not fit.
 *
 * A job that declares no shape takes nothing, so sending it something is a
 * mistake worth saying out loud rather than quietly dropping. A job that does
 * declare one and is started by the clock gets `{}` put through the same
 * check, which is what makes a required field and a cron line an error at the
 * first tick rather than a puzzle later.
 *
 * Called before a run exists, so whoever started it is told rather than left
 * reading a failed run to find out.
 */
export function checkInput(job: Job, sent: unknown): Record<string, unknown> {
  if (!job.input) {
    const keys = sent && typeof sent === "object" ? Object.keys(sent as object) : [];
    if (keys.length) {
      throw new WrongInput(
        `${job.agent}/${job.id} does not take anything, so it cannot be started with ${keys.join(", ")}. ` +
          "Give the job an `input` shape if it should.",
      );
    }
    return {};
  }
  const checked = job.input.safeParse(sent ?? {});
  if (!checked.success) throw new WrongInput(`${job.agent}/${job.id}: ${z.prettifyError(checked.error)}`);
  return checked.data as Record<string, unknown>;
}

/** Carry on a job that was waiting for a person. */
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
    input: (row.input ? JSON.parse(row.input) : {}) as Record<string, unknown>,
    lines: JSON.parse(row.trace) as Line[],
    seq: 0,
    cost: row.cost,
    state: row.state ? (JSON.parse(row.state) as Record<string, unknown>) : starting(job),
    parked: JSON.parse(row.parked) as Parked,
    owner: row.owner ?? whoOwns(agent.name),
    model: row.model,
    signal,
  });
}

async function drive(ctx: Ctx): Promise<Result> {
  const api: Work = {
    step: (name, fn) => once(ctx, name, "step", async () => ({ value: await fn() })),
    model: (name, options) => modelStep(ctx, name, options),
    agent: ((name: string, options: AgentStep<z.ZodType>) => agentStep(ctx, name, options)) as Work["agent"],
    ask: (name, options) => askStep(ctx, name, options),
    get state() {
      return ctx.state;
    },
    setState: async (next) => {
      ctx.state = { ...ctx.state, ...next };
      save(ctx);
    },
    input: ctx.input,
    owner: ctx.owner,
    agentName: ctx.agent.name,
    memory: ctx.agent.memory.folder,
    runId: ctx.runId,
    signal: ctx.signal,
  };

  try {
    const value = await ctx.job.run!(api);
    ctx.parked = undefined;
    const reply = typeof value === "string" ? value : JSON.stringify(value ?? { ok: true }, null, 2);
    finish(ctx, reply, summarise(ctx.job, value));
    return { runId: ctx.runId, text: reply, steps: ctx.lines.length, cost: ctx.cost, parked: false };
  } catch (error) {
    if (error instanceof Waiting) {
      save(ctx);
      return { runId: ctx.runId, text: error.message, steps: ctx.lines.length, cost: ctx.cost, parked: true };
    }
    ctx.parked = undefined;
    const why = error instanceof Error ? error.message : String(error);
    fail(ctx, why);
    if (error instanceof Unanswered || error instanceof Changed) {
      return { runId: ctx.runId, text: why, steps: ctx.lines.length, cost: ctx.cost, parked: false };
    }
    throw error;
  }
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
  let spent = 0;
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
  const calls: Call[] = [];
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
function modelStep<S extends z.ZodType>(ctx: Ctx, name: string, options: ModelStep<S>): Promise<z.infer<S>> {
  return once(ctx, name, "model", async (charge) => {
    const using = options.model ?? ctx.job.model ?? ctx.agent.model;
    const shape = shapeOf(options.output);

    // The shape goes in the words rather than in a provider flag, so this
    // works the same on every model the gateway can reach.
    const messages: Message[] = [
      {
        role: "system",
        content:
          (options.system ? `${options.system}\n\n` : "") +
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
      const checked = options.output.safeParse(unfence(answer.text));
      if (checked.success) return { value: checked.data as z.infer<S>, note: using, prompt: options.prompt };
      complaint = checked.error.issues.map((i) => `${i.path.join(".") || "the answer"} ${i.message}`).join("; ");
      messages.push({ role: "assistant", content: answer.text });
      messages.push({ role: "user", content: `That did not fit: ${complaint}. Answer again, JSON only.` });
    }
    throw new Error(`The model step ${JSON.stringify(name)} did not answer in the shape asked for: ${complaint}`);
  });
}

/** Ten turns of the loop, unless the step says otherwise. */
const AGENT_STEPS = 10;

/**
 * The most autonomy a job can hand over, and the least of it that works is the
 * right amount. The model chooses the order and this runs what it asks for, so
 * the job keeps the limits: the tools are what it may do at all, `approve` is
 * which of those calls may run, and `maxSteps` and `budget` are how far it may
 * go before it has to stop.
 *
 * Every tool it ran is written into the run's line, and the whole step is
 * recorded once, so a run that resumes does not live through it twice.
 */
function agentStep<S extends z.ZodType>(ctx: Ctx, name: string, options: AgentStep<S>): Promise<unknown> {
  return once<unknown>(ctx, name, "agent", async (charge, calls) => {
    const using = options.model ?? ctx.job.model ?? ctx.agent.model;
    const tools: Tools = Array.isArray(options.tools)
      ? Object.fromEntries(options.tools.map((one) => [one.id, one]))
      : options.tools;
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

    const shape = options.output ? shapeOf(options.output) : undefined;
    const messages: Message[] = [
      {
        role: "system",
        content: [
          options.system,
          "You have a goal and some tools. Work out the order yourself: call a tool, read what comes back, " +
            "decide what to do next, and stop when the goal is met. Call nothing you were not given.",
          shape
            ? `When you are done, answer with JSON and nothing else, no explanation and no code fence. It has to fit this shape exactly:\n${JSON.stringify(shape)}`
            : "When you are done, say what you found in a few plain sentences.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      { role: "user", content: options.goal },
    ];

    const maxSteps = options.maxSteps ?? AGENT_STEPS;
    let spent = 0;
    let complaint = "";

    const tooDear = (): Error =>
      new Error(
        `The agent step ${JSON.stringify(name)} spent ${money(spent)} of its ${money(options.budget ?? 0)} budget ` +
          `without finishing. Raise budget, narrow the goal, or do the parts you already know as step calls.`,
      );
    const wrongShape = (): Error =>
      new Error(`The agent step ${JSON.stringify(name)} did not answer in the shape asked for: ${complaint}`);

    // Twice, and only over the shape: a model told exactly what did not fit
    // usually fixes it, and the tools it already ran are not run again.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.budget !== undefined && spent >= options.budget) throw tooDear();
      const done = await loop({
        model: using,
        messages,
        tools,
        maxSteps: attempt === 0 ? maxSteps : 1,
        budget: options.budget === undefined ? undefined : options.budget - spent,
        approve: options.approve,
        signal: ctx.signal,
        // Each turn and each call as it happens, rather than at the end, so a
        // step that fails half way through still says what it spent and ran.
        onStep: (line) => {
          if (line.cost) spent = charge(line.cost);
          if (line.tool) calls.push({ tool: line.tool, args: line.args, result: line.result, ...(line.refused && { refused: true }) });
        },
      });
      ctx.model = using;

      if (done.stopped === "budget") throw tooDear();
      if (done.stopped === "steps") {
        if (attempt === 1) throw wrongShape();
        throw new Error(
          `The agent step ${JSON.stringify(name)} ran out of steps after ${maxSteps} without finishing. ` +
            `Raise maxSteps, narrow the goal, or do the parts you already know as step calls.`,
        );
      }

      if (!options.output) return { value: done.text, note: using, prompt: options.goal };

      const checked = options.output.safeParse(unfence(done.text));
      if (checked.success) return { value: checked.data as z.infer<S>, note: using, prompt: options.goal };
      complaint = checked.error.issues.map((i) => `${i.path.join(".") || "the answer"} ${i.message}`).join("; ");
      if (attempt === 1) throw wrongShape();
      messages.push({ role: "assistant", content: done.text });
      messages.push({ role: "user", content: `That did not fit: ${complaint}. Answer again, JSON only.` });
    }
    throw new Error(`The agent step ${JSON.stringify(name)} did not finish.`);
  });
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
    await deliver(who, `I did not understand that. ${options.question}\n${hint(options.answer)}`, ctx.agent.name, choices(options.answer));
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
  await deliver(who, `${options.question}\n${hint(options.answer)}`, ctx.agent.name, choices(options.answer));
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
  const shape = shapeOf(schema) as { type?: string; enum?: unknown[] };
  if (shape.enum) return `(${shape.enum.join(", ")})`;
  if (shape.type === "boolean") return "(yes or no)";
  if (shape.type === "number" || shape.type === "integer") return "(a number)";
  if (shape.type === "string") return "";
  return `(as JSON: ${JSON.stringify(shape)})`;
}

/** The answers that fit, when they can be listed. Each one is understood back by understand(). */
function choices(schema: z.ZodType): string[] | undefined {
  const shape = shapeOf(schema) as { type?: string; enum?: unknown[] };
  if (shape.enum && shape.enum.length <= 8) return shape.enum.map(String);
  if (shape.type === "boolean") return ["yes", "no"];
  return undefined;
}

function shapeOf(schema: z.ZodType): Record<string, unknown> {
  const shape = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete shape.$schema;
  return shape;
}

/** Whatever a model wrapped its JSON in. */
function unfence(text: string): unknown {
  const inside = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(inside);
  } catch {
    // A model that answered a string schema with a bare word still fits.
    return inside;
  }
}

function minutes(within: string): number {
  const match = within.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) throw new Error(`${JSON.stringify(within)} is not a length of time. Write it as "30m", "4h" or "2d".`);
  const size = Number(match[1]);
  return match[2].toLowerCase() === "m" ? size : match[2].toLowerCase() === "h" ? size * 60 : size * 1440;
}

function starting(job: Job): Record<string, unknown> {
  if (!job.state) return {};
  const empty = job.state.safeParse({});
  return empty.success ? (empty.data as Record<string, unknown>) : {};
}

/**
 * A run waiting on a person: what it asked, who it asked, and when the wait
 * runs out. Read by the page and by the sweep.
 */
export interface ParkedRun {
  id: string;
  agent: string;
  job: string;
  who: string;
  question: string;
  asked: string;
  expires: string;
}

/** Every run waiting on a person right now. */
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

/** The oldest question this person has not answered, if there is one. Only that agent's, when it says which. */
export function waitingOn(who: string, agent = ""): ParkedRun | undefined {
  return parkedRuns()
    .filter((one) => one.who === who && (!agent || one.agent === agent))
    .sort((a, b) => a.asked.localeCompare(b.asked))[0];
}

/** Is this job already waiting on somebody? Then it does not start again. */
export function waitingFor(agent: string, job: string): boolean {
  const row = db
    .prepare("select 1 from runs where agent = ? and job = ? and parked is not null limit 1")
    .get(agent, job);
  return row !== undefined;
}

/** Hand a person's answer to the run that was waiting for it. */
export async function answer(runId: string, reply: string, agents: Map<string, Agent>): Promise<Result> {
  const row = db.prepare("select parked from runs where id = ?").get(runId) as { parked?: string } | undefined;
  if (!row?.parked) throw new Error(`Run ${JSON.stringify(runId)} is not waiting for an answer.`);
  const parked = { ...(JSON.parse(row.parked) as Parked), reply };
  db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), runId);
  return resume(runId, agents);
}

/**
 * Give up on questions nobody answered. Called on the clock's tick.
 *
 * A parked run holds its job, so a question left alone is a job that
 * never runs again. This is what stops that.
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
}

/**
 * The job's own line, or the start of the string it returned. A summary that
 * throws costs the run its line and nothing else: the work is already done.
 */
function summarise(job: Job, value: unknown): string | null {
  try {
    if (job.summary) return oneLineSummary(job.summary(value));
  } catch (error) {
    return `(its summary failed: ${error instanceof Error ? error.message : String(error)})`;
  }
  return typeof value === "string" ? oneLineSummary(value) : null;
}

function fail(ctx: Ctx, why: string): void {
  save(ctx);
  db.prepare("update runs set finished = ?, error = ? where id = ?").run(new Date().toISOString(), why, ctx.runId);
}
