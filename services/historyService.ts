// What changed in an agent's folders, as git history.
//
// Two places can hold it: the agent's memory, a folder in the repository every
// memory shares, and the agent's own folder (instructions, skills, jobs),
// usually inside the repository the agents are written in. So a place is a
// folder inside a repository and never a repository, and everything here is
// scoped to that folder: what is listed, what is shown, and above all what is
// committed, because the folder beside it belongs to another agent. A commit made
// for an agent is written under the agent's name with an empty email, and
// ends with the run that made it, `Run: <id>`, so a file's history leads back
// to the run and the run's record lists its commits.
//
// Every call is git with an argument list, never a shell string.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { currentRun } from "#chloe/core/current";
import { addCommit, db, type RunCommit } from "#chloe/core/db";
import type { Agent } from "#chloe/load/load";

/** Which of an agent's two places a commit is in. */
export type Place = RunCommit["in"];

interface Git {
  code: number;
  out: string;
  err: string;
}

/**
 * One git command in `cwd`. `author` makes the commit that agent's, author and
 * committer both, so it works on a box whose git has no name set. It goes in
 * git's own environment variables, because those beat any setting. Never throws.
 */
async function git(cwd: string, args: string[], author?: string): Promise<Git> {
  const env = author
    ? { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: "" }
    : process.env;
  const unsigned = author ? ["-c", "commit.gpgsign=false"] : [];
  for (let attempt = 0; ; attempt++) {
    const result = await new Promise<Git>((done) =>
      execFile(
        "git",
        [...unsigned, ...args],
        { cwd, env, encoding: "utf8", maxBuffer: 32 << 20, timeout: 60_000 },
        (error, out, err) => done({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, out: out ?? "", err: err ?? "" }),
      ),
    );
    // Two writes to one repo at the same moment: the second finds the first's lock.
    if (result.code === 0 || !result.err.includes("index.lock") || attempt === 5) return result;
    await new Promise((wait) => setTimeout(wait, 200));
  }
}

async function gitOrThrow(cwd: string, args: string[], author?: string): Promise<string> {
  const result = await git(cwd, args, author);
  if (result.code !== 0) throw new Error((result.err || result.out).trim().split("\n")[0] || `git ${args[0]} failed`);
  return result.out;
}

/** The top of the repository a folder is in, or undefined when it is in none. */
export async function repoOf(folder: string): Promise<string | undefined> {
  if (!existsSync(folder)) return undefined;
  const found = await git(folder, ["rev-parse", "--show-toplevel"]);
  return found.code === 0 ? realpathSync(found.out.trim()) : undefined;
}

/**
 * Whether a folder is the top of a repository of its own. Being inside one is
 * not enough: asked from there, git answers for the repository around it.
 */
export async function isRepoTop(folder: string): Promise<boolean> {
  const top = await repoOf(folder);
  return top !== undefined && top === realpathSync(folder);
}

function withRun(message: string, runId: string | undefined): string {
  return runId ? `${message.trim()}\n\nRun: ${runId}` : message.trim();
}

/**
 * Commits these paths and nothing else: whatever else is changed or staged in
 * the repository stays as it was, so somebody's work in progress stays theirs.
 * Answers the new commit's id, or undefined when those paths had not changed.
 */
export async function commitPaths(
  folder: string,
  paths: string[],
  { message, author, runId = currentRun() }: { message: string; author?: string; runId?: string },
): Promise<string | undefined> {
  const repo = await repoOf(folder);
  if (!repo) throw new Error(`${folder} is not in a git repository.`);
  if (paths.length === 0) return undefined;
  const inRepo = paths.map((one) => relative(repo, resolve(realpathSync(folder), one)));
  await gitOrThrow(repo, ["add", "-A", "--", ...inRepo]);
  if ((await git(repo, ["diff", "--cached", "--quiet", "--", ...inRepo])).code === 0) return undefined;
  await gitOrThrow(repo, ["commit", "-q", "-m", withRun(message, runId), "--", ...inRepo], author);
  return (await gitOrThrow(repo, ["rev-parse", "HEAD"])).trim();
}

/** Commits everything that changed in a repository. Undefined when nothing had. */
export async function commitAll(
  repo: string,
  { message, author, runId }: { message: string; author?: string; runId?: string },
): Promise<string | undefined> {
  await gitOrThrow(repo, ["add", "-A"]);
  if ((await git(repo, ["diff", "--cached", "--quiet"])).code === 0) return undefined;
  await gitOrThrow(repo, ["commit", "-q", "-m", withRun(message, runId)], author);
  return (await gitOrThrow(repo, ["rev-parse", "HEAD"])).trim();
}

/** Whether a file has changes nobody has committed, including being new and never added. */
export async function uncommitted(file: string): Promise<boolean> {
  const repo = await repoOf(dirname(file));
  if (!repo) return false;
  const status = await git(repo, ["status", "--porcelain", "--", relative(repo, file)]);
  return status.out.trim() !== "";
}

