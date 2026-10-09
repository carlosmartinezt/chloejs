// What an agent may see and change of itself: its own folder, its own runs,
// and the guides for the version of chloe it runs on.
//
// Its folder is anything except its memory, which has tools of its own.
// Changing it is narrower, and every rule is here in code rather than in a
// prompt: only the file endings its definition lists, code only when it says
// `code`, never a path its definition keeps back, and never a file somebody
// else is in the middle of changing. A change is one commit under the agent's
// name, so it can be read and undone. Code is loaded first, as the next reload
// would load it, and put back when it does not load.
//
// Its runs are its own and never an eval's. The guides are docs/ in a clone
// and dist/docs/ in the package, the same place relative to this file in both.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { confine, unreachable } from "#chloe/core/confine";
import { db } from "#chloe/core/db";
import { settingsAndBody } from "#chloe/core/markdown";
import { ROOT } from "#chloe/core/paths";
import { checkFirst, loadAgain, markdownJobProblem, type Agent, type Home, type OwnFileRules } from "#chloe/load/load";
import { parse } from "#chloe/timer/cron";
import { readFiles } from "./filesService.ts";
import { commitPaths, noteCommit, uncommitted } from "./historyService.ts";

// Its folder.

/** Folders of code. Written only with `code`, and then only the endings `files` lists. */
const CODE_FOLDERS = ["tools", "services", "channels", "scripts"];

/** Endings that are code. Written only with `code`. */
const CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh"];

/** Made by a program, not by anybody. */
const JUNK = ["node_modules", "__pycache__"];

/** A path inside the agent's folder, as the folder sees it, or a throw when it leaves it. */
function within(agent: Home, path: string): string {
  return relative(realpathSync(agent.folder), confine(agent.folder, path));
}

function inMemory(agent: Home, path: string): boolean {
  const real = (folder: string) => (existsSync(folder) ? realpathSync(folder) : folder);
  const memory = relative(real(agent.folder), real(agent.memory.folder));
  return !memory.startsWith("..") && (path === memory || path.startsWith(`${memory}/`));
}

/** Why the agent may not write this path, or undefined when it may. */
export function whyNot(agent: Home, rules: OwnFileRules | undefined, path: string): string | undefined {
  const at = within(agent, path);
  if (inMemory(agent, at)) return "that is your memory, which you write with memoryWriteFile";
  if (!rules) return "changing your own files is switched off (selfImprovement: false in your definition)";
  const top = at.split("/")[0];
  if (top === "evals") return "evals/ is how your runs are marked";
  if (JUNK.includes(top)) return `${top}/ is made by a program`;
  const ending = extname(at).slice(1).toLowerCase();
  const code = CODE.includes(ending);
  if (!rules.code && CODE_FOLDERS.includes(top)) return `${top}/ is code`;
  if (!rules.code && code) return "it is code";
  if (!rules.files.map((one) => one.replace(/^\./, "").toLowerCase()).includes(ending)) {
    return `only files ending in ${rules.files.map((one) => `.${one.replace(/^\./, "")}`).join(", ")} can be written`;
  }
  if ((rules.except ?? []).some((one) => within(agent, one) === at)) return "it is kept back for a person to change";
  // Code imports by path, so a job's code may sit in a folder of its own.
  if (/^(skills|jobs)\/[^/]+\//.test(at) && !(code && top === "jobs")) return `a file in a folder inside ${top}/ is never read`;
  if (top === "skills" && at !== "skills" && ending !== "md") return "a skill is one markdown file, and anything else in skills/ is never read";
  return undefined;
}

/** Every file in the agent's folder outside its memory, and whether it may write each one. */
export async function ownFiles(agent: Home, rules: OwnFileRules | undefined) {
  const files: { path: string; canWrite: boolean; why?: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(join(agent.folder, dir), { withFileTypes: true }).catch(() => [])).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const at = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || JUNK.includes(entry.name) || unreachable(entry.name) || inMemory(agent, at)) continue;
      if (entry.isDirectory()) {
        if (depth < 6) await walk(at, depth + 1);
      } else if (files.length < 500) {
        const why = whyNot(agent, rules, at);
        files.push({ path: at, canWrite: !why, ...(why && { why }) });
      }
    }
  };
  await walk("", 0);
  return { files };
}

/** One file in the agent's folder, and whether it may write it. */
export async function ownFile(agent: Home, rules: OwnFileRules | undefined, path: string) {
  const at = within(agent, path);
  if (inMemory(agent, at)) throw new Error(`${path} is in your memory: read it with memoryReadFile.`);
  const resolved = confine(agent.folder, at);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new Error(`${path} is a folder. selfListFiles shows what is in it.`);
  }
  const { content } = await readFiles(agent.folder, at);
  const why = whyNot(agent, rules, at);
  return { path: at, content, canWrite: !why, ...(why && { why }) };
}

/**
 * Replaces files in the agent's folder and commits them together under the
 * agent's name, as one change. Refused, with the reason and nothing written,
 * when the rules keep one back, when one has changes nobody has committed
 * (they would go in under the agent's id), or when what is written would not
 * load: a job that does not read, a job made to run more than once an hour,
 * JSON that does not parse. With a code file among them they are all written,
 * the agent is loaded once, and they are all put back when it would not load.
 */
