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

/** `what` names the folder in the tool's description, e.g. "the shared notes". */
interface Folder {
  root: string;
  what: string;
}

/**
 * A tool that lists what is in one folder, and nothing outside it. Its
 * overview is the folder's folders, two levels down, so a model knows the
 * layout before its first call.
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
  return Object.assign(list, { overview });
}

/**
 * A tool that reads one file inside that folder, or part of it. `limit` is
 * how many characters an unranged read returns before it is cut at a line
 * and says so: 40,000 (about 10,000 tokens) unless the binding says otherwise.
 */
export function readFile({ root, what, limit = 40_000 }: Folder & { limit?: number }) {
  return tool({
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
  });
}

/**
 * A tool that searches the text of the files in that folder. `around` is how
 * many lines either side of each match come back with it: 2 unless the
 * binding says otherwise.
 */
export function searchFiles({ root, what, around = 2 }: Folder & { around?: number }) {
  return tool({
    description:
      `Search ${what} for text, and return each match with the lines around it and their line numbers. ` +
      `Search before answering anything you are not certain of. Often the lines around a match are enough; ` +
      `when they are not, read that part of the file by its line numbers rather than the whole file.`,
    inputSchema: z.object({
      query: z.string().min(2).describe("Text to look for, case-insensitive."),
      folder: z.string().optional().describe("Narrow to one folder. Omit to search everything."),
    }),
    execute: ({ query, folder }) => files.searchFiles(root, query, folder, { around }),
  });
}

/**
 * `commit` makes every write a git commit, for a folder that is a repo, under
 * `author` when there is one. `memory` says this folder is the agent's memory,
 * so the run writing it lists the commit.
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

/** A tool that changes one part of a file in that folder. `commit`, `author` and `memory` are as for writeFile. */
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