/**
 * Makes a folder a repository of its own and commits what is already in it,
 * under `author`. A repository the folder sits inside is told to leave it
 * alone, in its own `info/exclude`, so a "commit all" there never takes it.
 */
export async function makeRepo(folder: string, author: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  if (await isRepoTop(folder)) return;
  const outer = await repoOf(folder);
  await gitOrThrow(folder, ["init", "-q", "-b", "main"]);
  if (outer) {
    const exclude = resolve(outer, (await gitOrThrow(outer, ["rev-parse", "--git-path", "info/exclude"])).trim());
    const line = `/${relative(outer, realpathSync(folder))}/`;
    const already = await readFile(exclude, "utf8").catch(() => "");
    if (!already.split("\n").includes(line)) {
      await mkdir(dirname(exclude), { recursive: true });
      await appendFile(exclude, `${already && !already.endsWith("\n") ? "\n" : ""}${line}\n`);
    }
  }
  await commitAll(folder, { message: "What was here when this folder started keeping its history", author });
}

/**
 * The repository a memory's history is in: the one the memory folder is the top
 * of, or the one its parent is the top of, which is the repository every agent's
 * memory shares. Anywhere deeper inside a repository has no history here, on
 * purpose. Being inside a repository is not enough: asked from there, git
 * answers for whatever repository is around it, so a memory somebody keeps in
 * their source tree would show their work in progress as its own changes and
 * push their branch off the box.
 */
export async function memoryRepo(agent: Agent): Promise<string | undefined> {
  const top = await repoOf(agent.memory.folder);
  if (!top) return undefined;
  const own = realpathSync(agent.memory.folder);
  return top === own || top === dirname(own) ? top : undefined;
}

/** Whether this agent's memory is committed once a run ends. See Memory in load/load.ts. */
function eachRun(agent: Agent): boolean {
  return agent.memory.commit === "each run";
}

/**
 * Before a run: whatever changed in the memory since the last run ended was
 * done by somebody else, so it is committed under this box's own git name and
 * the run's commit holds only the run's work. Skipped while another run of the
 * same agent is going, because then what changed is that run's.
 */
export async function beforeRun(agent: Agent, runId: string): Promise<void> {
  if (!eachRun(agent) || !(await memoryRepo(agent))) return;
  const busy = db
    .prepare("select 1 from runs where agent = ? and finished is null and parked is null and id != ? limit 1")
    .get(agent.name, runId);
  if (busy) return;
  await commitPaths(agent.memory.folder, ["."], { message: "Changed outside a run", runId: undefined }).catch((error: unknown) =>
    console.error(`${agent.name}: committing what changed outside a run failed:`, error instanceof Error ? error.message : error),
  );
}

/** A commit's first line: what the run was, and what it said or why it stopped. */
function subjectFor({ job, source, summary, error }: RunEnd): string {
  const said = error ? `stopped: ${error.split("\n")[0]}` : summary?.trim() || "finished";
  const line = `${job || source}: ${said}`;
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

/** How a run ended, for its commit message. */
export interface RunEnd {
  job?: string | null;
  source: string;
  summary?: string | null;
  error?: string | null;
}

/**
 * After a run, or when it stops to wait for somebody: everything that changed
 * in the memory is committed under the agent's name, and the run keeps the
 * commit. Never throws, because the run's work is already done: a commit that
 * failed is said in the service's log.
 */
export async function afterRun(agent: Agent, runId: string, end: RunEnd): Promise<void> {
  try {
    if (!eachRun(agent) || !(await memoryRepo(agent))) return;
    const subject = subjectFor(end);
    const id = await commitPaths(agent.memory.folder, ["."], { message: subject, author: agent.name, runId });
    if (id) addCommit(runId, { in: "memory", id, subject });
  } catch (error) {
    console.error(`${agent.name}: committing run ${runId} failed:`, error instanceof Error ? error.message : error);
  }
}

/** Records a commit made during a run, on that run. */
export function noteCommit(place: Place, id: string | undefined, subject: string): void {
  const runId = currentRun();
  if (runId && id) addCommit(runId, { in: place, id, subject: subject.split("\n")[0] });
}

/** One commit, as the site lists it. Paths are inside the place it is in. */
export interface Change {
  in: Place;
  id: string;
  at: string;
  by: string;
  subject: string;
  /** The run that made it, when a run did. */
  run?: string;
  files: { path: string; status: string }[];
}

/** Where a place's history is: the repository, and the agent's part of it. */
async function whereIs(agent: Agent, place: Place): Promise<{ repo: string; under: string } | undefined> {
  const folder = place === "memory" ? agent.memory.folder : agent.folder;
  const repo = place === "memory" ? await memoryRepo(agent) : await repoOf(agent.folder);
  return repo && existsSync(folder) ? { repo, under: relative(repo, realpathSync(folder)) } : undefined;
}

function inside(under: string, path: string): string {
  return under ? join(under, path) : path;
}

function outOf(under: string, path: string): string {
  return under && path.startsWith(`${under}/`) ? path.slice(under.length + 1) : path;
}

const FORMAT = "--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1f";

function parseLog(text: string, place: Place, under: string): Change[] {
  return text
    .split("\x1e")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [id, at, by, subject, body, names = ""] = chunk.split("\x1f");
      return {
        in: place,
        id,
        at: new Date(at).toISOString(),
        by,
        subject,
        run: body.match(/^Run: (\S+)$/m)?.[1],
        files: names
          .split("\n")
          .filter((line) => line.includes("\t"))
          .map((line) => {
            const [status, path] = line.split("\t");
            return { path: outOf(under, path), status: status.trim() };
          }),
      };
    });
}

