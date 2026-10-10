// The clock: anything due this minute runs. What is due comes from the files on disk, so
// an edited or deleted job takes effect on the next tick with no table to
// get out of step with the folder.
import type { Agent, Job } from "#chloe/load/load";
import { due, parse } from "#chloe/timer/cron";
import { carryOn, spentText, turn } from "#chloe/core/turn";
import { modelFor } from "#chloe/model/choices";
import { sweep, waitingFor, work, WrongArgs } from "#chloe/core/steps";
import { jobEnded } from "#chloe/core/alerts";

/**
 * What a run came to, in the part both kinds of job have: a job made of code
 * can be waiting on a person, and a job made of a prompt cannot.
 */
export interface Fired {
  runId: string;
  text: string;
  summary?: string | null;
  reply?: string;
  steps: number;
  cost: number;
  unpriced?: number;
  parked?: boolean;
}

/**
 * A run that did not happen, and which of the two it was. `skipped` is the
 * same job already going or already waiting on an answer; `failed` is a run
 * that started and ended in an error, which is written into its own record.
 */
export interface NotRun {
  skipped?: "busy" | "waiting";
  failed?: string;
}

export function ran(result: Fired | NotRun): result is Fired {
  return "runId" in result;
}

export interface Clock {
  stop(): void;
  /**
   * Run one now, whatever its cron line says, or when it has none. `input` is
   * what a job that declares an `input` shape is started with, and is checked
   * against it before the run exists: a caller that sent the wrong thing gets
   * the error rather than a failed run. `channel` is what the log shows it
   * came in on, and is "unknown" when left out. A run that did not happen
   * hands back why, so a caller can say which of the two it was.
   *
   * With `conversation`, as a channel's job is run, the guard is one run per
   * conversation rather than one per job, so two people are answered side by
   * side. An answer to a run waiting in that conversation has already gone to
   * it before this is called.
   */
  fire(agent: Agent, job: Job, input?: unknown, channel?: string, conversation?: string): Promise<Fired | NotRun>;
  /**
   * Pick up a run of a prompt job that the service stopped in the middle of,
   * or that ran out of steps, under the same guard as `fire`, so it never overlaps another run of that
   * job. A run that cannot carry on comes back `failed` and is left as it
   * was: `stopped` in core/turn.ts says which can, before anything starts.
   */
  carryOn(agent: Agent, job: Job, runId: string): Promise<Fired | NotRun>;
  running(): string[];
}

/**
 * The clock this process started, for a channel that needs to run a job.
 *
 * A module-level handle rather than another argument threaded through every
 * channel, the same way model/ask.ts keeps the registry of who can be reached.
 * Going through it rather than calling work() directly is what keeps the guard
 * against two runs of one job overlapping.
 */
let current: Clock | undefined;

export function clock(): Clock | undefined {
  return current;
}

export function startClock(agents: () => Map<string, Agent>): Clock {
  // Two runs of one job must never overlap: a morning run that takes
  // eighty minutes would write over the next one's journal.
  const busy = new Set<string>();
  let lastMinute = "";

  /**
   * Hands back what the run came to, so whoever started it can answer with it,
   * or why there is nothing: the same job was already going, or the run
   * failed.
   *
   * It throws only for input that does not fit the job's shape, which is the
   * caller's mistake and worth telling them about. Anything that goes wrong
   * inside the run is that run's own record, and is logged rather than thrown:
   * the clock has nobody to tell.
   */
  async function fire(agent: Agent, job: Job, input?: unknown, channel = "unknown", conversation?: string): Promise<Fired | NotRun> {
    return guarded(agent, job, conversation, () =>
      job.run
        ? work({ agent, job, source: channel, input })
        : turn({ agent, prompt: job.prompt, model: modelFor(agent, job), source: channel, job: job.id }),
    );
  }

  async function guarded(agent: Agent, job: Job, conversation: string | undefined, run: () => Promise<Fired>): Promise<Fired | NotRun> {
    const key = conversation ? `${agent.id}/${job.id}/${conversation}` : `${agent.id}/${job.id}`;
    if (busy.has(key)) {
      console.warn(`${key}: still running from last time, skipping this one`);
      return { skipped: "busy" };
    }
    // A job waiting on a person is still that job's turn. Starting a second
    // one would ask the same question twice and act on whichever came back
    // first.
    if (job.run && !conversation && waitingFor(agent.id, job.id)) {
      console.warn(`${key}: still waiting on an answer, skipping this one`);
      return { skipped: "waiting" };
    }
    busy.add(key);
    const began = Date.now();
    const since = new Date(began).toISOString();
    try {
      const result = await run();
      const seconds = Math.round((Date.now() - began) / 1000);
      const how = "parked" in result && result.parked ? "waiting on an answer" : "done";
      console.log(`${key}: ${how} in ${seconds}s, ${result.steps} steps, ${spentText(result.cost, result.unpriced)}`);
      return result;
    } catch (error) {
      if (error instanceof WrongArgs) throw error;
      console.error(`${key}: failed`, error);
      return { failed: (error as Error).message };
    } finally {
      busy.delete(key);
      jobEnded(agent.id, job.id, since);
    }
  }

  function tick(): void {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    if (minute === lastMinute) return;
    lastMinute = minute;

    // Before anything is due: a question nobody answered holds its job,
    // so giving up on it is what lets that job run again.
    void sweep(agents()).catch((error: unknown) => console.error("sweep failed", error));

    for (const agent of agents().values()) {
      for (const job of agent.jobs) {
        // No cron line: it runs only when somebody starts it. A bad one never
        // gets here, because the loader refuses the file.
        if (job.cron && due(parse(job.cron), now, job.timezone)) void fire(agent, job, undefined, "schedule");
      }
    }
  }

  // Ten seconds, not sixty: a timer that drifts past a minute boundary would
  // skip that minute's jobs, and lastMinute stops the extra ticks counting.
  const timer = setInterval(tick, 10_000);
  tick();

  current = {
    stop: () => clearInterval(timer),
    fire,
    carryOn: (agent, job, runId) => guarded(agent, job, undefined, () => carryOn({ agent, runId })),
    running: () => [...busy],
  };
  return current;
}
