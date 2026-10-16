// Changing an agent's own folder: which files it may write, and writing them
// as one commit under its name, so a person can read the change and undo it.
// Every rule is here in code rather than in a prompt: only the endings in
// `WRITABLE`, never its evals or its memory. What a person changed by hand in
// those files is committed first, under their own name. Code is loaded first,
// as the next reload would load it, and put back when it does not load.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { confine } from "#chloe/core/confine";
import { settingsAndBody } from "#chloe/core/markdown";
import { checkFirst, loadAgain, markdownJobProblem, type Agent, type Home } from "#chloe/load/load";
import { readFiles } from "#chloe/services/filesService";
import { commitPaths, noteCommit, uncommitted } from "#chloe/services/historyService";
import { inMemory, JUNK, typeProblems, within } from "#chloe/services/selfService";
import { parse } from "#chloe/timer/cron";

/** Endings that are code: a change with one of these is loaded before it is kept. */
const CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh"];

/** The endings an agent may write, without the dots: plain text and code. */
const WRITABLE = ["md", "txt", "html", "json", "yml", "yaml", "csv", "ts", "js", "mjs", "py", "sh"];

/** Why the agent may not write this path, or undefined when it may. */
export function whyNot(agent: Home, path: string): string | undefined {
  const at = within(agent, path);
  if (inMemory(agent, at)) return "that is your memory, which you change with memoryEditFile";
  const top = at.split("/")[0];
  if (top === "evals") return "evals/ is how your runs are marked";
  if (JUNK.includes(top)) return `${top}/ is made by a program`;
  const ending = extname(at).slice(1).toLowerCase();
  const code = CODE.includes(ending);
  if (!WRITABLE.includes(ending)) return `only files ending in ${WRITABLE.map((one) => `.${one}`).join(", ")} can be written`;
  // Code imports by path, so a job's code may sit in a folder of its own.
  if (/^jobs\/[^/]+\//.test(at) && !code) return "a file in a folder inside jobs/ is never read";
  // A skill is skills/<name>.md, or a folder skills/<name>/ with SKILL.md and whatever it needs beside it.
  if (top === "skills" && at.split("/").length === 2 && ending !== "md") return "a skill is skills/<name>.md, or a folder skills/<name>/ with a SKILL.md in it";
  return undefined;
}

/**
 * Replaces files in the agent's folder and commits them together under the
 * agent's name, as one change. A file with changes nobody has committed is
 * committed first, under this box's own git name, so the agent's commit holds
 * only what it wrote. Refused, with the reason and nothing written, when
 * `whyNot` keeps one back, or when what is written would not load: a job that
 * does not read, a job made to run more than once an hour, JSON that does not
 * parse. With a code file among them they are all written,
 * the agent is loaded once, and they are all put back when it would not load.
 */
export async function changeOwnFiles(agent: Home, files: { path: string; content: string }[], message: string) {
  if (files.length === 0) throw new Error("Say at least one file to write.");
  if (message.trim().length < 10) throw new Error("Say what changed and why, as a commit message.");
  const checked: Written[] = [];
  for (const { path, content } of files) {
    const one = { ...(await checkOne(agent, path, content)), content };
    if (checked.some((each) => each.at === one.at)) throw new Error(`${one.at} is in the list twice. Write each file once.`);
    checked.push(one);
  }

  const byHand: string[] = [];
  for (const one of checked) if (await uncommitted(one.resolved)) byHand.push(one.resolved);
  if (byHand.length > 0) {
    await commitPaths(agent.folder, byHand, { message: `Changed by hand, before ${agent.id} changed it`, runId: undefined }).catch((error: unknown) => {
      throw new Error(`What was changed by hand in ${byHand.length > 1 ? "these files" : "this file"} could not be committed first, so nothing was written: ${error instanceof Error ? error.message : String(error)}`);
    });
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

/** Writes one file. A file of code that starts with `#!` is a script, so it is written executable. */
async function put(one: Written): Promise<void> {
  await mkdir(dirname(one.resolved), { recursive: true });
  await writeFile(one.resolved, one.content);
  if (one.content.startsWith("#!") && CODE.includes(extname(one.at).slice(1).toLowerCase())) await chmod(one.resolved, 0o755);
}

/** Where one file goes, or a throw saying why the agent may not write it as it is. */
async function checkOne(agent: Home, path: string, content: string): Promise<{ at: string; resolved: string }> {
  const why = whyNot(agent, path);
  if (why) throw new Error(`You cannot write ${path}: ${why}.`);
  const at = within(agent, path);
  // An empty purpose file stops the agent loading, and so every reload after it.
  if (!content.trim()) throw new Error(`${at} would be empty. Write what it should say.`);
  const resolved = confine(agent.folder, at);

  if (/^jobs\/[^/]+\.md$/.test(at) && !existsSync(resolved.replace(/\.md$/, ".ts"))) {
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
