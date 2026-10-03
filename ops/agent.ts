#!/usr/bin/env node
// One agent, from the terminal. Run by a person, to find out what an agent
// actually knows and what its jobs actually do:
//
//   npm run agent <agent>               a conversation, until /exit
//   npm run agent <agent> "question"    one question, then out
//   npm run agent <agent> < draft.md    the same, piped
//   npm run agent <agent> <job>    run one of its jobs now, and
//                                       follow it step by step
//
// The last one is how a job is tried without waiting for its cron line. What
// it is depends on what it matches: anything that is the id of one
// of that agent's jobs runs that job, and everything else is a
// question. So `npm run agent cc check-sites` is a run and `npm run agent cc
// "is the disk full?"` is a question.
//
// It asks the chloe that is already running, over loopback, rather than
// loading a runtime of its own, so `npx chloe` has to be running somewhere. A
// second runtime would be a second writer on the database and a second clock
// firing the same cron lines, so the nightly backup could go twice.
//
// Every turn lands in the run history with its tool calls and its cost, the
// same as one from the page or a job.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { bold, dim } from "#chloe/core/style";
import { ownCookie } from "#chloe/serve/login";

// Matches HOST and PORT in serve/http.ts, which are deliberately not settable.
const BASE = "http://127.0.0.1:3067";

/** What one turn came back with. The same shape every channel gets. */
interface Result {
  runId?: string;
  text: string;
  steps: number;
  cost: number;
}

interface Listed {
  name: string;
  description?: string;
  model: string;
  tools: string[];
  skills: string[];
  jobs: ListedJob[];
}

interface ListedJob {
  id: string;
  description?: string;
  cron?: string;
  timezone: string;
  /** "code" for a job, or the model a prompt asks. */
  model: string;
  code: boolean;
}

/** One finished step of a job, as the run record keeps it. */
interface Step {
  seq: number;
  name: string;
  kind: "step" | "model" | "ask";
  ms: number;
  cost: number;
}

/** One line of a conversation's record: what the model said, or one tool it ran. */
interface Line {
  say?: string;
  /** What the model wrote as if its tools had answered. None of it ran. */
  dropped?: string;
  wants?: string[];
  cost?: number;
  tool?: string;
  args?: unknown;
  result?: unknown;
  failed?: boolean;
  refused?: boolean;
}

interface Run {
  id: string;
  agent: string;
  started: string;
  finished?: string | null;
  source?: string;
  job?: string | null;
  steps?: number;
  cost?: number;
  error?: string | null;
  reply?: string | null;
  parked?: string | null;
  /** A job's steps, or a prompt job's lines, which are a conversation's. */
  trace?: (Step | Line)[];
}

/** A conversation's run, whose trace is lines rather than steps. */
interface Turn {
  trace?: Line[];
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  // The API is behind the same login as the page. This signs itself in by
  // reading the account file, which is the same permission as running this.
  // The channel header is what makes the log say "terminal" rather than "api".
  const headers: Record<string, string> = { cookie: ownCookie(), "x-chloe-channel": "terminal" };
  const response = await fetch(
    `${BASE}${path}`,
    body === undefined
      ? { headers }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
  ).catch((error: unknown) => error as Error);

