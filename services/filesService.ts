// Reading and writing files inside one folder.
//
// `list`, `read`, `search`, `write` and `edit` are what a job calls from a step. A job
// that knows which file it wants should call one of these: going through a
// model to read a path you already know is two seconds and a price for
// nothing. The tools over them are model/tools/files.ts.
//
// They know nothing about what is in the folder: no list of subfolders, no
// file format, no house rules. All of that is an agent's purpose or a
// skill, which is text you can edit, not code that needs a restart.
//
// What they do enforce is the edge of the folder, through confine().
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { confine, unreachable } from "#chloe/core/confine";
import { commitPaths, noteCommit, type Place } from "./historyService.ts";
import { run } from "./runService.ts";

/** Whether a full path is shown: a file, or a folder with one shown inside it. */
export type Shows = (path: string) => boolean;

/**
 * What git shows under `root`: the files it tracks or would add, and the
 * folders that hold one, so what `.gitignore` leaves out (`.env.local`,
 * `dist/`, `data/`) is left out here too. Undefined when `root` is in no git
 * repository, so every file is shown. Asked again on every call, so a new
 * file is seen at once.
 */
export async function gitShows(root: string): Promise<Shows | undefined> {
  const base = realpathSync(root);
  const listed = await promisify(execFile)("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: base,
    maxBuffer: 1024 * 1024 * 64,
    encoding: "utf8",
  }).catch(() => undefined);
  if (!listed) return undefined;
  const shown = new Set<string>([""]);
  for (const file of listed.stdout.split("\0").filter(Boolean)) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) shown.add(parts.slice(0, i).join(sep));
  }
  return (path) => shown.has(relative(base, path)) || shown.has(relative(root, path));
}

/**
 * Lists what is in one folder.
 *
 * - `root`: the folder you allow. Nothing outside it can be listed.
 * - `path`: a folder inside `root`, relative to it. If not set, `root` itself.
 * - `options.shows`: when given, only what it shows is listed (see `gitShows`).
 *
 * Returns `{ path, entries }`: the full path of the folder it listed, and the
 * names in it, sorted. A folder's name ends with `/`. Hidden names (starting
 * with `.`), the folders no file tool may open and the state folder are left
 * out.
 *
 * Throws if `path` is outside `root`, goes into `.git`, `.ssh`, `secrets` or
 * `node_modules`, or does not exist.
 */
