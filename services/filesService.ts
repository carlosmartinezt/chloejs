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
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { confine, unreachable } from "#chloe/core/confine";
import { commitPaths, noteCommit, type Place } from "./historyService.ts";
import { run } from "./runService.ts";

/**
 * Lists what is in one folder.
 *
 * - `root`: the folder you allow. Nothing outside it can be listed.
 * - `path`: a folder inside `root`, relative to it. If not set, `root` itself.
 *
 * Returns `{ path, entries }`: the full path of the folder it listed, and the
 * names in it, sorted. A folder's name ends with `/`. Hidden names (starting
 * with `.`) are left out.
 *
 * Throws if `path` is outside `root`, goes into `.git`, `.ssh`, `secrets` or
 * `node_modules`, or does not exist.
 */
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
 * Draws the folders inside `root` as lines of text, one folder per line. Each
 * level down is indented two more spaces.
 *
 * - `root`: the folder to start from.
 * - `options.depth`: how many levels down to go. Default: 2.
 * - `options.most`: the most folders to show. Default: 200. If there are more, the last line is `(more folders, left out)`.
 *
 * Files are left out, and so are hidden folders (starting with `.`) and
 * `secrets` and `node_modules`.
 *
 * Returns the lines, such as `["notes/", "  2026/", "projects/"]`. A folder
 * it cannot read is skipped, so it does not throw. If `root` does not exist,
 * the list is empty.
 */
export async function folderTree(root: string, { depth = 2, most = 200 } = {}): Promise<string[]> {
  const lines: string[] = [];
  let more = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !unreachable(e.name)).map((e) => e.name).sort();
    for (const name of folders) {
      if (lines.length >= most) {
        more = true;
        return;
      }
      lines.push(`${"  ".repeat(level)}${name}/`);
      if (level + 1 < depth) await walk(join(dir, name), level + 1);
    }
  };
  await walk(root, 0);
  if (more) lines.push("(more folders, left out)");
  return lines;
}

/**
 * Reads one text file.
 *
 * - `root`: the folder you allow. The file must be inside it.
 * - `path`: the file, relative to `root`. Its full path also works, if it is inside `root`.
 * - `options.from`: the first line to read, counting from 1.
 * - `options.lines`: how many lines to read.
 * - `options.limit`: the most characters to return, when you give neither `from` nor `lines`.
 *
 * With no options, it returns the whole file as `{ path, bytes, content }`:
 * the full path, the file's length in characters, and its text.
 *
 * With `from` or `lines`, `content` holds only those lines. The result also
 * has `totalLines`, and `from` and `to` (the first and last line returned).
 * With `limit`, a longer file is cut at the last whole line that fits. In
 * both cases, `note` says when there is more to read.
 *
 * Throws if `path` is outside `root`, goes into `.git`, `.ssh`, `secrets` or
 * `node_modules`, or does not exist.
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
 * Searches the text files in a folder for some words.
 *
 * - `root`: the folder you allow. Nothing outside it is searched.
 * - `query`: the words to find. Upper and lower case are the same, and the words are matched exactly as written (not as a pattern).
 * - `folder`: a folder or one file inside `root`, to search only there. If not set, all of `root`.
 * - `options.around`: how many lines before and after each match to show. Default: 0.
 *
 * It looks in every file and folder inside, hidden ones too, except `.git`,
 * `.ssh`, `secrets` and `node_modules`. It skips files that are not text and
 * files over 20 MB. It finds at most 5 matches in each file.
 *
 * Returns `{ matches, results, note }`:
 * - `matches`: how many matches it found.
 * - `results`: with `around` at 0, one line per match, as `path:line:text`. With `around`, one block of text for each group of nearby matches, with line numbers, and `>` on the lines that matched. At most 80 matches, or 30 with `around`. Paths are relative to `root`.
 * - `note`: set when nothing matched or when some matches were left out.
 *
 * Throws if `folder` is outside `root` or does not exist.
 */
export async function searchFiles(root: string, query: string, folder?: string, { around = 0 }: { around?: number } = {}) {
  const base = realpathSync(root);
  const target = folder ? confine(root, folder) : base;
  const wanted = query.toLowerCase();
  const found: Array<{ path: string; line: number; text: string }> = [];
  for (const file of await filesUnder(target)) {
    const text = await readFile(file, "utf8").catch(() => "");
    // A file with a NUL in its start is not text, as grep has it.
    if (text.slice(0, 8000).includes("\0")) continue;
    let inFile = 0;
    for (const [i, line] of text.split("\n").entries()) {
      if (!line.toLowerCase().includes(wanted)) continue;
      found.push({ path: relative(base, file), line: i + 1, text: line });
      if (++inFile === 5) break;
    }
  }
  const kept = found.slice(0, around > 0 ? 30 : 80);
  return {
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

/** Largest file a search reads, in bytes. Bigger ones are left out rather than read into memory. */
const SEARCHED = 20_000_000;

/**
 * Every file under `target`, or `target` itself when it is a file, in name
 * order. Links are not followed, and the folders no file tool may open are
 * not searched into.
 */
async function filesUnder(target: string): Promise<string[]> {
  const top = await stat(target);
  if (top.isFile()) return top.size <= SEARCHED ? [target] : [];
  const files: string[] = [];
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (unreachable(entry.name)) continue;
    const path = join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && (await stat(path)).size <= SEARCHED) files.push(path);
  }
  return files;
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
 * Writes one text file, and makes any folders it needs.
 *
 * - `root`: the folder you allow. The file must be inside it.
 * - `path`: the file, relative to `root`.
 * - `content`: the text to write.
 * - `options.append`: adds `content` to the end of the file, on a new line, instead of replacing the file. Off by default.
 * - `options.commit`: saves the change as a git commit of this one file. Other changes in the repository stay as they were. Off by default.
 * - `options.message`: the commit message, at least 10 characters. Required when `commit` is `true`.
 * - `options.author`: the name the commit is made under, usually the agent's id. If not set, the git user set on this machine.
 * - `options.in`: `"memory"` if the file is in the agent's memory, `"folder"` if it is in the agent's own folder. If set, and a run is going, the run's record lists the commit.
 *
 * Returns `{ path, bytes }`: the full path, and the length of `content` in
 * characters. With `commit`, it also has `commit`: the commit's id, or words
 * saying why nothing was committed (for example, `root` is not in a git
 * repository). A commit that fails does not throw: the file is still written.
 *
 * Throws if `path` is outside `root` or goes into `.git`, `.ssh`, `secrets` or
 * `node_modules`, or if `commit` is `true` and `message` is shorter than 10
 * characters.
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
 * Replaces one piece of text in a file, and leaves the rest as it was.
 *
 * - `root`: the folder you allow. The file must be inside it.
 * - `path`: the file, relative to `root`.
 * - `old`: the text to replace. It must be in the file exactly once, spaces and line breaks included.
 * - `replacement`: the new text. An empty string deletes `old`.
 * - `options`: `commit`, `message`, `author` and `in`, the same as for `writeFiles`.
 *
 * Returns the same as `writeFiles`, plus `line`: the line where the change
 * starts.
 *
 * Throws if `old` is empty, is not in the file, or is in the file more than
 * once (the message says how many times). Also throws if the file does not
 * exist, and for the same reasons as `writeFiles`.
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
