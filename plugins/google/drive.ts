// The tools over driveService.ts: finding files in the part of Drive an agent
// is bound to, reading one as text, and downloading one as it is. The
// binding lives in the agent's config, and the model chooses only the words to
// look for.
//
//   import * as drive from "@chloejs/core/tools/drive";
//   tools: { driveSearchFiles: drive.searchFiles({ search }), driveReadFile: drive.readFile({ search }) }
import { tool } from "ai";
import { z } from "zod";

import { downloadDriveFile, readDriveFile, searchDriveFiles } from "./driveService.ts";
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
 * or by words in their name or text, or the files in one folder. Files in the
 * trash are left out.
 *
 * `search` sets which files the model can see, and the model cannot change
 * it. The model chooses only the words to look for, a folder to look inside,
 * and how many files (up to 50, default 20).
 *
 * Give it the same `search` as the agent's `drive.readFile`. Needs the Google
 * connection.
 */
export function searchFiles({ search = "", what = "Drive" }: Options = {}) {
  const find = tool({
    description: `Find files in ${what}, newest first, or by words in them, or list what is in one folder. You cannot change which files this searches.`,
    inputSchema: z.object({
      text: z.string().max(200).optional().describe("Words the file holds or is named. Leave it out for the newest."),
      limit: z.number().int().min(1).max(50).optional().describe("How many at most. Default 20."),
      folder: z.string().optional().describe("A folder to look inside: its id from a search, or a Drive folder link as it was sent."),
    }),
    execute: async ({ text, limit, folder }) => await searchDriveFiles({ search, text, limit, folder }),
  });
  return Object.assign(find, { title: "Search Drive", needs: google, onlyReads: true, kind: "search" as const });
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
  return Object.assign(read, { title: "Read Drive file", needs: google, onlyReads: true, kind: "read" as const });
}

/**
 * Makes a tool that lets the model download one Drive file as it is (a PDF, a
 * picture) and get the full path it was saved at, to hand to a script. It goes
 * in the agent's made files, for 30 days.
 *
 * The model passes a Drive link or a file id. With a `search`, only a file
 * `drive.searchFiles` listed with it; without one, any file the account can open.
 *
 * - `agent`: the agent's id, whose made files it goes in. Required.
 *
 * Needs the Google connection.
 */
export function downloadFile({ search = "", what = "Drive", agent }: Options & { agent: string }) {
  const download = tool({
    description:
      `Download one file in ${what} as it is (a PDF, a picture) and get the full path it was saved at, to hand to a script. ` +
      "Pass a Drive link as it was sent, or an id driveSearchFiles listed. Read Google Docs, Sheets and Slides with driveReadFile instead.",
    inputSchema: z.object({
      file: z.string().min(10).describe("A Drive link, or a file id."),
    }),
    execute: async ({ file }) => await downloadDriveFile({ search, what, agent, file }),
  });
  return Object.assign(download, { title: "Download Drive file", needs: google, onlyReads: true, kind: "fetch" as const });
}