export async function listFiles(root: string, path?: string, { shows }: { shows?: Shows } = {}) {
  const resolved = path ? confine(root, path) : root;
  if (shows && !shows(resolved)) throw new Error(`${path} is left out by git, so it is not listed here.`);
  const entries = await readdir(resolved, { withFileTypes: true });
  return {
    path: resolved,
    entries: entries
      .filter((e) => !e.name.startsWith(".") && !unreachable(e.name, join(resolved, e.name)) && (!shows || shows(join(resolved, e.name))))
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
 * - `options.shows`: when given, only the folders it shows (see `gitShows`).
 *
 * Files are left out, and so are hidden folders (starting with `.`) and
 * `secrets` and `node_modules`.
 *
 * Returns the lines, such as `["notes/", "  2026/", "projects/"]`. A folder
 * it cannot read is skipped, so it does not throw. If `root` does not exist,
 * the list is empty.
 */
export async function folderTree(root: string, { depth = 2, most = 200, shows }: { depth?: number; most?: number; shows?: Shows } = {}): Promise<string[]> {
  const lines: string[] = [];
  let more = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !unreachable(e.name, join(dir, e.name)) && (!shows || shows(join(dir, e.name))))
      .map((e) => e.name)
      .sort();
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
 * - `options.shows`: when given, a file it does not show is refused (see `gitShows`).
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
  { from, lines, limit, shows }: { from?: number; lines?: number; limit?: number; shows?: Shows } = {},
) {
  const resolved = confine(root, path);
  if (shows && !shows(resolved)) throw new Error(`${path} is left out by git, so it is not readable here.`);
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
 * What `readFiles` returned, as a model is shown it: a line with `path` and
 * which of its lines these are, the note when there is more, then the text
 * just as it is in the file. Shown as JSON, every line break and quote comes
 * escaped, and a model copying text back out of it for a change gets the
 * spaces wrong.
 */
export function readAsText(path: string, read: Awaited<ReturnType<typeof readFiles>>): string {
  const which =
    "totalLines" in read && read.totalLines !== undefined ? `lines ${read.from} to ${read.to} of ${read.totalLines}` : "all of it";
  const note = "note" in read && read.note ? `${read.note}\n` : "";
  return `${path}, ${which}:\n${note}\n${read.content}`;
}

/**
 * Searches the text files in a folder for some words.
 *
 * - `root`: the folder you allow. Nothing outside it is searched.
 * - `query`: the words to find. Upper and lower case are the same, and the words are matched exactly as written (not as a pattern).
 * - `folder`: a folder or one file inside `root`, to search only there. If not set, all of `root`.
 * - `options.around`: how many lines before and after each match to show. Default: 0.
 * - `options.shows`: when given, only the files it shows are searched (see `gitShows`).
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
export async function searchFiles(root: string, query: string, folder?: string, { around = 0, shows }: { around?: number; shows?: Shows } = {}) {
  const base = realpathSync(root);
  const target = folder ? confine(root, folder) : base;
  const wanted = query.toLowerCase();
  const found: Array<{ path: string; line: number; text: string }> = [];
  for (const file of await filesUnder(target, shows)) {
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
 * order. Links are not followed, and the folders no file tool may open, or
 * that `shows` leaves out, are not searched into.
 */
async function filesUnder(target: string, shows?: Shows): Promise<string[]> {
  const top = await stat(target);
  if (top.isFile()) return top.size <= SEARCHED && (!shows || shows(target)) ? [target] : [];
  const files: string[] = [];
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(target, entry.name);
    if (unreachable(entry.name, path) || (shows && !shows(path))) continue;
    if (entry.isDirectory()) files.push(...(await filesUnder(path, shows)));
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
  checkMessage({ commit, message });
  const resolved = confine(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  if (append) {
    const before = await readFile(resolved, "utf8").catch(() => "");
    await appendFile(resolved, before && !before.endsWith("\n") ? `\n${content}` : content, "utf8");
  } else {
    await writeFile(resolved, content, "utf8");
  }
  return { path: resolved, bytes: content.length, ...(await commitIf(root, [resolved], { commit, message, author, in: place })) };
}

type CommitOptions = { commit?: boolean; message?: string; author?: string; in?: Place };

/**
 * Moves or renames a file or a folder inside `root`, making the folders above
 * `to` when they are not there.
 *
 * - `options`: `commit`, `message`, `author` and `in`, the same as for
 *   `writeFiles`. Both places are one commit, so a file changed without a
 *   commit and then moved is committed with the move.
 *
 * Returns `{ path, to }`, both full paths, and `commit` as `writeFiles` does.
 *
 * Throws if either is outside `root` or is `root` itself, if `path` is not
 * there, or if `to` already is.
 */
export async function moveFiles(root: string, path: string, to: string, options: CommitOptions = {}) {
  checkMessage(options);
  const { from, target } = await canMove(root, path, to);
  await mkdir(dirname(target), { recursive: true });
  await rename(from, target);
  return { path: from, to: target, ...(await commitIf(root, [from, target], options)) };
}

/**
 * Throws for each reason `moveFiles` would, without moving anything, so a
 * caller can check before it changes the file. Returns both full paths.
 */
export async function canMove(root: string, path: string, to: string): Promise<{ from: string; target: string }> {
  const from = belowRoot(root, path);
  const target = belowRoot(root, to);
  await stat(from);
  if (await stat(target).then(() => true, () => false)) throw new Error(`${to} is already there. Pick another place, or delete it first.`);
  return { from, target };
}

/**
 * Deletes a file, or a folder and everything in it, inside `root`.
 *
 * - `options`: the same as for `writeFiles`. Committed, the file is still in
 *   the history and can be brought back.
 *
 * Returns `{ path }`, the full path, and `commit` as `writeFiles` does.
 *
 * Throws if `path` is outside `root`, is `root` itself, or is not there.
 */
export async function deleteFiles(root: string, path: string, options: CommitOptions = {}) {
  checkMessage(options);
  const resolved = belowRoot(root, path);
  await stat(resolved);
  await rm(resolved, { recursive: true });
  return { path: resolved, ...(await commitIf(root, [resolved], options)) };
}

/** `confine`, refusing `root` itself, so one call cannot move or delete the whole folder. */
function belowRoot(root: string, path: string): string {
  const resolved = confine(root, path);
  if (resolved === realpathSync(root)) throw new Error("That is the whole folder. Name a file or a folder inside it.");
  return resolved;
}

function checkMessage({ commit, message }: CommitOptions) {
  if (commit && (message ?? "").length < 10) throw new Error("This folder is a repo, so every write needs a commit message.");
}

/** Commits `paths` when `commit` is set. A commit that fails does not throw: `commit` says why. */
async function commitIf(root: string, paths: string[], { commit, message, author, in: place }: CommitOptions): Promise<{ commit?: string }> {
  if (!commit) return {};
  const committed = await commitPaths(root, paths, { message: message!, author }).then(
    (id) => {
      if (place) noteCommit(place, id, message!);
      return id ? id.slice(0, 12) : "nothing changed, so nothing was committed";
    },
    (error: unknown) => `not committed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { commit: committed };
}

/**
 * Makes one or more changes to a file, and leaves the rest as it was. Each
 * change replaces one piece of text, or with no `old` adds its text to the
 * end of the file, or makes the file when it is not there. They are made in
 * order, each on the file as the ones before it left it, and written once: if
 * any cannot be made, none are.
 *
 * - `root`: the folder you allow. The file must be inside it.
 * - `path`: the file, relative to `root`.
 * - `changes`: each `{ old, new }`. `old` is the text to replace, and must be
 *   in the file exactly once. When it is not there as written, it is looked
 *   for again with the spaces and tabs at the start and end of each line
 *   ignored, and that must find it once. `new` replaces it, and an empty
 *   string deletes it.
 * - `options`: `commit`, `message`, `author` and `in`, the same as for
 *   `writeFiles`. All the changes are one commit.
 *
 * Returns the same as `writeFiles`, plus `lines`: the line where each change
 * starts, or 0 for text added to the end.
 *
 * Throws if an `old` is not in the file, or is in it more than once (the
 * message says which change, and how many times). Also throws if a change has
 * an `old` and the file does not exist, and for the same reasons as
 * `writeFiles`.
 */
export async function editFiles(
  root: string,
  path: string,
  changes: { old?: string; new: string }[],
  options: { commit?: boolean; message?: string; author?: string; in?: Place } = {},
) {
  if (changes.length === 0) throw new Error("There is nothing to change: `changes` is empty.");
  const resolved = confine(root, path);
  let text = await readFile(resolved, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && changes.every((change) => change.old === undefined)) return "";
    throw error;
  });
  const lines: number[] = [];
  for (const [n, change] of changes.entries()) {
    try {
      const made = changed(text, change.old, change.new);
      text = made.text;
      lines.push(made.line);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(changes.length === 1 ? why : `Change ${n + 1} of ${changes.length}: ${why} None of the changes were made.`);
    }
  }
  return { ...(await writeFiles(root, path, text, options)), lines };
}

/** `text` with one change made, and the line it starts on (0 when added to the end). Throws when it cannot be made. */
function changed(text: string, old: string | undefined, replacement: string): { text: string; line: number } {
  if (old === undefined) {
    if (replacement.length === 0) throw new Error("There is nothing to add: `new` is empty.");
    return { text: text && !text.endsWith("\n") ? `${text}\n${replacement}` : text + replacement, line: 0 };
  }
  if (old.length === 0) throw new Error("Say which text to replace: `old` is empty.");
  let first = text.indexOf(old);
  let length = old.length;
  let times = first === -1 ? 0 : text.split(old).length - 1;
  if (first === -1 && old.trim()) {
    const found = [...text.matchAll(loosely(old))];
    times = found.length;
    if (times === 1) {
      first = found[0].index!;
      length = found[0][0].length;
      // The match starts after the file's own indent, so the indent the model
      // gave the first line would be added to it.
      const lead = /^[ \t]*/.exec(old)![0];
      if (lead && replacement.startsWith(lead)) replacement = replacement.slice(lead.length);
    }
  }
  if (times === 0) throw new Error(notFound(text, old));
  if (times > 1) {
    throw new Error(`That text is in the file ${times} times. Include more of the lines around it so it is found once.`);
  }
  return {
    text: text.slice(0, first) + replacement + text.slice(first + length),
    line: text.slice(0, first).split("\n").length,
  };
}

/**
 * `text` as a pattern that ignores the spaces and tabs at the start and end of
 * each of its lines. Models often copy a line with the indent its neighbours
 * have rather than the one it has.
 */
function loosely(text: string): RegExp {
  const lines = text.split("\n").map((line) => line.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A last line that is empty is the end of the text, and the next line's indent is not part of it.
  const pattern = lines
    .map((line, n) => (n === 0 || (n === lines.length - 1 && !line) ? line : `[ \\t]*${line}`))
    .join("[ \\t]*\\r?\\n");
  return new RegExp(pattern, "g");
}

/** Why `old` was not found in `text`, naming the first of its lines that is not there. */
function notFound(text: string, old: string): string {
  const missing = old.split("\n").map((line) => line.trim()).find((line) => line && !text.includes(line));
  if (missing === undefined) {
    return "That text is not in the file: each of its lines is, but not together in that order. Read that part of the file again and copy it.";
  }
  const shown = missing.length > 200 ? `${missing.slice(0, 200)}...` : missing;
  return (
    `That text is not in the file: this line of it is not there: ${JSON.stringify(shown)}. ` +
    "Read that part of the file again and copy it, HTML entities included."
  );
}