/**
 * The commits in one or both places, newest first: every commit to the memory,
 * and every commit to the repository that touched the agent's own folder.
 * `path` narrows it to one file, inside that place.
 */
export async function changes(
  agent: Agent,
  { place, path, limit = 50 }: { place?: Place; path?: string; limit?: number } = {},
): Promise<Change[]> {
  const places: Place[] = place ? [place] : ["memory", "folder"];
  const found: Change[] = [];
  for (const one of places) {
    const where = await whereIs(agent, one);
    if (!where) continue;
    const scope = path ? inside(where.under, path) : where.under;
    const log = await git(where.repo, [
      "log",
      `-${limit}`,
      "--no-renames",
      "--name-status",
      FORMAT,
      ...(scope ? ["--", scope] : []),
    ]);
    if (log.code === 0) found.push(...parseLog(log.out, one, where.under));
  }
  return found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** One commit, with its diff, cut to the agent's own part of the repository. */
export async function change(agent: Agent, place: Place, id: string): Promise<(Change & { diff: string }) | undefined> {
  const where = await whereIs(agent, place);
  if (!where || !/^[0-9a-f]{4,40}$/.test(id)) return undefined;
  const scope = where.under ? ["--", where.under] : [];
  const about = await git(where.repo, ["show", "--no-renames", "--name-status", FORMAT, id, ...scope]);
  if (about.code !== 0) return undefined;
  const [one] = parseLog(about.out, place, where.under);
  if (!one) return undefined;
  const shown = await git(where.repo, ["show", "--format=", "--no-renames", "--patch", id, ...scope]);
  const diff = shown.out.length > 400_000 ? `${shown.out.slice(0, 400_000)}\n...[cut here]` : shown.out;
  return { ...one, diff };
}

/**
 * Undoes one commit: every file it touched goes back to how it was before it,
 * and that is committed under this box's git name. Refused when a file has
 * changed since, because putting it back would lose that later change too.
 */
export async function undo(agent: Agent, place: Place, id: string): Promise<{ id: string | undefined; files: string[] }> {
  const where = await whereIs(agent, place);
  const found = where && (await change(agent, place, id));
  if (!where || !found) throw new Error("There is no such change.");
  const parents = (await gitOrThrow(where.repo, ["rev-list", "--parents", "-n", "1", found.id])).trim().split(" ").slice(1);
  if (parents.length === 0) throw new Error("This is the first commit there is, so there is nothing before it to go back to.");
  if (parents.length > 1) throw new Error("This commit joins two histories, so it cannot be undone from here.");

  const touched = found.files.map((file) => ({ ...file, inRepo: inside(where.under, file.path) }));
  for (const file of touched) {
    const now = await readFile(join(where.repo, file.inRepo)).catch(() => undefined);
    const then = file.status === "D" ? undefined : await showFile(where.repo, found.id, file.inRepo);
    if ((now === undefined) !== (then === undefined) || (now && then && !now.equals(then))) {
      throw new Error(`${file.path} has changed since, so undoing this would lose that change. Undo the later change first.`);
    }
  }
  for (const file of touched) {
    const before = file.status === "A" ? undefined : await showFile(where.repo, parents[0], file.inRepo);
    const at = join(where.repo, file.inRepo);
    if (before === undefined) await rm(at, { force: true });
    else {
      await mkdir(dirname(at), { recursive: true });
      await writeFile(at, before);
    }
  }
  const undone = await commitPaths(
    where.repo,
    touched.map((file) => file.inRepo),
    { message: `Undo "${found.subject}"\n\nUndoes: ${found.id}`, runId: undefined },
  );
  return { id: undone, files: touched.map((file) => file.path) };
}

/** A file's bytes at a commit, or undefined when it was not there. */
async function showFile(repo: string, id: string, path: string): Promise<Buffer | undefined> {
  return new Promise((done) =>
    execFile("git", ["show", `${id}:${path}`], { cwd: repo, encoding: "buffer", maxBuffer: 64 << 20 }, (error, out) =>
      done(error ? undefined : (out as Buffer)),
    ),
  );
}

/** When somebody last looked at this agent's changes, or undefined when nobody has. */
export function seenAt(agent: string): string | undefined {
  return (db.prepare("select at from seen where agent = ?").get(agent) as { at?: string } | undefined)?.at;
}

/** Everything this agent has changed up to now has been looked at. */
export function markSeen(agent: string): string {
  const at = new Date().toISOString();
  db.prepare("insert into seen (agent, at) values (?, ?) on conflict (agent) do update set at = excluded.at").run(agent, at);
  return at;
}
