// An agent rewriting one of its own skills.
//
// This is the self-improving part, and it is deliberately the only part. A
// skill is markdown: when to do something, which script does it, and what the
// output means. An agent that learns something about its own job can put it
// where the next run will read it, and the change is live in about fifteen
// seconds with no restart.
//
// What an agent may NOT write is its tools and its scripts/ folder. Those are
// code, and code it writes is code it then runs as itself. A skill can only
// point at a script that a person already put there.
//
// Every write is a git commit, so self-improvement always leaves a diff.
//
// A skill is one .md file directly in skills/, because that is all the loader
// reads. A file in a folder inside it would be written, committed and never
// read again, so the name is refused before anything is written.
import { z } from "zod";

import { agentDir } from "#chloe/core/paths.ts";
import { writeFiles } from "#chloe/services/filesService.ts";
import { tool, type Tools } from "../tool.ts";

/** A tool that rewrites one of the agent's own skills. Every write is a commit. */
export function writeSkill(agent: string) {
  return tool({
    id: "write_skill",
    description:
      "Write one of your own skills: one Markdown file directly in skills/, with `name` and " +
      "`description` at the top. This replaces the file, so include everything you want kept: " +
      "read it first unless it is new. Committed as it is written, so `message` is required.",
    inputSchema: z.object({
      path: z
        .string()
        .regex(/^[\w-]+\.md$/, "must be one .md file directly in skills/, like deploys.md: a file in a folder is never read"),
      content: z.string().min(1),
      message: z.string().describe("Commit message saying what changed."),
    }),
    execute: ({ path, content, message }) =>
      writeFiles(`${agentDir(agent)}/skills`, path, content, { commit: true, message }),
  });
}

/** write_skill: the agent rewrites its own skills, and every write is a commit. */
export function selfImprovement(): (agent: { name: string }) => Tools {
  return ({ name }) => ({ write_skill: writeSkill(name) });
}
