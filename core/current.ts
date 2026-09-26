// Which run the code running right now belongs to.
//
// A tool is called deep inside a turn and is never handed the run it is part
// of. A write that becomes a commit still has to say which run made it, so
// the two runners start each run inside `duringRun` and anything below can
// ask `currentRun()`.
import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<string>();

/** Runs `work` as part of run `runId`, for everything it awaits. */
export function duringRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return current.run(runId, work);
}

/** The run this code is part of, or undefined outside one. */
export function currentRun(): string | undefined {
  return current.getStore();
}
