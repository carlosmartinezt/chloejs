// The tools over driveService.ts: finding files in the part of Drive an agent
// is bound to, and reading one as text. The binding lives in the agent's
// config, and the model chooses only the words to look for.
import { tool } from "ai";
import { z } from "zod";

import { readDriveFile, searchDriveFiles } from "./driveService.ts";
import { google } from "./connector.ts";

interface Options {
  /**
   * The Drive query this agent may see, and nothing else, like
   * `'<folder id>' in parents`. Unsaid it is every file the account can open:
   * a binding of its own is what keeps the agent to one folder.
   */
  search?: string;
  /** How to describe those files in the tool's description, in plain words. */
  what?: string;
}

/**
 * A tool that finds files in the part of Drive the agent is bound to. Give it
 * the same `search` as the agent's `driveReadFile`.
 */
export function driveSearchFiles({ search = "", what = "Drive" }: Options = {}) {
  const find = tool({
    description: `Find files in ${what}, newest first, or by words in them. You cannot change which files this searches.`,
    inputSchema: z.object({
      text: z.string().max(200).optional().describe("Words the file holds or is named. Leave it out for the newest."),
      limit: z.number().int().min(1).max(50).optional().describe("How many at most. Default 20."),
    }),
    execute: async ({ text, limit }) => await searchDriveFiles({ search, text, limit }),
  });
  return Object.assign(find, { needs: google });
}

/** A tool that reads one file the search listed, as text: a Doc, a Sheet, Slides or a text file. */
export function driveReadFile({ search = "", what = "Drive" }: Options = {}) {
  const read = tool({
    description: `Read one file in ${what} as text: a Google Doc, Sheet or Slides, or a text file. Pass an id driveSearchFiles listed.`,
    inputSchema: z.object({
      fileId: z.string().describe("The file to read. Must be an id the search already listed."),
    }),
    execute: async ({ fileId }) => await readDriveFile({ search, what, fileId }),
  });
  return Object.assign(read, { needs: google });
}
