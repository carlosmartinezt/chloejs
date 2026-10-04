// An agent's own folder, as the agent itself may see and change it: its
// instructions, skills and jobs, and whatever other text its definition lets
// it write.
//
// Reading is anything in the folder except its memory, which has tools of its
// own. Writing is narrower, and every rule is here in code rather than in a
// prompt: only the file endings its definition lists, never code, never a
// path its definition keeps back, and never a file somebody else is in the
// middle of changing. A write is a commit of that one file under the agent's
// name, so every change can be read and undone.
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { confine, unreachable } from "#chloe/core/confine";
import { markdownJobProblem, type Home, type OwnFileRules } from "#chloe/load/load";
import { parse } from "#chloe/timer/cron";
import { settingsAndBody } from "#chloe/core/markdown";
import { readFiles, writeFiles } from "./filesService.ts";
import { uncommitted } from "./historyService.ts";

/** Folders of code, or of what marks the agent's runs. Never written, whatever `files` says. */
const KEPT_BACK = ["tools", "services", "channels", "scripts", "evals"];

/** Endings that are code. Never written, whatever `files` says. */
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
export function whyNot(agent: Home, rules: OwnFileRules, path: string): string | undefined {
  const at = within(agent, path);
  if (inMemory(agent, at)) return "that is your memory, which you write with writeNotes";
  const top = at.split("/")[0];
  if (KEPT_BACK.includes(top)) return top === "evals" ? "evals/ is how your runs are marked" : `${top}/ is code`;
  const ending = extname(at).slice(1).toLowerCase();
  if (CODE.includes(ending)) return "it is code";
  if (!rules.files.map((one) => one.replace(/^\./, "").toLowerCase()).includes(ending)) {
    return `only files ending in ${rules.files.map((one) => `.${one.replace(/^\./, "")}`).join(", ")} can be written`;
  }
  if ((rules.except ?? []).some((one) => within(agent, one) === at)) return "it is kept back for a person to change";
  if (/^(skills|jobs)\/[^/]+\//.test(at)) return `a file in a folder inside ${top}/ is never read`;
  if (top === "skills" && at !== "skills" && ending !== "md") return "a skill is one markdown file, and anything else in skills/ is never read";
  return undefined;
}

/** Every file in the agent's folder outside its memory, and whether it may write each one. */
export async function listOwn(agent: Home, rules: OwnFileRules) {
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
export async function readOwn(agent: Home, rules: OwnFileRules, path: string) {
  const at = within(agent, path);
  if (inMemory(agent, at)) throw new Error(`${path} is in your memory: read it with readNotes.`);
  const resolved = confine(agent.folder, at);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new Error(`${path} is a folder. listOwnFiles shows what is in it.`);
  }
  const { content } = await readFiles(agent.folder, at);
  const why = whyNot(agent, rules, at);
  return { path: at, content, canWrite: !why, ...(why && { why }) };
}

/**
 * Replaces one file in the agent's folder and commits it under the agent's
 * name. Refused, with the reason, when the rules keep it back, when it has
 * changes nobody has committed (they would go in under the agent's name), or
 * when what is written would not load: a job that does not read, a job made to
 * run more than once an hour, JSON that does not parse.
 */
export async function writeOwn(agent: Home, rules: OwnFileRules, path: string, content: string, message: string) {
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
    // Jobs are named in agent.ts, which is code and so not yours. A new file
    // here would be written, committed and never run.
    if (!existsSync(resolved)) {
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

  const written = await writeFiles(agent.folder, at, content, { commit: true, message, author: agent.name, in: "folder" });
  return { path: at, bytes: written.bytes, commit: written.commit };
}
