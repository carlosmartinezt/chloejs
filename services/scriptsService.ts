// Running one of an agent's own scripts.
//
// The boundary: an agent can run anything in its own scripts/ folder, and any
// executable file inside one of its skill folders, and nothing anywhere else.
// The name is checked against what is on disk, so no input can be a path, and
// arguments are passed one at a time, never as a shell string.
//
// The tool a model reaches is model/tools/script.ts. A job calls
// these from a step.
import { existsSync, readdirSync, statSync } from "node:fs";

import { agentDir, memoryDir } from "#chloe/core/paths";
import { settings } from "#chloe/core/settings";
import { run, type Result } from "./runService.ts";

/** How deep inside a skill's folder a script is looked for. */
const DEPTH = 4;

/**
 * An agent's scripts, found in its folder: the files in `scripts/`, by name,
 * then the executable files inside each skill folder (one with a `SKILL.md`),
 * as `<skill folder>/<path inside it>`, like `fill-pdfs/scripts/fill.py`.
 * Hidden names are left out. Sorted within each half.
 */
export function scriptsIn(folder: string): string[] {
  const visible = (dir: string) => {
    try {
      return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
    } catch {
      return [];
    }
  };
  const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  const own = visible(`${folder}/scripts`).filter((name) => isFile(`${folder}/scripts/${name}`));
  const inSkills: string[] = [];
  const walk = (dir: string, at: string, depth: number) => {
    for (const name of visible(dir)) {
      const info = statSync(`${dir}/${name}`, { throwIfNoEntry: false });
      if (info?.isDirectory() && depth < DEPTH && name !== "node_modules") walk(`${dir}/${name}`, `${at}/${name}`, depth + 1);
      else if (info?.isFile() && info.mode & 0o111) inSkills.push(`${at}/${name}`);
    }
  };
  for (const skill of visible(`${folder}/skills`)) {
    if (existsSync(`${folder}/skills/${skill}/SKILL.md`)) walk(`${folder}/skills/${skill}`, skill, 1);
  }
  return [...own, ...inSkills];
}

/**
 * Lists an agent's scripts: the files in its `scripts/` folder, and the
 * executable files inside its skill folders as `<skill folder>/<file>`.
 *
 * - `agent`: the agent's id.
 *
 * Returns the names `runScripts` takes. The list is empty if the agent has
 * neither. Throws if no agent with this id has been loaded.
 */
export async function listScripts(agent: string): Promise<string[]> {
  return scriptsIn(agentDir(agent));
}

/**
 * Runs one of an agent's scripts and waits for it to finish.
 *
 * - `agent`: the agent's id.
 * - `name`: a name `listScripts` returns: a file in the agent's `scripts/` folder, such as `"backup.sh"`, or one inside a skill folder, such as `"fill-pdfs/scripts/fill.py"`. So it cannot be a path to anything else.
 * - `args`: the script's arguments, one string each. They reach the script exactly as written, never through a shell. Default: none.
 * - `options.timeoutMs`: how long it may run, in milliseconds. Default: 300000 (five minutes).
 * - `options.cwd`: the folder it runs in. Default: the agent's `scripts/` folder, or for a skill's script that skill's folder, so the script can use paths relative to it.
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
  const skill = name.includes("/") ? name.split("/")[0] : undefined;
  const dir = skill ? `${agentDir(agent)}/skills/${skill}` : `${agentDir(agent)}/scripts`;
  const file = skill ? `${agentDir(agent)}/skills/${name}` : `${dir}/${name}`;
  // A script is someone else's program, so what it needs reaches it the way a
  // program expects, as an environment variable: its agent's memory folder as
  // MEMORY_FOLDER, and what it needs from settings.
  const memory = memoryDir(agent);
  const env: Record<string, string> = {
    ...(memory && { MEMORY_FOLDER: memory }),
    ...(settings.connections.google.GA_KEY_FILE && { GA_KEY_FILE: settings.connections.google.GA_KEY_FILE }),
  };
  const result = await run(file, args, { timeoutMs, cwd: cwd ?? dir, env });
  return { script: name, args, ...result };
}
