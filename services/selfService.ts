// What an agent may see of itself: its own folder, its own runs, and the
// guides for the version of chloe it runs on. Changing its folder is the
// self-improvement plugin's.
//
// Its folder is anything except its memory, which has tools of its own.
// Its runs are its own and never an eval's. The guides are docs/ in a clone
// and dist/docs/ in the package, the same place relative to this file in both.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { confine, unreachable } from "#chloe/core/confine";
import { db } from "#chloe/core/db";
import { ROOT } from "#chloe/core/paths";
import type { Home } from "#chloe/load/load";
import { readFiles } from "./filesService.ts";

// Its folder.

/** Made by a program, not by anybody. */
export const JUNK = ["node_modules", "__pycache__"];

/** A path inside the agent's folder, as the folder sees it, or a throw when it leaves it. */
export function within(agent: Home, path: string): string {
  return relative(realpathSync(agent.folder), confine(agent.folder, path));
}

/** Whether a path inside the agent's folder, as `within` gives it, is in its memory. */
export function inMemory(agent: Home, path: string): boolean {
  const real = (folder: string) => (existsSync(folder) ? realpathSync(folder) : folder);
  const memory = relative(real(agent.folder), real(agent.memory.folder));
  return !memory.startsWith("..") && (path === memory || path.startsWith(`${memory}/`));
}

/** The files in the agent's folder outside its memory, up to `most`. */
export async function ownFiles(agent: Home, most = 500) {
  const files: { path: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(join(agent.folder, dir), { withFileTypes: true }).catch(() => [])).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (files.length >= most) return;
      const at = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || JUNK.includes(entry.name) || unreachable(entry.name, join(agent.folder, at)) || inMemory(agent, at)) continue;
      if (entry.isDirectory()) {
        if (depth < 6) await walk(at, depth + 1);
      } else {
        files.push({ path: at });
      }
    }
  };
  await walk("", 0);
  return { files };
}

/** One file in the agent's folder. */
export async function ownFile(agent: Home, path: string) {
  const at = within(agent, path);
  if (inMemory(agent, at)) throw new Error(`${path} is in your memory: read it with memoryReadFile.`);
  const resolved = confine(agent.folder, at);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new Error(`${path} is a folder. ownListFiles shows what is in it.`);
  }
  const { content } = await readFiles(agent.folder, at);
  return { path: at, content };
}

/**
 * What TypeScript says is wrong in that folder or file, or "" when nothing is,
 * the project has no TypeScript and tsconfig.json to ask, or the path is
 * outside the project. Problems anywhere else are not the caller's to fix.
 */
export async function typeProblems(path: string): Promise<string> {
  const mine = relative(realpathSync(ROOT), realpathSync(path));
  if (mine.startsWith("..")) return "";
  let tsc: string;
  try {
    // Through its package.json: TypeScript 7 does not export bin/tsc.
    const manifest = createRequire(join(ROOT, "package.json")).resolve("typescript/package.json");
    tsc = join(dirname(manifest), (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { tsc?: string } }).bin?.tsc ?? "bin/tsc");
  } catch {
    return "";
  }
  if (!existsSync(join(ROOT, "tsconfig.json"))) return "";
  const out = await new Promise<string>((done) =>
    execFile(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", ROOT], { cwd: ROOT, timeout: 120_000, maxBuffer: 8 << 20 }, (_error, stdout) => done(stdout ?? "")),
  );
  return out
    .split("\n")
    .filter((line) => line.startsWith(`${mine}/`) || line.startsWith(`${mine}(`))
    .slice(0, 20)
    .join("\n");
}

// Its runs.

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
  unpriced: number;
  trace: string;
  parked: string | null;
  held: string | null;
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
export function ownRuns(agent: string, options: { job?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const where = options.job === "chat" ? "and job is null" : options.job ? "and job = ?" : "";
  const rows = db
    .prepare(
      `select id, job, source, started, finished, cost, unpriced, steps, error is not null as failed, parked is not null as waiting,
       held is not null as trial
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
      ...(one.unpriced ? { unpriced: one.unpriced } : {}),
      steps: one.steps,
      ...(one.failed ? { failed: true } : {}),
      ...(one.waiting ? { waiting: true } : {}),
      ...(one.trial ? { trial: true } : {}),
    })),
  };
}

/**
 * One of the agent's runs in full: what started it, what it answered or why
 * it failed, and its steps in order, each cut to a length a model can read.
 */
export function ownRun(agent: string, id: string) {
  const row = db.prepare("select * from runs where id = ? and agent = ? and source != 'eval'").get(id.trim(), agent) as Row | undefined;
  if (!row) throw new Error(`You have no run ${JSON.stringify(id)}. ownListRuns lists them.`);
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
    ...(row.unpriced ? { unpriced: row.unpriced } : {}),
    // A job's prompt is its own words, which ownReadFile shows; a conversation's is what was said.
    ...(row.job ? {} : { asked: clip(row.asked ?? row.prompt) }),
    ...(row.reply ? { reply: clip(row.reply) } : {}),
    ...(row.summary && row.summary !== row.reply ? { summary: row.summary } : {}),
    ...(row.error ? { error: clip(row.error) } : {}),
    ...(row.parked ? { waiting: true } : {}),
    // A trial run, and everything it would have sent and did not.
    ...(row.held ? { trial: true, held: JSON.parse(row.held) as unknown[] } : {}),
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
    ...(line.unpriced ? { unpriced: line.unpriced } : {}),
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

// The guides.

const GUIDES = fileURLToPath(new URL("../docs", import.meta.url));

/** Every guide, by the name guide() takes, with the one line that says what it covers. */
export function guides(): { page: string; about: string }[] {
  if (!existsSync(GUIDES)) return [];
  return readdirSync(GUIDES)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const text = readFileSync(join(GUIDES, file), "utf8");
      // The built page says it as "> ...", the source as "summary: ...".
      const about = /^(?:> |summary: )(.+)$/m.exec(text)?.[1] ?? "";
      return { page: basename(file, ".md"), about };
    });
}

/** One guide, whole, by its name from guides(), like "connections". */
export function guide(page: string): string {
  const name = basename(page.replace(/\.md$/, ""));
  const path = join(GUIDES, `${name}.md`);
  if (!existsSync(path)) throw new Error(`There is no guide called ${page}. The guides are: ${guides().map((one) => one.page).join(", ")}.`);
  return readFileSync(path, "utf8");
}
