// The tools over services/ownFilesService.ts: an agent reading and changing
// its own folder, as far as its definition allows. `selfImprovement` with a
// `selfImprovement` in the definition turns them on.
import { z } from "zod";

import type { Home, OwnFileRules } from "#chloe/load/load";
import { listOwn, readOwn, writeOwn } from "#chloe/services/ownFilesService";
import { tool, type Tools } from "../tool.ts";

/** list_own_files, read_own_file and write_own_file, for the files `rules` lets it change. */
export function ownFiles(rules: OwnFileRules): (agent: Home) => Tools {
  const endings = rules.files.map((one) => `.${one.replace(/^\./, "")}`).join(", ");
  const kept = rules.except?.length ? ` Never ${rules.except.join(", ")}.` : "";
  return (agent) => ({
    list_own_files: tool({
      id: "list_own_files",
      description:
        "List the files in your own folder (your instructions, skills and jobs), and which of them you can " +
        "change. Your memory is not in it: that is list_notes.",
      inputSchema: z.object({}),
      execute: () => listOwn(agent, rules),
    }),
    read_own_file: tool({
      id: "read_own_file",
      description:
        "Read one file in your own folder, like instructions.md or jobs/morning-run.md. Read a file before you change it.",
      inputSchema: z.object({ path: z.string().describe("A path inside your folder, from list_own_files.") }),
      execute: ({ path }) => readOwn(agent, rules, path),
    }),
    write_own_file: tool({
      id: "write_own_file",
      description:
        `Change one file in your own folder, ending in ${endings}.${kept} This replaces the whole file, so read it ` +
        "first and include everything you want kept. A markdown file directly in skills/ is a skill, with name and " +
        "description at the top. One directly in jobs/ is a job, with cron, description, timezone and model at the " +
        "top, and a job you write runs at most once an hour. Code, your evals and your memory are not yours to " +
        "write here. Every change is committed under your name with your message, so it can be seen and undone.",
      inputSchema: z.object({
        path: z.string().describe("A path inside your folder, like skills/deploys.md."),
        content: z.string().min(1),
        message: z.string().min(10).describe("What changed and why, as a commit message."),
      }),
      execute: ({ path, content, message }) => writeOwn(agent, rules, path, content, message),
    }),
  });
}
