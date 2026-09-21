// The paths the runtime itself needs. Nothing here names a person, a home
// directory or a machine: the repo finds itself, and everything else is either
// relative to that or said in settings.local.json, which is not in source
// control. Paths that belong to one agent live in that agent's folder.
import { ROOT } from "./root.ts";
import { setting, settings } from "./settings.ts";

export { ROOT };

// Filled by the loader from what each agent declared, before any tool is bound.
let folders = new Map<string, string>();

export function setAgentDirs(declared: Map<string, string>): void {
  folders = declared;
}

/** One agent's own folder: its skills, scripts, evals and prompts. */
export function agentDir(name: string): string {
  const folder = folders.get(name);
  if (!folder) throw new Error(`No agent called ${JSON.stringify(name)} has been loaded.`);
  return folder;
}

/**
 * Everything the agents keep: their own folders (journals, metrics, notes) and
 * the run history. Unset, it is `data/` inside the repo, which git ignores, so
 * a second clone keeps its own state. `git clean -x` would delete it.
 */
export const STATE = setting(settings.state, "AGENTS_STATE") || `${ROOT}/data`;
