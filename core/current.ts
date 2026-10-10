// Which run the code running right now belongs to, and whether it is a trial.
//
// A tool is called deep inside a turn and is never handed the run it is part
// of. A write that becomes a commit still has to say which run made it, so
// the two runners start each run inside `duringRun` and anything below can
// ask `currentRun()`. The same is how a send knows it is in a trial run, and
// writes down what it would have sent instead of sending it.
import { AsyncLocalStorage } from "node:async_hooks";

import { db } from "./db.ts";

const current = new AsyncLocalStorage<string>();

/** Runs `work` as part of run `runId`, for everything it awaits. */
export function duringRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return current.run(runId, work);
}

/** The run this code is part of, or undefined outside one. */
export function currentRun(): string | undefined {
  return current.getStore();
}

/** Something a trial run would have sent, and did not. */
export interface Held {
  /** A message to an address through a channel, an email, or a call to a tool that does more than read. */
  kind: "message" | "email" | "tool";
  /** Where it would have gone: an address like "telegram:12345", email addresses, or the tool's name. */
  to: string;
  /** An email's subject, with its tag. */
  subject?: string;
  /** What it would have said, or the tool's arguments as JSON. */
  text: string;
  /** When it was held back, as an ISO date string. */
  at: string;
}

/** True when the code running now is part of a trial run. */
export function inTrial(): boolean {
  return heldSoFar() !== undefined;
}

/**
 * Called by each of chloe's services that sends to a person, just before it
 * would, and for every tool call that is not `own` or `onlyReads`. In a trial run it writes down what would have gone, in the run's
 * record, and returns true: the caller then sends nothing. Anywhere else it
 * returns false, and the caller sends.
 */
export function holdBack(sent: Omit<Held, "at">): boolean {
  const held = heldSoFar();
  if (!held) return false;
  held.push({ ...sent, at: new Date().toISOString() });
  db.prepare("update runs set held = ? where id = ?").run(JSON.stringify(held), currentRun()!);
  return true;
}

/** What the run held back so far, or undefined when it is not a trial. A trial is a run whose `held` is not null. */
function heldSoFar(): Held[] | undefined {
  const runId = currentRun();
  if (!runId) return undefined;
  const row = db.prepare("select held from runs where id = ?").get(runId) as { held: string | null } | undefined;
  return row?.held ? (JSON.parse(row.held) as Held[]) : undefined;
}
