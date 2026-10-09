// The tools over driveService.ts: finding files in the part of Drive an agent
// is bound to, and reading one as text. The binding lives in the agent's
// config, and the model chooses only the words to look for.
//
//   import * as drive from "@chloejs/core/tools/drive";
//   tools: { driveSearchFiles: drive.searchFiles({ search }), driveReadFile: drive.readFile({ search }) }
import { tool } from "ai";
import { z } from "zod";

import { readDriveFile, searchDriveFiles } from "./driveService.ts";
import { google } from "./connection.ts";

/** The options for `drive.searchFiles` and `drive.readFile`. */
interface Options {
  /**
   * The Drive search that sets which files the model can see, such as
   * `"'<folder id>' in parents"` for one folder. The model cannot change it.
   * Default: `""`, every file the signed-in account can open.
   *
   * Set your own search to keep the agent to the files it needs.
   */
  search?: string;
  /**
   * A few words for those files, such as `"the shared reports folder"`. Used
   * in the tool's description and messages to the model. Default: `"Drive"`.
   */
  what?: string;
}

/**
 * Makes a tool that lets the model find files in Google Drive, newest first,
 * or by words in their name or text. Files in the trash are left out.
 *
 * `search` sets which files the model can see, and the model cannot change
 * it. The model chooses only the words to look for and how many files (up to
 * 50, default 20).
 *
 * Give it the same `search` as the agent's `drive.readFile`. Needs the Google
 * connection.
 */
export function searchFiles({ search = "", what = "Drive" }: Options = {}) {
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

/**
 * Makes a tool that lets the model read one Drive file as text: a Google Doc,
 * Sheet or Slides, or a plain text file. Other files (such as images) are
 * refused. A very long file is cut short.
 *
 * The model can read only a file that `drive.searchFiles` has already listed
 * with the same `search`, so give both tools the same `search`.
 *
 * Needs the Google connection.
 */
export function readFile({ search = "", what = "Drive" }: Options = {}) {
  const read = tool({
    description: `Read one file in ${what} as text: a Google Doc, Sheet or Slides, or a text file. Pass an id driveSearchFiles listed.`,
    inputSchema: z.object({
      fileId: z.string().describe("The file to read. Must be an id the search already listed."),
    }),
    execute: async ({ fileId }) => await readDriveFile({ search, what, fileId }),
  });
  return Object.assign(read, { needs: google });
}
