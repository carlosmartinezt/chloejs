// The paths the runtime itself needs. Nothing here names a person, a home
// directory or a machine: the repo finds itself, and everything else is either
// relative to that or said in .env, which is not in source control. What one
// agent writes is in its memory, and never here.
//
// STATE and MEMORIES are read as this file loads, which is before any config is,
// so they come from the environment, CHLOE_STATE and CHLOE_MEMORY, and are not
// settings. Where things are kept needs a restart either way.
import { join } from "node:path";

// First, so a CHLOE_STATE in .env is read.
import "./env.ts";
import { ROOT } from "./root.ts";

export { ROOT };

// Filled by the loader from what each agent declared, before any tool is bound.
let folders = new Map<string, string>();
let memories = new Map<string, string>();

export function setAgentDirs(declared: Map<string, string>, memory = new Map<string, string>()): void {
  folders = declared;
  memories = memory;
}

/** One agent's memory folder, as the loader worked it out. Undefined for an agent not loaded. */
export function memoryDir(id: string): string | undefined {
  return memories.get(id);
}

/**
 * Where an agent's notes go: its memory folder as the loader worked it out, or
 * where that folder would be for an agent that has not been loaded. Nothing an
 * agent writes goes anywhere but its memory, which is why this never falls back
 * to the state directory.
 */
export function memoryFolderOf(id: string): string {
  return memories.get(id) ?? join(MEMORIES, id);
}

/**
 * Returns an agent's own folder: the folder its `agent.ts` is in, with its
 * skills, scripts, evals and prompts. Throws if no agent with this `id` has
 * loaded.
 */
export function agentDir(id: string): string {
  const folder = folders.get(id);
  if (!folder) throw new Error(`No agent called ${JSON.stringify(id)} has been loaded.`);
  return folder;
}

/**
 * The state folder, where chloe keeps its own records about the agents: the
 * run history, the account, the tokens, the Google sign-in, and the log of
 * which memory files were read. What the agents write is in `MEMORIES`,
 * which is inside this folder by default.
 *
 * Default: `data` inside `ROOT`. To move it, set `CHLOE_STATE` in the
 * environment or in `.env`. A change needs a restart.
 *
 * Keep it out of git: it holds secrets. `npx chloe setup` adds `data` to
 * `.gitignore`. Warning: `git clean -x` deletes it.
 */
export const STATE = process.env.CHLOE_STATE || `${ROOT}/data`;

/**
 * The folder that holds the agents' memories, one folder per agent. By
 * default chloe makes it one git repository, and commits what each run
 * changed. An agent can keep its memory somewhere else with `memory` in its
 * `agent.ts`.
 *
 * Default: `memory` inside `STATE`. To move it, set `CHLOE_MEMORY` in the
 * environment or in `.env`. A change needs a restart.
 */
export const MEMORIES = process.env.CHLOE_MEMORY || `${STATE}/memory`;
