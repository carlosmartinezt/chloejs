// How long a piece of work may take, and how it is told to stop.
//
// A step, an agent step and a turn each get a stop signal that fires when
// whatever holds them stops, or when their own time runs out. Code that is
// handed the signal and passes it on (to `fetch`, a child process, a model
// call) really stops. Code that ignores it is not waited for: `until` lets go
// of it and the work fails, so it can no longer hold its job. A busy loop on
// the one thread cannot be stopped by anything, and nothing here pretends to.

/** The error a step, an agent step or a turn fails with when its time runs out. */
export class OutOfTime extends Error {}

/**
 * A stop signal for one piece of work: it fires when `outer` does, with its
 * reason, or after `minutes`, with an `OutOfTime` saying `ranOut`. 0 or less is
 * no limit of its own. Call `done()` when the work ends, so the timer goes.
 */
export function limited(outer: AbortSignal | undefined, minutes: number, ranOut: string): { signal: AbortSignal; done(): void } {
  const stop = new AbortController();
  const follow = () => stop.abort(outer!.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener("abort", follow, { once: true });
  const timer = minutes > 0 ? setTimeout(() => stop.abort(new OutOfTime(ranOut)), minutes * 60_000) : undefined;
  timer?.unref();
  return {
    signal: stop.signal,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", follow);
    },
  };
}

/**
 * What `work` comes to, or the signal's reason the moment it fires, whichever
 * is first. Work that ignores the signal goes on unwatched, and whatever it
 * comes to later is dropped.
 */
export function until<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      work.catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** "10 minutes", "1 minute". */
export function minutesText(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
