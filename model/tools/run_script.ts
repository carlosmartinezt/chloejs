// The tool over do/scripts.ts: an agent running one of its own scripts.
//
// This is the plug-and-play half of the system. A capability is a script in
// the agent's `scripts/` folder plus a short file in its `skills/` folder
// saying when to use it. Neither is TypeScript and neither needs a restart.
import { existsSync, readdirSync } from "node:fs";

import { z } from "zod";

import { agentDir } from "#chloe/core/paths.ts";
import { script, scripts } from "#chloe/do/scripts.ts";
import { tool, type Tools } from "#chloe/model/tool.ts";

/** A tool that runs one file from that agent's own `scripts/` folder. */
export function runScript(agent: string) {
  return tool({
    id: "run_script",
    description:
      "Run one of your own scripts and return what it printed. Your skills say which script to " +
      "use and what its arguments mean. Use `list` to see what you have.",
    inputSchema: z.object({
      script: z.string().describe(`A file in scripts/, or "list" to see them all.`),
      args: z.array(z.string()).optional().describe("Arguments, one per item."),
      timeoutSeconds: z.number().int().min(5).max(1800).optional(),
    }),
    execute: async ({ script: name, args = [], timeoutSeconds }) =>
      name === "list"
        ? { scripts: await scripts(agent) }
        : script(agent, name, args, { timeoutMs: (timeoutSeconds ?? 300) * 1000 }),
  });
}

/**
 * run_script: the agent runs any file in its scripts/ folder, and nothing
 * else. Refused as the agent loads when that folder has nothing in it.
 */
export function runScripts(): (agent: { name: string }) => Tools {
  return ({ name }) => {
    const dir = `${agentDir(name)}/scripts`;
    const any = existsSync(dir) && readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && !e.name.startsWith("."));
    if (!any) throw new Error(`${name} has features.runScripts on, and ${dir} has no scripts in it.`);
    return { run_script: runScript(name) };
  };
}
