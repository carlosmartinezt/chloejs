// The tool over services/scriptsService.ts: an agent running one of its own scripts.
//
// This is the plug-and-play half of the system. A capability is a skill
// folder, `skills/<name>/SKILL.md` saying when and how, with its scripts
// beside it, or a script in `scripts/` that a skill names. Neither is
// TypeScript and neither needs a restart.
import { tool } from "ai";
import { z } from "zod";

import { agentDir } from "#chloe/core/paths";
import { listScripts, runScripts as runOne, scriptsIn } from "#chloe/services/scriptsService";
import type { Tools } from "#chloe/model/tool";

/** A tool that runs one file from that agent's own `scripts/` folder. */
export function scriptRun(agent: string) {
  return Object.assign(tool({
    description:
      "Run one of your own scripts and return what it printed. Your skills say which script to " +
      "use and what its arguments mean. Use `list` to see what you have.",
    inputSchema: z.object({
      script: z.string().describe(`A file in scripts/, one in a skill's folder as <skill>/<file>, or "list" to see them all.`),
      args: z.array(z.string()).optional().describe("Arguments, one per item."),
      timeoutSeconds: z.number().int().min(5).max(1800).optional(),
    }),
    execute: async ({ script: name, args = [], timeoutSeconds }) =>
      name === "list"
        ? { scripts: await listScripts(agent) }
        : runOne(agent, name, args, { timeoutMs: (timeoutSeconds ?? 300) * 1000 }),
  }), { kind: "run" as const });
}

/**
 * scriptRun: the agent runs any file in its scripts/ folder, or an executable
 * file in one of its skill folders, and nothing else. Refused as the agent
 * loads when it has neither.
 */
export function scriptTools(): (agent: { id: string }) => Tools {
  return ({ id }) => {
    if (scriptsIn(agentDir(id)).length === 0) {
      throw new Error(`${id} has features.runScripts on, and no scripts: neither ${agentDir(id)}/scripts nor an executable file in a skill folder.`);
    }
    return { scriptRun: scriptRun(id) };
  };
}
