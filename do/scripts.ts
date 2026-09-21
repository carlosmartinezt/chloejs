// Running one of an agent's own scripts.
//
// The boundary: an agent can run anything in its own scripts/ folder and
// nothing anywhere else. The name is checked against what is on disk, so no
// input can be a path, and arguments are passed one at a time, never as a
// shell string.
//
// The tool a model reaches is model/tools/run_script.ts. A job calls
// these from a step.
import { readdir } from "node:fs/promises";

import { agentDir } from "#chloe/core/paths.ts";
import { settings } from "#chloe/core/settings.ts";
import { run, type Result } from "./run.ts";

/** What this agent has in scripts/, sorted. Nothing hidden. */
export async function scripts(agent: string): Promise<string[]> {
  const dir = `${agentDir(agent)}/scripts`;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Run one. A name not on disk is refused rather than resolved as a path, which
 * is what stops a `../` in a name reaching anything else on the box.
 *
 * `cwd` defaults to the scripts folder, so a script may use relative paths.
 * An agent whose scripts work on a tree somewhere else passes that instead.
 */
export async function script(
  agent: string,
  name: string,
  args: string[] = [],
  { timeoutMs = 300_000, cwd }: { timeoutMs?: number; cwd?: string } = {},
): Promise<Result & { script: string; args: string[] }> {
  const available = await scripts(agent);
  if (!available.includes(name)) {
    throw new Error(`No script called ${JSON.stringify(name)}. You have: ${available.join(", ")}`);
  }
  const dir = `${agentDir(agent)}/scripts`;
  // A script is someone else's program, so what it needs from settings reaches
  // it the way a program expects, as an environment variable.
  const env: Record<string, string> = settings.google.GA_KEY_FILE ? { GA_KEY_FILE: settings.google.GA_KEY_FILE } : {};
  const result = await run(`${dir}/${name}`, args, { timeoutMs, cwd: cwd ?? dir, env });
  return { script: name, args, ...result };
}
