// The tools over services/filesService.ts: one folder, offered to a model.
//
// An agent binds each one to a root it is allowed to see, and names that
// folder in plain words for the description.
//
//   import * as fs from "@chloejs/core/tools/fs";
//   tools: { fsReadFile: fs.readFile({ root: "/srv/notes", what: "the shared notes" }) }
import { tool } from "ai";
import { z } from "zod";

import * as files from "#chloe/services/filesService";

/** The folder a file tool works in. Every `fs` tool takes these two options. */
interface Folder {
  /**
   * The full path of the folder the model can use, such as `"/srv/notes"`.
   * The model cannot reach anything outside it, even through a link. Files
   * and folders named `.git`, `.ssh`, `secrets` and `node_modules` are always
   * refused. Required.
   */
  root: string;
  /** A few words for the folder, such as `"the shared notes"`. Used in the tool's description for the model. Required. */
  what: string;
}

/**
 * Makes a tool that lets the model list the files and folders in one folder
 * inside `root`. Hidden files (names starting with `.`) are left out.
 *
 * The model also gets a map of the folders in `root`, two levels deep, at the
 * start of each reply, so it knows the layout before its first call.
 *
 * Needs no connection.
 *
 * ```ts
 * tools: { fsListFiles: fs.listFiles({ root: "/srv/notes", what: "the shared notes" }) }
 * ```
 */
export function listFiles({ root, what }: Folder) {
  const list = tool({
    description: `List a folder in ${what}, so you can find the right file before reading it. Start here rather than guessing at a path.`,
    inputSchema: z.object({
      path: z.string().optional().describe("Folder to list. Omit for the top level."),
    }),
    execute: ({ path }) => files.listFiles(root, path),
  });
  const overview = async () => {
    const tree = await files.folderTree(root);
    if (!tree.length) return "";
    return (
      `## The folders in ${what}\n\n` +
      `Two levels down, without the files. These are the only folders there are at those levels: ` +
      `list one for what is inside it, and never guess at a path that is not here.\n\n` +
      "```\n" + tree.join("\n") + "\n```"
    );
  };
  return Object.assign(list, { overview, onlyReads: true });
}

/**
 * Makes a tool that lets the model read one file inside `root`, or some of
 * its lines.
 *
 * `limit` is the most characters the model gets when it reads a whole file.
 * A longer file is cut at the end of a line, and the model is told how many
 * lines the file has, so it can ask for the part it needs. Default: 40,000
 * (about 10,000 tokens).
 */
export function readFile({ root, what, limit = 40_000 }: Folder & { limit?: number }) {
  return Object.assign(tool({
    description:
      `Read one file from ${what}, or part of it. Read before answering, and read before writing: guessing ` +
      `from memory is how you end up confidently wrong. A long file comes back cut, saying how many lines it ` +
      `has; then ask for the part you need with from and lines, or search first to find where it is.`,
    inputSchema: z.object({
      path: z.string(),
      from: z.number().int().min(1).optional().describe("First line to read, counting from 1."),
      lines: z.number().int().min(1).optional().describe("How many lines to read from there."),
    }),
    execute: ({ path, from, lines }) => files.readFiles(root, path, { from, lines, limit }),
  }), { onlyReads: true });
}

/**
 * Makes a tool that lets the model search the text of the files inside
 * `root`. The search ignores upper and lower case, and looks for the exact
 * words given (not a pattern). Each result has its file and line number.
 *
 * `around` is how many lines before and after each match the model gets with
 * it. Default: 2. The model gets at most 5 matches per file, and 30 in all
 * (80 when `around` is 0).
 */
export function searchFiles({ root, what, around = 2 }: Folder & { around?: number }) {
  return Object.assign(tool({
    description:
      `Search ${what} for text, and return each match with the lines around it and their line numbers. ` +
      `Search before answering anything you are not certain of. Often the lines around a match are enough; ` +
      `when they are not, read that part of the file by its line numbers rather than the whole file.`,
    inputSchema: z.object({
      query: z.string().min(2).describe("Text to look for, case-insensitive."),
      folder: z.string().optional().describe("Narrow to one folder. Omit to search everything."),
    }),
    execute: ({ query, folder }) => files.searchFiles(root, query, folder, { around }),
  }), { onlyReads: true });
}

/**
 * Makes a tool that lets the model write one file inside `root`. It replaces
 * the whole file, or adds to its end. Missing folders are made.
 *
 * Options, besides `root` and `what`:
 * - `commit`: set to `true` to save each write as a git commit, with a commit
 *   message the model must write. Off by default. `root` must be inside a git
 *   repository, or the file is written but not committed.
 * - `author`: the name the commits are made under, such as the agent's id.
 *   Default: this machine's own git name.
 * - `memory`: set to `true` when `root` is the agent's memory folder, so each
 *   commit is listed on the run that made it. Off by default. Only matters
 *   with `commit`.
 */
export function writeFile({
  root,
  what,
  commit = false,
  author,
  memory = false,
}: Folder & { commit?: boolean; author?: string; memory?: boolean }) {
  return tool({
    description:
      `Write one file in ${what}. This replaces the file, so include everything you want kept: ` +
      `read it first unless it is new. To add to the end of a file, such as a log or a list that only ` +
      `grows, set append instead of writing it out again.` +
      (commit ? " Committed as it is written, so `message` is required." : ""),
    inputSchema: z.object({
      path: z.string(),
      content: z.string().min(1),
      append: z.boolean().optional().describe("Add content to the end of the file instead of replacing it."),
      message: z.string().optional().describe("Commit message saying what changed. Required here."),
    }),
    execute: ({ path, content, append, message }) =>
      files.writeFiles(root, path, content, { commit, message, append, author, in: memory ? "memory" : undefined }),
  });
}

/**
 * Makes a tool that lets the model change one part of a file inside `root`.
 * The model gives the exact text to replace and the new text. The old text
 * must appear in the file exactly once, or the change is refused.
 *
 * `commit`, `author` and `memory` work as for `fs.writeFile`.
 */
export function editFile({
  root,
  what,
  commit = false,
  author,
  memory = false,
}: Folder & { commit?: boolean; author?: string; memory?: boolean }) {
  return tool({
    description:
      `Change one part of a file in ${what}: give the exact text to replace and what replaces it. ` +
      `Use this for any change to a file that exists; write the whole file only when it is new or being ` +
      `rewritten. The old text must appear exactly once, so include a line or two around it when it is short. ` +
      `Read the file first, and copy the old text from what you read.` +
      (commit ? " Committed as it is written, so `message` is required." : ""),
    inputSchema: z.object({
      path: z.string(),
      old: z.string().min(1).describe("The exact text to replace, copied from the file."),
      new: z.string().describe("What replaces it. Empty to delete it."),
      message: z.string().optional().describe("Commit message saying what changed. Required here."),
    }),
    execute: ({ path, old, new: replacement, message }) =>
      files.editFiles(root, path, old, replacement, { commit, message, author, in: memory ? "memory" : undefined }),
  });
}
