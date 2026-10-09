// Running one of an agent's own scripts.
//
// The boundary: an agent can run anything in its own scripts/ folder and
// nothing anywhere else. The name is checked against what is on disk, so no
// input can be a path, and arguments are passed one at a time, never as a
// shell string.
//
// The tool a model reaches is model/tools/scriptRun.ts. A job calls
// these from a step.
import { readdir } from "node:fs/promises";

import { agentDir, memoryDir } from "#chloe/core/paths";
import { settings } from "#chloe/core/settings";
import { run, type Result } from "./runService.ts";

/**
 * Lists an agent's scripts: the files in its `scripts/` folder, sorted by
 * name. Hidden files (starting with `.`) and folders are left out.
 *
 * - `agent`: the agent's id.
 *
 * Returns the file names. The list is empty if the agent has no `scripts/`
 * folder. Throws if no agent with this id has been loaded.
 */
export async function listScripts(agent: string): Promise<string[]> {
  const dir = `${agentDir(agent)}/scripts`;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Runs one of an agent's scripts and waits for it to finish.
 *
 * - `agent`: the agent's id.
 * - `name`: the script's file name in the agent's `scripts/` folder, such as `"backup.sh"`. It must be a name `listScripts` returns, so it cannot be a path to anything else.
 * - `args`: the script's arguments, one string each. They reach the script exactly as written, never through a shell. Default: none.
 * - `options.timeoutMs`: how long it may run, in milliseconds. Default: 300000 (five minutes).
 * - `options.cwd`: the folder it runs in. Default: the agent's `scripts/` folder, so the script can use paths relative to it.
 *
 * The script file must be executable, with a first line such as `#!/bin/sh`.
 * It gets chloe's environment variables, plus `MEMORY_FOLDER` (the agent's
 * memory folder) and `GA_KEY_FILE` (when `connections.google.GA_KEY_FILE` is
 * set in the settings).
 *
 * Returns a `Result`, plus `script` and `args`. It does not throw when the
 * script fails: check `exitCode`.
 *
 * Throws if the agent has no script with this name, or if no agent with this
 * id has been loaded.
 */
export async function runScripts(
  agent: string,
  name: string,
  args: string[] = [],
  { timeoutMs = 300_000, cwd }: { timeoutMs?: number; cwd?: string } = {},
): Promise<Result & { script: string; args: string[] }> {
  const available = await listScripts(agent);
  if (!available.includes(name)) {
    throw new Error(`No script called ${JSON.stringify(name)}. You have: ${available.join(", ")}`);
  }
  const dir = `${agentDir(agent)}/scripts`;
  // A script is someone else's program, so what it needs reaches it the way a
  // program expects, as an environment variable: its agent's memory folder as
  // MEMORY_FOLDER, and what it needs from settings.
  const memory = memoryDir(agent);
  const env: Record<string, string> = {
    ...(memory && { MEMORY_FOLDER: memory }),
    ...(settings.connections.google.GA_KEY_FILE && { GA_KEY_FILE: settings.connections.google.GA_KEY_FILE }),
  };
  const result = await run(`${dir}/${name}`, args, { timeoutMs, cwd: cwd ?? dir, env });
  return { script: name, args, ...result };
}