export async function changeOwnFiles(agent: Home, rules: OwnFileRules, files: { path: string; content: string }[], message: string) {
  if (files.length === 0) throw new Error("Say at least one file to write.");
  if (message.trim().length < 10) throw new Error("Say what changed and why, as a commit message.");
  const checked: Written[] = [];
  for (const { path, content } of files) {
    const one = { ...(await checkOne(agent, rules, path, content)), content };
    if (checked.some((each) => each.at === one.at)) throw new Error(`${one.at} is in the list twice. Write each file once.`);
    checked.push(one);
  }

  if (checked.some((one) => CODE.includes(extname(one.at).slice(1).toLowerCase()))) await loadsOrPutBack(agent, checked);
  else for (const one of checked) await put(one);

  const commit = await commitPaths(agent.folder, checked.map((one) => one.resolved), { message, author: agent.id }).then(
    (id) => {
      noteCommit("folder", id, message);
      return id ? id.slice(0, 12) : "nothing changed, so nothing was committed";
    },
    (error: unknown) => `not committed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { files: checked.map((one) => ({ path: one.at, bytes: one.content.length })), commit };
}

/** One file to write: where, as the folder sees it and on disk, and what. */
interface Written {
  at: string;
  resolved: string;
  content: string;
}

async function put(one: Written): Promise<void> {
  await mkdir(dirname(one.resolved), { recursive: true });
  await writeFile(one.resolved, one.content);
}

/** Where one file goes, or a throw saying why the agent may not write it as it is. */
async function checkOne(agent: Home, rules: OwnFileRules, path: string, content: string): Promise<{ at: string; resolved: string }> {
  const why = whyNot(agent, rules, path);
  if (why) throw new Error(`You cannot write ${path}: ${why}.`);
  const at = within(agent, path);
  // An empty instructions file stops the agent loading, and so every reload after it.
  if (!content.trim()) throw new Error(`${at} would be empty. Write what it should say.`);
  const resolved = confine(agent.folder, at);
  if (await uncommitted(resolved)) {
    throw new Error(
      `${at} has changes nobody has committed yet, and writing it would put them under your name. ` +
        "Leave it for now, and say that you could not change it and why.",
    );
  }

  if (/^jobs\/[^/]+\.md$/.test(at) && !existsSync(resolved.replace(/\.md$/, ".ts"))) {
    // Jobs are named in agent.ts. Without `code` that is not yours, and a new
    // file here would be written, committed and never run.
    if (!existsSync(resolved) && !rules.code) {
      throw new Error(
        `${at} would be a new job, and a job only runs once it is named in agent.ts, which only a person can change. ` +
          "Ask for it, and change a job that is already there meanwhile.",
      );
    }
    const problem = markdownJobProblem(content);
    if (problem) throw new Error(`${at} would not load as a job: ${problem}.`);
    const cron = settingsAndBody(content).settings.cron;
    const before = existsSync(resolved) ? (await readFiles(agent.folder, at)).content : "";
    if (cron && cron !== settingsAndBody(before).settings.cron && parse(cron).minute.length > 1) {
      throw new Error(`A job you write runs at most once an hour: give its cron line one minute, like "0 7 * * *".`);
    }
  }
  if (extname(at).toLowerCase() === ".json") {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`${at} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return { at, resolved };
}

/**
 * Writes the files and loads the agent once, as the next reload would. When it
 * does not load, does not type check (in a project with TypeScript), or makes
 * a job run more than once an hour, every file is put back as it was and the
 * reason thrown. Reloads wait for this, so nothing unchecked goes live.
 */
async function loadsOrPutBack(agent: Home, files: Written[]): Promise<void> {
  await checkFirst(async () => {
    const before = await Promise.all(files.map((one) => (existsSync(one.resolved) ? readFile(one.resolved, "utf8") : undefined)));
    const was = await loadAgain(agent).catch(() => undefined);
    for (const one of files) await put(one);
    const problem = await wontLoad(agent, was);
    if (!problem) return;
    for (const [i, one] of files.entries()) {
      if (before[i] === undefined) await rm(one.resolved, { force: true });
      else await writeFile(one.resolved, before[i]);
    }
    const which = files.map((one) => one.at);
    throw new Error(`${which.join(", ")} ${which.length > 1 ? "are" : "is"} put back as ${which.length > 1 ? "they were" : "it was"}, because ${problem}`);
  });
}

/** Why the agent as its files are now would not do, or "" when it would. */
async function wontLoad(agent: Home, was: Agent | undefined): Promise<string> {
  let now: Agent;
  try {
    now = await loadAgain(agent);
  } catch (error) {
    return `you would not load: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const job of now.jobs) {
    const before = was?.jobs.find((one) => one.id === job.id)?.cron;
    if (job.cron && job.cron !== before && parse(job.cron).minute.length > 1) {
      return `${job.id} would run more than once an hour, and a job you write runs at most once an hour: give its cron line one minute, like "0 7 * * *"`;
    }
  }
  const types = await typeProblems(agent.folder);
  return types ? `it does not type check:\n${types}` : "";
}

/**
 * What TypeScript says is wrong in the agent's folder, or "" when nothing is,
 * the project has no TypeScript and tsconfig.json to ask, or the folder is
 * outside the project. Problems in other folders are not this agent's to fix.
 */
async function typeProblems(folder: string): Promise<string> {
  const mine = `${relative(realpathSync(ROOT), realpathSync(folder))}/`;
  if (mine.startsWith("..")) return "";
  let tsc: string;
  try {
    tsc = createRequire(join(ROOT, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return "";
  }
  if (!existsSync(join(ROOT, "tsconfig.json"))) return "";
  const out = await new Promise<string>((done) =>
    execFile(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", ROOT], { cwd: ROOT, timeout: 120_000, maxBuffer: 8 << 20 }, (_error, stdout) => done(stdout ?? "")),
  );
  return out
    .split("\n")
    .filter((line) => line.startsWith(mine))
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
export function ownRuns(agent: string, options: { job?: string; limit?: number } = {}) {
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
export function ownRun(agent: string, id: string) {
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
