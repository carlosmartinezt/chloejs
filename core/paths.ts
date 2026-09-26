// The paths the runtime itself needs. Nothing here names a person, a home
// directory or a machine: the repo finds itself, and everything else is either
// relative to that or said in settings.local.json, which is not in source
// control. What one agent writes is in its memory, and never here.
import { join } from "node:path";

import { ROOT } from "./root.ts";
import { setting, settings } from "./settings.ts";

export { ROOT };

// Filled by the loader from what each agent declared, before any tool is bound.
let folders = new Map<string, string>();
let memories = new Map<string, string>();

export function setAgentDirs(declared: Map<string, string>, memory = new Map<string, string>()): void {
  folders = declared;
  memories = memory;
}

/** One agent's memory folder, as the loader worked it out. Undefined for an agent not loaded. */
export function memoryDir(name: string): string | undefined {
  return memories.get(name);
}

/**
 * Where an agent's notes go: its memory folder as the loader worked it out, or
 * where that folder would be for an agent that has not been loaded. Nothing an
 * agent writes goes anywhere but its memory, which is why this never falls back
 * to the state directory.
 */
export function memoryFolderOf(name: string): string {
  return memories.get(name) ?? join(MEMORIES, name);
}

/** One agent's own folder: its skills, scripts, evals and prompts. */
export function agentDir(name: string): string {
  const folder = folders.get(name);
  if (!folder) throw new Error(`No agent called ${JSON.stringify(name)} has been loaded.`);
  return folder;
}

/**
 * What the runtime keeps about the agents, as against what they write, which is
 * MEMORIES: the run history, the account, the tokens and the log of what each
 * memory served. None of it is ever in git, and two of those are why: a secret
 * in a repository stays in its history, and the run history is one SQLite file
 * rewritten every run. Unset, this is `data/` inside the repo, which git
 * ignores, so a second clone keeps its own state. `git clean -x` would delete it.
 */
export const STATE = setting(settings.state, "AGENTS_STATE") || `${ROOT}/data`;

/**
 * Where the memories are: one folder per agent, and one git repository holding
 * all of them, so an agent's folder stays source and its notes stay out of the
 * repository that source is in. Unset, this is `memory/` inside STATE, so one
 * ignored folder holds everything this box keeps. It is a repository of its own
 * even so: what the agents write is in git, and nothing else in STATE ever is.
 */
export const MEMORIES = setting(settings.memory, "AGENTS_MEMORY") || `${STATE}/memory`;
