// Where an agent remembers things, browsed and edited from the site.
//
// Not to be confused with model/memory.ts, which is the last few messages of a
// conversation. This is a folder: the one an agent reads and writes between
// runs. Every agent has one, and unless its definition says otherwise it is
// that agent's own folder under the state directory. An agent that shares a
// folder with a person, like one that keeps somebody's notes, says where.
//
// Every file served is written down first, and that is the point rather than a
// detail. Reading these files from a shell is not recorded, because a shell on
// the box is already the whole of the box. Reading them over HTTP is recorded,
// because HTTP is the part somebody else could come through, and a log of what
// was served is the only way to answer afterwards what was taken. Do not make
// the log optional or best effort: a read that could not be recorded is
// refused instead.
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename as move, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { promisify } from "node:util";

import { confine, unreachable } from "#chloe/core/confine.ts";
import type { Agent } from "#chloe/load/load.ts";
import { list, read, write } from "#chloe/services/filesService.ts";
import { STATE } from "#chloe/core/paths.ts";
import { BadRequest } from "./errors.ts";
import { noteHead } from "./page.ts";

const git = promisify(execFile);

/** Deep enough for a folder of writing, and an end to it if something links in a circle. */
const DEPTH = 8;

const JUNK = ["node_modules", "__pycache__"];

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  /** Bytes, for a file. */
  size?: number;
  /** When it last changed, as an ISO date. */
  modified?: string;
  children?: Entry[];
}

/** What the site calls it. */
export function memoryLabel(agent: Agent): string {
  return agent.memory.label || "Memory";
}

/**
 * Beside the state folder rather than inside the memory it records. For most
 * agents the memory IS their state folder, and a log inside the folder it logs
 * would show up in its own tree and change it every time it was read.
 */
function logFor(agent: Agent): string {
  return `${STATE}/memory-audit/${agent.name}.jsonl`;
}

function folder(agent: Agent): string {
  return agent.memory.folder;
}

/**
 * One line in the audit log. Awaited rather than left to finish on its own:
 * the read that follows it must not happen if this could not be written.
 */
export async function record(
  agent: Agent,
  what: "read" | "write" | "list" | "serve" | "rename" | "delete" | "commit" | "push" | "pull",
  path: string,
  from: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(`${STATE}/memory-audit`, { recursive: true });
  await appendFile(logFor(agent), JSON.stringify({ at: new Date().toISOString(), what, path, from, ...extra }) + "\n");
}

/**
 * The whole folder as a tree. An agent that has never written anything has no
 * folder yet, which is an empty memory and not an error.
 *
 * Recorded like a read is. A listing carries no file contents, but the names in
 * a folder of personal writing say plenty on their own.
 */
export async function memoryTree(agent: Agent, from = "unknown"): Promise<Entry[]> {
  if (!existsSync(folder(agent))) return [];
  await record(agent, "list", "/", from);
  return walk(agent, "");
}

