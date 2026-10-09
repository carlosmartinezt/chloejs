// What npx chloe setup needs from git. chloe keeps every change an agent makes
// to its own folder as a commit, so in a folder that is not a repository there
// is nothing to undo, and an agent cannot change itself at all: a file nobody
// has committed is refused. Setup never installs git; it says how.
import { spawnSync } from "node:child_process";

/** Who the first commit is under when git has no name of its own here. */
const SETUP = "npx chloe setup";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string } {
  const done = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { ok: !done.error && done.status === 0, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
}

/** Whether git can be run here at all. */
export function hasGit(): boolean {
  return git(process.cwd(), ["--version"]).ok;
}

/** Whether git has a name and an email to commit under in `cwd`. */
export function hasGitName(cwd: string): boolean {
  return Boolean(git(cwd, ["config", "user.name"]).out && git(cwd, ["config", "user.email"]).out);
}

/** The top of the repository `cwd` is in, or "" when it is in none. */
export function repositoryOf(cwd: string): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.ok ? top.out : "";
}

/**
 * Makes `cwd` a repository and commits everything in it that .gitignore does
 * not leave out, as its first commit. Under git's own name when it has one,
 * else under "npx chloe setup", so it works where git has no name. Throws with
 * git's own words when it fails.
 */
export function firstCommit(cwd: string): void {
  const named = hasGitName(cwd);
  const env = named
    ? process.env
    : { ...process.env, GIT_AUTHOR_NAME: SETUP, GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: SETUP, GIT_COMMITTER_EMAIL: "" };
  const steps: [string, string[]][] = [
    ["init", ["init", "-q", "-b", "main"]],
    ["add", ["add", "-A"]],
    ["commit", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "The project, as npx chloe setup left it"]],
  ];
  for (const [step, args] of steps) {
    const done = git(cwd, args, env);
    if (!done.ok) throw new Error(`git ${step} failed: ${done.err.split("\n")[0] || "no reason given"}`);
  }
}

/** Which of `paths`, inside `cwd`, have changes nobody has committed, new files included. */
export function uncommittedIn(cwd: string, paths: string[]): string[] {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  return status.ok ? status.out.split("\n").filter(Boolean).map((line) => line.slice(3)) : [];
}
