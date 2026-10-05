// An agent's changes, for the site: what changed in its memory and in its own
// folder, one change in full, undoing one, and when somebody last looked.
//
// A change in a memory shows what that memory held, so it is written to the
// agent's audit log before it is served, like any other read of a memory, and
// these routes never take a token.
import type { Agent } from "#chloe/load/load";
import { change, changes, markSeen, seenAt, undo, type Change, type Place } from "#chloe/services/historyService";
import { BadRequest, NotFound } from "./errors.ts";
import { record } from "./memory.ts";

/** A place as the page names it, or a 400. */
export function placeOf(value: string | null | undefined): Place | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value === "memory" || value === "folder") return value;
  throw new BadRequest(`in is "memory" or "folder", not ${JSON.stringify(value)}.`);
}

/**
 * The agent's changes, newest first, with the ones it made since somebody last
 * looked marked `new`. `path` narrows it to one file's history.
 */
export async function agentChanges(
  agent: Agent,
  { place, path, limit }: { place?: Place; path?: string; limit?: number },
  from: string,
) {
  const found = await changes(agent, { place, path, limit });
  if (found.some((one) => one.in === "memory")) await record(agent, "history", path ?? "/", from);
  const seen = seenAt(agent.id);
  const marked = found.map((one) => ({ ...one, new: isNew(agent, one, seen) }));
  return { seen: seen ?? null, unseen: marked.filter((one) => one.new).length, changes: marked };
}

function isNew(agent: Agent, one: Change, seen: string | undefined): boolean {
  return one.by === agent.id && (!seen || one.at > seen);
}

/** One change with its diff. */
export async function agentChange(agent: Agent, place: Place, id: string, from: string) {
  const found = await change(agent, place, id);
  if (!found) throw new NotFound("There is no such change.");
  if (place === "memory") await record(agent, "read", `change ${found.id}`, from, { bytes: found.diff.length });
  return { ...found, new: isNew(agent, found, seenAt(agent.id)) };
}

/** Puts back what one change changed, and commits that. */
export async function agentUndo(agent: Agent, place: Place, id: string, from: string) {
  try {
    const undone = await undo(agent, place, id);
    if (place === "memory") await record(agent, "undo", undone.files.join(", "), from, { change: id, commit: undone.id });
    return undone;
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
}

/** Everything up to now has been looked at. */
export function agentSeen(agent: Agent) {
  return { seen: markSeen(agent.id) };
}
