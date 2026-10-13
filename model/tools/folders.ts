// The folders ability, as tools: folderListFiles, folderReadFile and
// folderSearchFiles, over the folders `abilities.folders` names. They read and
// never write, and in a git repository what git ignores is left out. The
// loader adds them, so an agent's `tools` never lists them.
import { basename } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import * as files from "#chloe/services/filesService";
import type { Tools } from "../tool.ts";

/**
 * The three tools over `paths`, full paths of folders. The model names a
 * folder by the last part of its path, so no two may end the same: the loader
 * checks that, and that each is there, before it calls this. `about` is a few
 * words for them, said to the model. No paths, no tools.
 */
export function folderTools({ paths, about }: { paths: string[]; about?: string }): Tools {
  if (paths.length === 0) return {};
  const roots = new Map(paths.map((path) => [basename(path), path]));
  const names = [...roots.keys()] as [string, ...string[]];
  const what = about || (names.length === 1 ? `the folder ${names[0]}` : `the folders ${names.join(", ")}`);
  const folder = z.enum(names).describe("Which folder.");
  const root = (name: string) => roots.get(name)!;
  const shows = (name: string) => files.gitShows(root(name));

  const list = Object.assign(
    tool({
      description: `List a folder in ${what}, which you may read and never change. Start here rather than guessing at a path.`,
      inputSchema: z.object({ folder, path: z.string().optional().describe("Folder inside it to list. Omit for the top.") }),
      execute: async ({ folder, path }) => files.listFiles(root(folder), path, { shows: await shows(folder) }),
    }),
    {
      title: "List folder",
      kind: "list" as const,
      onlyReads: true,
      overview: async () => {
        const trees = await Promise.all(
          names.map(async (name) => {
            const tree = await files.folderTree(root(name), { most: 80, shows: await shows(name) });
            return `${name}/\n${tree.map((line) => `  ${line}`).join("\n")}`;
          }),
        );
        return (
          `## The folders you may read: ${what}\n\n` +
          "Two levels down, without the files. List one for what is inside it, and never guess at a path that is not here.\n\n" +
          "```\n" + trees.join("\n") + "\n```"
        );
      },
    },
  );

  const read = Object.assign(
    tool({
      description:
        `Read one file from ${what}, or part of it. A long file comes back cut, saying how many lines it has; ` +
        "then ask for the part you need with from and lines, or search first to find where it is.",
      inputSchema: z.object({
        folder,
        path: z.string(),
        from: z.number().int().min(1).optional().describe("First line to read, counting from 1."),
        lines: z.number().int().min(1).optional().describe("How many lines to read from there."),
      }),
      execute: async ({ folder, path, from, lines }) =>
        files.readFiles(root(folder), path, { from, lines, limit: 40_000, shows: await shows(folder) }),
    }),
    { title: "Read folder file", kind: "read" as const, onlyReads: true },
  );

  const search = Object.assign(
    tool({
      description:
        `Search one of ${what} for text, and return each match with the lines around it and their line numbers. ` +
        "Read that part of the file by its line numbers when the lines around a match are not enough.",
      inputSchema: z.object({
        folder,
        query: z.string().min(2).describe("Text to look for, case-insensitive."),
        path: z.string().optional().describe("Narrow to one folder or file inside it. Omit to search all of it."),
      }),
      execute: async ({ folder, query, path }) => files.searchFiles(root(folder), query, path, { around: 2, shows: await shows(folder) }),
    }),
    { title: "Search folders", kind: "search" as const, onlyReads: true },
  );

  return { folderListFiles: list, folderReadFile: read, folderSearchFiles: search };
}
