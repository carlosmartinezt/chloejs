// Who a piece of work is for: the owner, or somebody else. A connection you
// sign in to reads it to use that person's own sign-in, so a tool acts as the
// person asking and never lends them the owner's account.
//
// Carried with the work rather than passed down every call: a turn, a job and
// a sign-in each start inside `asPerson()`, and everything they await sees the
// same answer from `personAsking()`. Work started outside any of them, like a
// job on its cron line or a channel checking for mail, is the owner's.
import { AsyncLocalStorage } from "node:async_hooks";

const asking = new AsyncLocalStorage<{ person?: string }>();

/**
 * Runs `work` for `person`: the email of somebody the owner invited, or
 * `channel:id` for somebody who is not one of them. `undefined` is the owner.
 */
export function asPerson<T>(person: string | undefined, work: () => T): T {
  return asking.run({ person: person || undefined }, work);
}

/**
 * Runs `work` as the owner, whoever it was started for. For what belongs to
 * the agent rather than to the person it is talking with, like the mailbox an
 * email channel reads and sends from.
 */
export function asOwner<T>(work: () => T): T {
  return asking.run({}, work);
}

/** Who the work going on is for, as `asPerson()` was given it. `undefined` is the owner. */
export function personAsking(): string | undefined {
  return asking.getStore()?.person;
}