async function walk(agent: Agent, path: string, depth = 0): Promise<Entry[]> {
  const { entries } = await list(folder(agent), path || undefined);
  const out: Entry[] = [];
  for (const entry of entries) {
    const dir = entry.endsWith("/");
    const name = dir ? entry.slice(0, -1) : entry;
    // Left out rather than shown: a folder like secrets/ could never be opened
    // from here, and trying to list it would stop the whole tree at the first
    // one it met.
    if (JUNK.includes(name) || unreachable(name)) continue;
    const at = path ? `${path}/${name}` : name;
    const about = await stat(`${folder(agent)}/${at}`).catch(() => null);
    out.push({
      name,
      path: at,
      dir,
      size: dir ? undefined : about?.size,
      modified: about?.mtime.toISOString(),
      children: dir && depth < DEPTH ? await walk(agent, at, depth + 1) : undefined,
    });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/**
 * Where a caller's path lands, or null when it is not inside the folder.
 *
 * A path that tries to leave is answered the same way as a file that is not
 * there, so whoever sent it learns nothing, and in particular not where on disk
 * the folder is. Worth one line in the log, because somebody sent it on purpose.
 */
function inside(agent: Agent, path: string, from: string): string | null {
  if (!existsSync(folder(agent))) return null;
  try {
    return confine(folder(agent), path);
  } catch (error) {
    console.error(`memory: ${agent.name} refused ${JSON.stringify(path)} from ${from}: ${(error as Error).message}`);
    return null;
  }
}

/** One file as text, for editing. A folder answers with what is in it. */
export async function memoryOpen(agent: Agent, path: string, from: string) {
  const resolved = inside(agent, path, from);
  if (!resolved || !existsSync(resolved)) return null;
  if (statSync(resolved).isDirectory()) {
    await record(agent, "list", path, from);
    return { path, dir: true as const, entries: await walk(agent, path) };
  }
  const file = await read(folder(agent), path);
  // After the read and before the reply, so nothing is handed over unrecorded.
  await record(agent, "read", path, from, { bytes: file.bytes });
  return { path, dir: false as const, content: file.content, bytes: file.bytes };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
};

/**
 * One file as its own bytes, for the frame it is shown in and whatever it
 * links. Null when it is not there or not inside the folder.
 *
 * An HTML file has its root-relative links pointed back into this memory,
 * under the same pass, because that is where they mean. A note that says
 * `<link href="/static/style.css">` means the stylesheet at the top of its own
 * folder, not one at the top of this website. Only an href or a src that
 * starts with a single slash is touched: `//host` is somewhere else entirely.
 */
export async function memoryRaw(
  agent: Agent,
  path: string,
  from: string,
  under: string,
): Promise<{ body: Buffer; type: string } | null> {
  const resolved = inside(agent, path, from);
  if (!resolved || !existsSync(resolved) || (await stat(resolved)).isDirectory()) return null;
  const type = TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
  let body = await readFile(resolved);
  if (type.startsWith("text/html")) {
    const html = body.toString("utf8").replace(/(\s(?:href|src)=["'])\/(?!\/)/gi, `$1${under}/`);
    body = Buffer.from(withHead(html, noteHead()));
  }
  await record(agent, "serve", path, from, { bytes: body.length });
  return { body, type };
}

/**
 * An HTML file with `head` put first inside its own head, or where the browser
 * will build one when it has none. Nothing the file wrote is changed, and what
 * is added comes before it, so the file's own styles still win.
 */
export function withHead(html: string, head: string): string {
  if (!head) return html;
  // The lookahead matters: `<head[^>]*>` alone also matches `<header>`.
  const open = /<head(?=[\s>])[^>]*>/i;
  if (open.test(html)) return html.replace(open, (tag) => `${tag}\n${head}`);
  const root = /<html(?=[\s>])[^>]*>/i;
  if (root.test(html)) return html.replace(root, (tag) => `${tag}\n<head>${head}</head>`);
  // After a doctype, never before it, or the page renders in quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i;
  if (doctype.test(html)) return html.replace(doctype, (tag) => `${tag}\n${head}`);
  return `${head}\n${html}`;
}

export async function memorySave(agent: Agent, path: string, content: string, from: string) {
  if (!inside(agent, path, from)) throw new BadRequest(`${path} is not somewhere in this memory.`);
  const commit = Boolean(agent.memory.commit) && (await isRepo(agent));
  const written = await write(folder(agent), path, content, {
    commit,
    message: commit ? `memory: ${path} from the site` : undefined,
  });
  await record(agent, "write", path, from, { bytes: content.length });
  return { path, bytes: written.bytes };
}

/** Moves a file or a folder. Both ends have to be inside, and the new one must not exist. */
export async function memoryRename(agent: Agent, from: string, to: string, who: string) {
  const here = inside(agent, from, who);
  const there = inside(agent, to, who);
  if (!here || !there || !existsSync(here)) throw new BadRequest(`${from} is not somewhere in this memory.`);
  if (existsSync(there)) throw new BadRequest(`${to} is already there.`);
  await mkdir(dirname(there), { recursive: true });
  await move(here, there);
  await record(agent, "rename", from, who, { to });
  return { from, to };
}

/**
 * Deletes a file or a folder. In a repo that is recoverable from git, which is
 * why the memory of an agent that keeps a person's notes should be one.
 */
export async function memoryDelete(agent: Agent, path: string, who: string) {
  const here = inside(agent, path, who);
  if (!here || !existsSync(here) || here === folder(agent)) {
    throw new BadRequest(`${path} is not something in this memory that can be deleted.`);
  }
  await rm(here, { recursive: true });
  await record(agent, "delete", path, who);
  return { deleted: path };
}

/** That agent's audit log, newest first. */
export async function memoryLog(agent: Agent, limit = 200): Promise<unknown[]> {
  const text = await readFile(logFor(agent), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { at: "", what: "unreadable", line };
      }
    });
}

// Source control, when the memory is a repo. Enough to mirror the panel an
// editor puts beside its file tree: what changed, commit it, push, pull, and the
// recent history. Every call is `git` with an argument array and never a shell
// string, and nothing here takes a path from the browser: a commit is the whole
// tree, which is the only shape of commit this offers.

async function inRepo(agent: Agent, ...args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { cwd: folder(agent), maxBuffer: 8 << 20, timeout: 60_000 });
  return stdout;
}

/**
 * Whether this memory is itself a git repository: its folder is the top of one.
 *
 * Being inside one is not enough, and that difference is the whole of this
 * function. An agent's memory defaults to its folder under the state
 * directory, and that is usually inside the repo the agents are written in.
 * Asked from there, git walks up and answers for that repo: its branch, its
 * changes, and a "commit all" that stages every file in it from wherever it is
 * run. So a memory panel would show somebody's unrelated work in progress as
 * the memory's own changes, one click would commit it under a message written
 * about something else, and push would send it off the box.
 */
async function isRepo(agent: Agent): Promise<boolean> {
  if (!existsSync(folder(agent))) return false;
  try {
    const top = (await inRepo(agent, "rev-parse", "--show-toplevel")).trim();
    return realpathSync(top) === realpathSync(folder(agent));
  } catch {
    return false;
  }
}

export async function memoryGit(agent: Agent) {
  if (!(await isRepo(agent))) return { repo: false as const };
  const [porcelain, branch, history] = await Promise.all([
    inRepo(agent, "status", "--porcelain=v1"),
    inRepo(agent, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "HEAD\n"),
    inRepo(agent, "log", "-20", "--date=short", "--format=%h%x00%ad%x00%an%x00%s").catch(() => ""),
  ]);
  const changes = porcelain
    .split("\n")
    .filter((line) => line.trim())
    // XY<space>path, where XY is the two-letter index and worktree status.
    .map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3) }));
  let ahead = 0;
  let behind = 0;
  let upstream: string | null = null;
  try {
    upstream = (await inRepo(agent, "rev-parse", "--abbrev-ref", "@{upstream}")).trim();
    const [a, b] = (await inRepo(agent, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"))
      .trim()
      .split(/\s+/)
      .map(Number);
    ahead = a || 0;
    behind = b || 0;
  } catch {
    // No upstream. Push says so rather than guessing one.
  }
  const log = history
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split("\0");
      return { sha, date, author, subject };
    });
  return { repo: true as const, branch: branch.trim(), changes, ahead, behind, upstream, log };
}

