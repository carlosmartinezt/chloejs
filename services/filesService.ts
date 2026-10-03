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
import { realpathSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

import { confine, unreachable } from "#chloe/core/confine";
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

/**
 * Search a folder for text, case-insensitive. `folder` narrows it. Paths in
 * the results are relative to `root`, the way the other functions here take
 * them. With `around`, each match comes with that many lines either side, and
 * matches close together in one file share one block, so a match can often be
 * understood without reading the file. Five matches a file at most, and
 * `results` stops at 80 matches, or 30 with `around`; `matches` counts what
 * was found before that.
 */
export async function searchFiles(root: string, query: string, folder?: string, { around = 0 }: { around?: number } = {}) {
  const base = realpathSync(root);
  const target = folder ? confine(root, folder) : base;
  // ripgrep if the box has it, grep otherwise. An earlier version assumed
  // ripgrep, and when it was not installed every search quietly answered
  // "nothing matched", which reads exactly like a subject he never wrote
  // about. A search that cannot run has to say so.
  const attempts: Array<[string, string[]]> = [
    ["rg", ["-i", "--no-heading", "--with-filename", "--line-number", "--max-count", "5", "--glob", "!.git", "--", query, target]],
    ["grep", ["-rIHin", "--exclude-dir=.git", "--max-count=5", "-e", query, target]],
  ];
  for (const [file, args] of attempts) {
    const r = await run(file, args, { timeoutMs: 60_000 });
    // grep and rg both exit 1 for "no matches", which is an answer. Only a
    // missing binary (127) means try the next one.
    if (r.exitCode === 127) continue;
    const found = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = /^(.*?):(\d+):(.*)$/s.exec(line);
        return m ? { path: relative(base, m[1]), line: Number(m[2]), text: m[3] } : undefined;
      })
      // The folders no file tool may open are not searched into either.
      .filter((m): m is { path: string; line: number; text: string } => m !== undefined && !m.path.split(sep).some(unreachable));
    const kept = found.slice(0, around > 0 ? 30 : 80);
    return {
      searchedWith: file,
      matches: found.length,
      results: around > 0 ? await withLinesAround(root, kept, around) : kept.map((m) => `${m.path}:${m.line}:${m.text}`),
      note:
        found.length === 0
          ? "Nothing matched. Try the words he would have written."
          : found.length > kept.length
            ? `Only the first ${kept.length} of ${found.length} matches. Narrow it with folder or a longer phrase.`
            : undefined,
    };
  }
  throw new Error("Neither rg nor grep is on this box, so nothing can be searched.");
}

/**
 * One block of text per run of nearby matches in a file: the path and line
 * numbers, then each line numbered, with `>` on the lines that matched. A line
 * longer than 300 characters is cut, because one line of minified HTML would
 * otherwise be the whole file again.
 */
async function withLinesAround(root: string, found: Array<{ path: string; line: number }>, around: number) {
  const blocks: string[] = [];
  const byFile = new Map<string, number[]>();
  for (const m of found) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m.line]);
  for (const [path, hits] of byFile) {
    const all = (await readFile(confine(root, path), "utf8").catch(() => "")).split("\n");
    const runs: Array<[number, number]> = [];
    for (const hit of hits.sort((a, b) => a - b)) {
      const start = Math.max(1, hit - around);
      const end = Math.min(all.length, hit + around);
      const last = runs.at(-1);
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else runs.push([start, end]);
    }
    for (const [start, end] of runs) {
      const lines = all.slice(start - 1, end).map((text, i) => {
        const n = start + i;
        const cut = text.length > 300 ? `${text.slice(0, 300)}...` : text;
        return `${hits.includes(n) ? ">" : " "} ${n}| ${cut}`;
      });
      blocks.push(`${path}:${start}-${end}\n${lines.join("\n")}`);
    }
  }
  return blocks;
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
