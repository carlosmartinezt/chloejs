// Reading and writing files inside one folder.
//
// `list`, `read`, `search` and `write` are what a job calls from a step. A job
// that knows which file it wants should call one of these: going through a
// model to read a path you already know is two seconds and a price for
// nothing. The tools over them are model/tools/files.ts.
//
// They know nothing about what is in the folder: no list of subfolders, no
// file format, no house rules. All of that is an agent's instructions or a
// skill, which is text you can edit, not code that needs a restart.
//
// What they do enforce is the edge of the folder, through confine().
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { confine } from "#chloe/core/confine.ts";
import { run } from "./runService.ts";

/** List a folder. `path` is relative to `root`, and omitting it means the top. */
export async function listFiles(root: string, path?: string) {
  const resolved = path ? confine(root, path) : root;
  const entries = await readdir(resolved, { withFileTypes: true });
  return {
    path: resolved,
    entries: entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort(),
  };
}

/** Read one file. `path` is relative to `root` and cannot leave it. */
export async function readFiles(root: string, path: string) {
  const resolved = confine(root, path);
  const content = await readFile(resolved, "utf8");
  return { path: resolved, bytes: content.length, content };
}

/** Search a folder for text, case-insensitive. `folder` narrows it. */
export async function searchFiles(root: string, query: string, folder?: string) {
  const target = folder ? confine(root, folder) : root;
  // ripgrep if the box has it, grep otherwise. An earlier version assumed
  // ripgrep, and when it was not installed every search quietly answered
  // "nothing matched", which reads exactly like a subject he never wrote
  // about. A search that cannot run has to say so.
  const attempts: Array<[string, string[]]> = [
    ["rg", ["-i", "--no-heading", "--line-number", "--max-count", "5", "--glob", "!.git", "--", query, target]],
    ["grep", ["-rIin", "--exclude-dir=.git", "--max-count=5", "-e", query, target]],
  ];
  for (const [file, args] of attempts) {
    const r = await run(file, args, { timeoutMs: 60_000 });
    // grep and rg both exit 1 for "no matches", which is an answer. Only a
    // missing binary (127) means try the next one.
    if (r.exitCode === 127) continue;
    const lines = r.stdout.split("\n").filter(Boolean).slice(0, 80);
    return {
      searchedWith: file,
      matches: lines.length,
      results: lines,
      note: lines.length === 0 ? "Nothing matched. Try the words he would have written." : undefined,
    };
  }
  throw new Error("Neither rg nor grep is on this box, so nothing can be searched.");
}

/**
 * Write one file, replacing it. `commit` makes the write a git commit, for a
 * folder that is a repo, and then `message` is required.
 */
export async function writeFiles(
  root: string,
  path: string,
  content: string,
  { commit = false, message }: { commit?: boolean; message?: string } = {},
) {
  if (commit && (message ?? "").length < 10) {
    throw new Error("This folder is a repo, so every write needs a commit message.");
  }
  const resolved = confine(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  if (!commit) return { path: resolved, bytes: content.length };
  const committed = await new Promise<string>((done) => {
    execFile("git", ["-C", root, "add", "--", resolved], { timeout: 30_000 }, () =>
      execFile(
        "git",
        ["-C", root, "commit", "-m", message!, "--", resolved],
        { timeout: 30_000, encoding: "utf8" },
        (error: unknown, out: string, err: string) =>
          done(error ? `not committed: ${err || out}` : out.trim()),
      ),
    );
  });
  return { path: resolved, bytes: content.length, commit: committed };
}
