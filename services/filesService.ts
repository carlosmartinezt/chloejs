// Reading and writing files inside one folder.
//
// `list`, `read`, `search`, `write` and `edit` are what a job calls from a step. A job
// that knows which file it wants should call one of these: going through a
// model to read a path you already know is two seconds and a price for
// nothing. The tools over them are model/tools/files.ts.
//
// They know nothing about what is in the folder: no list of subfolders, no
// file format, no house rules. All of that is an agent's instructions or a
// skill, which is text you can edit, not code that needs a restart.
//
// What they do enforce is the edge of the folder, through confine().
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { confine } from "#chloe/core/confine";
import { commitPaths, noteCommit, type Place } from "./historyService.ts";
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

/**
 * Read one file. `path` is relative to `root` and cannot leave it.
 *
 * With `from` (the first line, counting from 1) or `lines` (how many), only
 * that part comes back, with `from`, `to` and the file's `totalLines`. With
 * `limit` (characters) and no range, a longer file comes back cut at the last
 * whole line that fits, saying so, so a big file is not read whole by
 * accident. With none of the three it is the whole file, as it always was.
 */
export async function readFiles(
  root: string,
  path: string,
  { from, lines, limit }: { from?: number; lines?: number; limit?: number } = {},
) {
  const resolved = confine(root, path);
  const content = await readFile(resolved, "utf8");
  const ranged = from !== undefined || lines !== undefined;
  if (!ranged && (limit === undefined || content.length <= limit)) {
    return { path: resolved, bytes: content.length, content };
  }
  const all = content.split("\n");
  const start = Math.max(1, from ?? 1);
  let end = lines !== undefined ? Math.min(all.length, start + Math.max(1, lines) - 1) : all.length;
  if (!ranged) {
    let size = 0;
    end = 0;
    while (end < all.length && size + all[end].length + 1 <= limit!) size += all[end++].length + 1;
    end = Math.max(end, 1);
  }
  // A file that is one long line (minified HTML) still has to stop at the limit.
  const whole = all.slice(start - 1, end).join("\n");
  const part = !ranged && whole.length > limit! ? whole.slice(0, limit) : whole;
  return {
    path: resolved,
    bytes: content.length,
    totalLines: all.length,
    from: start,
    to: Math.max(start - 1, end),
    content: part,
    note:
      start > all.length
        ? `The file has only ${all.length} lines.`
        : part.length < whole.length
          ? `This is the first ${part.length} characters of line 1, which is longer than one read. Search to find what you need in it.`
          : end < all.length
            ? `This is lines ${start} to ${end} of ${all.length}. Ask for from and lines to read another part, or search to find where something is.`
            : undefined,
  };
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
 * Write one file, replacing it, or with `append` adding to the end of it on a
 * line of its own, so a long file that only grows is never written out whole.
 * `commit` makes the write a git commit of that file alone, for a folder in a
 * repo, and then `message` is required. `author` is the agent it is written
 * under, and `in` which of its places this is, so the run writing it lists
 * the commit. Without an author it is this box's own git name.
 */
export async function writeFiles(
  root: string,
  path: string,
  content: string,
  {
    commit = false,
    message,
    append = false,
    author,
    in: place,
  }: { commit?: boolean; message?: string; append?: boolean; author?: string; in?: Place } = {},
) {
  if (commit && (message ?? "").length < 10) {
    throw new Error("This folder is a repo, so every write needs a commit message.");
  }
  const resolved = confine(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  if (append) {
    const before = await readFile(resolved, "utf8").catch(() => "");
    await appendFile(resolved, before && !before.endsWith("\n") ? `\n${content}` : content, "utf8");
  } else {
    await writeFile(resolved, content, "utf8");
  }
  if (!commit) return { path: resolved, bytes: content.length };
  const committed = await commitPaths(root, [resolved], { message: message!, author }).then(
    (id) => {
      if (place) noteCommit(place, id, message!);
      return id ? id.slice(0, 12) : "nothing changed, so nothing was committed";
    },
    (error: unknown) => `not committed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { path: resolved, bytes: content.length, commit: committed };
}

/**
 * Change one part of a file: `old` must appear in it exactly once, and is
 * replaced by `new`, so a small change to a big file never sends the whole
 * file. Throws when `old` is not there or is there more than once, saying
 * which, so the caller can add the text around it. An empty `new` deletes
 * `old`. `commit`, `message`, `author` and `in` are as for writeFiles.
 */
export async function editFiles(
  root: string,
  path: string,
  old: string,
  replacement: string,
  options: { commit?: boolean; message?: string; author?: string; in?: Place } = {},
) {
  if (old.length === 0) throw new Error("Say which text to replace: `old` is empty.");
  const resolved = confine(root, path);
  const before = await readFile(resolved, "utf8");
  const first = before.indexOf(old);
  if (first === -1) {
    throw new Error(
      "That text is not in the file. It has to match exactly, spaces, line breaks and HTML entities " +
        "included: read the file again and copy it.",
    );
  }
  if (before.indexOf(old, first + 1) !== -1) {
    const times = before.split(old).length - 1;
    throw new Error(`That text is in the file ${times} times. Include more of the lines around it so it is found once.`);
  }
  const after = before.slice(0, first) + replacement + before.slice(first + old.length);
  const written = await writeFiles(root, path, after, options);
  const line = before.slice(0, first).split("\n").length;
  return { ...written, line };
}
