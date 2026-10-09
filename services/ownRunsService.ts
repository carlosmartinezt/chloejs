// An agent's own runs, as the agent itself may read them: which jobs ran and
// when, what each cost, and for one run what it was asked, what it answered
// and every step or tool call on the way. Only its own, never an eval's.
import { db } from "#chloe/core/db";

/** How much of one step's result, one call's arguments or a reply is shown. */
const CLIPPED = 1500;

/** The most steps one run shows, from the start. */
const MOST_STEPS = 60;

interface Row {
  id: string;
  job: string | null;
  source: string;
  kind: string;
  started: string;
  finished: string | null;
  model: string;
  prompt: string;
  asked: string | null;
  reply: string | null;
  error: string | null;
  summary: string | null;
  steps: number;
  cost: number;
  trace: string;
  parked: string | null;
}

function clip(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > CLIPPED ? `${text.slice(0, CLIPPED)}...[${text.length} characters]` : value;
}

/**
 * The agent's runs, newest first: the facts of each and none of its words, so
 * nothing in the list came from outside. `job` keeps to one job, "chat" to
 * conversations.
 */
export function listOwnRuns(agent: string, options: { job?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const where = options.job === "chat" ? "and job is null" : options.job ? "and job = ?" : "";
  const rows = db
    .prepare(
      `select id, job, source, started, finished, cost, steps, error is not null as failed, parked is not null as waiting
       from runs where agent = ? and source != 'eval' ${where} order by started desc limit ?`,
    )
    .all(...[agent, ...(options.job && options.job !== "chat" ? [options.job] : []), limit]) as Record<string, unknown>[];
  return {
    runs: rows.map((one) => ({
      id: one.id,
      job: one.job ?? "chat",
      source: one.source,
      started: one.started,
      finished: one.finished,
      cost: one.cost,
      steps: one.steps,
      ...(one.failed ? { failed: true } : {}),
      ...(one.waiting ? { waiting: true } : {}),
    })),
  };
}

/**
 * One of the agent's runs in full: what started it, what it answered or why
 * it failed, and its steps in order, each cut to a length a model can read.
 */
export function readOwnRun(agent: string, id: string) {
  const row = db.prepare("select * from runs where id = ? and agent = ? and source != 'eval'").get(id.trim(), agent) as Row | undefined;
  if (!row) throw new Error(`You have no run ${JSON.stringify(id)}. selfListRuns lists them.`);
  const trace = JSON.parse(row.trace || "[]") as Record<string, unknown>[];
  const steps = (row.kind === "job" ? trace.map(jobStep) : trace.map(turnStep)).filter((one) => one !== undefined);
  return {
    id: row.id,
    job: row.job ?? "chat",
    source: row.source,
    started: row.started,
    finished: row.finished,
    model: row.model,
    cost: row.cost,
    // A job's prompt is its own words, which selfReadFile shows; a conversation's is what was said.
    ...(row.job ? {} : { asked: clip(row.asked ?? row.prompt) }),
    ...(row.reply ? { reply: clip(row.reply) } : {}),
    ...(row.summary && row.summary !== row.reply ? { summary: row.summary } : {}),
    ...(row.error ? { error: clip(row.error) } : {}),
    ...(row.parked ? { waiting: true } : {}),
    steps: steps.slice(0, MOST_STEPS),
    ...(steps.length > MOST_STEPS ? { stepsLeftOut: steps.length - MOST_STEPS } : {}),
  };
}

/** A line of a job's record: a step, a model step, a question to a person or an agent step. */
function jobStep(line: Record<string, unknown>) {
  const calls = line.calls as { toolName: string; input: unknown; output: unknown; refused?: boolean }[] | undefined;
  return {
    step: line.name,
    kind: line.kind,
    ms: line.ms,
    ...(line.cost ? { cost: line.cost } : {}),
    ...(line.question ? { question: line.question } : {}),
    ...(line.reply ? { answered: clip(line.reply) } : {}),
    ...(line.result !== undefined ? { result: clip(line.result) } : {}),
    ...(calls?.length ? { calls: calls.map((one) => ({ tool: one.toolName, args: clip(one.input), result: clip(one.output), ...(one.refused && { refused: true }) })) } : {}),
    ...(line.failed ? { failed: line.failed } : {}),
  };
}

/** A line of a conversation's record: what the model said, or one tool it called. */
function turnStep(line: Record<string, unknown>) {
  if (line.tool) {
    return { tool: line.tool, args: clip(line.args), result: clip(line.result), ...(line.failed ? { failed: true } : {}), ...(line.refused ? { refused: true } : {}) };
  }
  if (line.carried) return { note: line.carried };
  // What it said with no call after it is the reply, shown once as `reply`.
  const said = typeof line.say === "string" && (line.wants as unknown[] | undefined)?.length ? line.say.trim() : "";
  return said ? { said: clip(said) } : undefined;
}
