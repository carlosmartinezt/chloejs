// Where a cloud's front page goes: a chat with one agent. No React.

import type { Home, Me, Workspace } from "./types.ts";

/** The agents in a workspace this account may chat with. A guest only has the ones it was given chat on. */
export function chatsIn(one: Workspace): string[] {
  return one.guest ? one.agents.filter((agent) => one.guest![agent]?.includes("chat")) : one.agents;
}

/**
 * The chat the front page opens: the one the account chose while it is still
 * there, or else the first agent of the first workspace, a connected one
 * before one that is not. Null when there is nobody to chat with yet.
 */
export function homeOf(me: Me | null, all: Workspace[]): Home | null {
  const chosen = me?.home;
  if (chosen && all.some((one) => one.name === chosen.workspace && chatsIn(one).includes(chosen.agent))) return chosen;
  const first = [...all.filter((one) => one.online), ...all.filter((one) => !one.online)].find((one) => chatsIn(one).length);
  return first ? { workspace: first.name, agent: chatsIn(first)[0] } : null;
}

/** The address of that chat. */
export const homeAt = (home: Home): string =>
  `/workspaces/${encodeURIComponent(home.workspace)}/agents/${encodeURIComponent(home.agent)}/chat`;