  if (response instanceof Error) {
    throw new Error(
      `Nothing is answering on ${BASE}.\n` +
        "This talks to a chloe that is already running rather than starting one of its own, " +
        "so leave it running in another terminal: npx chloe",
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The service answered ${response.status}: ${text.slice(0, 200)}`);
  }
  const value = parsed as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `The service answered ${response.status}.`);
  return parsed as T;
}

function show(result: Result): void {
  console.log(`\n${result.text.trim()}\n`);
  console.log(dim(`(${result.steps} step${result.steps === 1 ? "" : "s"}, $${result.cost.toFixed(4)})\n`));
}

/**
 * The tools one turn ran, read off the run it left behind rather than sent back
 * with the reply: a channel's answer is what to say, and this is only ever
 * wanted when somebody types /tools.
 */
async function toolsOf(runId: string): Promise<Line[]> {
  const run = await api<Turn>(`/api/runs/${encodeURIComponent(runId)}`);
  return (run.trace ?? []).filter((one) => one.tool);
}

const [named, ...rest] = process.argv.slice(2);

const agents = await api<Listed[]>("/api/agents").catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

// No name: ask, when there is somebody there to ask. Piped or in a script it
// says what the names are and stops, because a prompt nobody can answer is a
// command that hangs.
let name = named;
if (!name) {
  if (agents.length === 0) {
    console.error("There are no agents here yet. Write one in agents/, and list it in chloe.config.ts.");
    process.exit(2);
  }
  if (agents.length === 1) {
    name = agents[0].name;
  } else if (process.stdin.isTTY) {
    const { pick } = await import("./terminal.ts");
    name = await pick(
      "Which agent?",
      agents.map((one) => ({ key: one.name, what: one.description ? `${one.name}  ${dim(one.description)}` : one.name })),
    );
    console.log("");
  } else {
    console.error(`Which agent? One of: ${agents.map((a) => a.name).join(", ")}`);
    process.exit(2);
  }
}
const agent = agents.find((a) => a.name === name);
if (!agent) {
  console.error(
    `There is no agent called ${JSON.stringify(name)}. There is: ${agents.map((a) => a.name).join(", ")}`,
  );
  process.exit(2);
}

// A thread is what gives the conversation a memory: core/turn.ts recalls it
// before asking and writes to it after. One per session, so a new terminal
// starts clean.
let thread = `terminal:${name}:${new Date().toISOString()}`;
let last: Result | undefined;

async function ask(prompt: string): Promise<void> {
  last = await api<Result>(`/api/agents/${encodeURIComponent(name)}/chat`, { prompt, thread });
  show(last);
}

// A job, if what was typed is the id of one. Anything else is
// a question, because a question is the common case and a job is spelled
// exactly.
// The first word is the job, when it is one, and the rest is what to start it
// with: `npm run agent chloe reading-companion "a highlight"`. A job that takes
// nothing ignores the rest, and anything that is not a job id is a question.
const [head = "", ...said] = rest;
const asked = rest.join(" ").trim();
const wanted = head.replace(/\.(ts|md)$/i, "").toLowerCase();
const job = agent.jobs.find(
  (one) => one.id.toLowerCase() === wanted,
);

if (!job && /\.(ts|md)$/i.test(asked)) {
  const has = agent.jobs.map((one) => one.id).join(", ");
  console.error(
    `${name} has no job called ${JSON.stringify(asked)}. It has: ${has || "none"}.\n` +
      `Leave the name off to talk to it instead.`,
  );
  process.exit(2);
}

if (job) {
  console.log(
    `${bold(`${name}/${job.id}`)}${job.description ? ` (${job.description})` : ""}, ${job.cron ? `${job.cron} ${job.timezone}` : "when started"}, ` +
      `${job.code ? "code" : `a prompt on ${job.model}`}.`,
  );
  console.log(dim("Running it now. This is the real thing: it sends, writes and spends.\n"));

  const firedAt = Date.now();
  // The same envelope a channel sends, so a job written for Telegram can be
  // tried from here without being written for here as well.
  const text = said.join(" ").trim();
  await api(
    `/api/agents/${encodeURIComponent(name)}/job/${encodeURIComponent(job.id)}`,
    text ? { text, from: "terminal", user: "terminal" } : {},
  ).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  // The row appears as the run starts and its steps are written as they
  // finish, so following it is reading the same row again. Nothing here holds
  // the request open: a backup takes minutes and an ask waits for a person.
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  let runId: string | undefined;
  for (let i = 0; i < 50 && !runId; i++) {
    const runs = await api<Run[]>(`/api/runs?agent=${encodeURIComponent(name)}&limit=20`);
    runId = runs.find(
      (one) => one.job === job.id && Date.parse(one.started) >= firedAt - 2000,
    )?.id;
    if (!runId) await wait(200);
  }
  if (!runId) {
    console.error(
      "It was started but no run appeared. Something refused it before it began: " +
        "the terminal chloe is running in says what.",
    );
    process.exit(1);
  }

  let shown = 0;
  for (;;) {
    const run = await api<Run>(`/api/runs/${runId}`);
    for (const step of (run.trace ?? []).slice(shown)) console.log(`  ${traced(step)}`);
    shown = (run.trace ?? []).length;

    if (run.parked) {
      const waiting = JSON.parse(run.parked) as { who: string; question: string };
      console.log(`\n${bold("Waiting on")} ${waiting.who}: ${waiting.question}`);
      console.log(dim(`Answer it on the page, or leave it: ${runId}\n`));
      break;
    }
    if (run.finished) {
      if (run.error) console.error(`\n${bold("Failed")}: ${run.error}\n`);
      else console.log(`\n${(run.reply ?? "").trim()}\n`);
      const seconds = (Date.parse(run.finished) - Date.parse(run.started)) / 1000;
      console.log(
        dim(`(${run.steps ?? 0} steps, ${seconds.toFixed(1)}s, $${(run.cost ?? 0).toFixed(4)}, run ${runId})\n`),
      );
      process.exit(run.error ? 1 : 0);
    }
    await wait(400);
  }
  process.exit(0);
}

/** A line of a run as it happens: a code step with its time, a tool and what it was given, or what the model said. */
function traced(step: Step | Line): string {
  const price = (cost?: number) => (cost && cost > 0 ? `  $${cost.toFixed(4)}` : "");
  if ("seq" in step) {
    const kind = step.kind === "step" ? "" : `  ${step.kind}`;
    return `${step.name}${dim(`  ${(step.ms / 1000).toFixed(1)}s${price(step.cost)}${kind}`)}`;
  }
  if (step.tool) {
    const args = JSON.stringify(step.args ?? {});
    const state = step.refused ? "  not allowed" : step.failed ? "  failed" : "";
    return `${step.tool}${dim(`  ${args.length > 100 ? `${args.slice(0, 100)}...` : args}${state}`)}`;
  }
  const words = (step.say ?? "").trim().split("\n")[0] || "(asked for tools)";
  const aside = step.dropped ? `  set aside ${step.dropped.length} characters it wrote as if its tools had answered` : "";
  return `${words.length > 120 ? `${words.slice(0, 120)}...` : words}${dim(`${price(step.cost)}${aside}`)}`;
}

// Piped in, or a question on the command line: one turn and out, so it can be
// used in a script.
const piped = rest.length === 0 && !process.stdin.isTTY;
if (rest.length > 0 || piped) {
  const prompt = (rest.length > 0 ? asked : readFileSync(0, "utf8")).trim();
  if (!prompt) {
    console.error("The question is empty.");
    process.exit(2);
  }
  await ask(prompt).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  process.exit(0);
}

console.log(
  `${bold(agent.name)} on ${agent.model}, ${agent.tools.length} tools, ${agent.skills.length} skills, ` +
    `${agent.jobs.length} jobs.`,
);
console.log(dim("/exit to leave, /new to forget this conversation, /tools for the last turn's calls.\n"));

const lines = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await lines.question("> ")).trim();
  if (!line) continue;

  if (line === "/exit" || line === "/quit") break;
  if (line === "/new") {
    await api(`/api/threads/${encodeURIComponent(thread)}/forget`, {});
    thread = `terminal:${name}:${new Date().toISOString()}`;
    console.log(dim("Forgotten. Starting fresh.\n"));
    continue;
  }
  if (line === "/tools") {
    const calls = last?.runId ? await toolsOf(last.runId).catch(() => []) : [];
    if (calls.length === 0) console.log(dim("No tool calls in the last turn.\n"));
    else console.log(`${JSON.stringify(calls, null, 2)}\n`);
    continue;
  }

  // A failed turn does not end the session: the gateway running out of credit
  // is the common one, and it is fixable without losing the conversation.
  try {
    await ask(line);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  }
}
lines.close();