export async function memoryCommit(agent: Agent, message: string, who: string) {
  const text = message.trim();
  if (!text) throw new BadRequest("Write a commit message first.");
  if (!(await isRepo(agent))) throw new BadRequest("This memory is not a git repository.");
  await inRepo(agent, "add", "-A");
  const staged = (await inRepo(agent, "diff", "--cached", "--name-only")).trim();
  if (!staged) throw new BadRequest("Nothing to commit.");
  await inRepo(agent, "commit", "-m", text);
  const sha = (await inRepo(agent, "rev-parse", "--short", "HEAD")).trim();
  await record(agent, "commit", "/", who, { commit: sha, message: text });
  return { commit: sha, files: staged.split("\n").length };
}

/**
 * Push is the one thing here that sends these files off the box, so it says
 * where they went rather than just that it worked.
 */
export async function memoryPush(agent: Agent, who: string) {
  const status = await memoryGit(agent);
  if (!status.repo) throw new BadRequest("This memory is not a git repository.");
  if (!status.upstream) throw new BadRequest("No upstream branch is set for this branch.");
  if (!status.ahead) return { pushed: 0, upstream: status.upstream };
  const url = (await inRepo(agent, "remote", "get-url", status.upstream.split("/")[0]).catch(() => "")).trim();
  await inRepo(agent, "push");
  await record(agent, "push", "/", who, { upstream: status.upstream, url, commits: status.ahead });
  return { pushed: status.ahead, upstream: status.upstream, url };
}

/** Fast-forward only: a merge or a conflict is not something a button can sensibly resolve. */
export async function memoryPull(agent: Agent, who: string) {
  if (!(await isRepo(agent))) throw new BadRequest("This memory is not a git repository.");
  const out = await inRepo(agent, "pull", "--ff-only").catch((error: { stderr?: string; message: string }) => {
    throw new BadRequest(String(error.stderr || error.message).split("\n")[0]);
  });
  await record(agent, "pull", "/", who);
  return { output: out.trim() };
}
