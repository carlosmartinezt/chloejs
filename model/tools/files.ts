// The tools over services/filesService.ts: one folder, offered to a model.
//
// An agent binds each one to a root it is allowed to see, and names that
// folder in plain words for the description.
import { z } from "zod";

import { list, read, search, write } from "#chloe/services/filesService.ts";
import { tool } from "#chloe/model/tool.ts";

/**
 * `what` names the folder in the tool's description, e.g. "the shared notes".
 * `id` renames the tool, for an agent that binds two different folders and
 * would otherwise have two tools called the same thing.
 */
interface Folder {
  root: string;
  what: string;
  id?: string;
}

/** A tool that lists what is in one folder, and nothing outside it. */
export function listIn({ root, what, id = "list_notes" }: Folder) {
  return tool({
    id,
    description: `List a folder in ${what}, so you can find the right file before reading it. Start here rather than guessing at a path.`,
    inputSchema: z.object({
      path: z.string().optional().describe("Folder to list. Omit for the top level."),
    }),
    execute: ({ path }) => list(root, path),
  });
}

/** A tool that reads one file inside that folder. */
export function readIn({ root, what, id = "read_notes" }: Folder) {
  return tool({
    id,
    description: `Read one file from ${what}. Read before answering, and read before writing: guessing from memory is how you end up confidently wrong.`,
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => read(root, path),
  });
}

/** A tool that searches the text of the files in that folder. */
export function searchIn({ root, what, id = "search_notes" }: Folder) {
  return tool({
    id,
    description: `Search ${what} for text, and return the matching files and lines. Search before answering anything you are not certain of.`,
    inputSchema: z.object({
      query: z.string().min(2).describe("Text to look for, case-insensitive."),
      folder: z.string().optional().describe("Narrow to one folder. Omit to search everything."),
    }),
    execute: ({ query, folder }) => search(root, query, folder),
  });
}

/** `commit` makes every write a git commit, for a folder that is a repo. */
export function writeIn({ root, what, id = "write_notes", commit = false }: Folder & { commit?: boolean }) {
  return tool({
    id,
    description:
      `Write one file in ${what}. This replaces the file, so include everything you want kept: ` +
      `read it first unless it is new.` +
      (commit ? " Committed as it is written, so `message` is required." : ""),
    inputSchema: z.object({
      path: z.string(),
      content: z.string().min(1),
      message: z.string().optional().describe("Commit message saying what changed. Required here."),
    }),
    execute: ({ path, content, message }) => write(root, path, content, { commit, message }),
  });
}
