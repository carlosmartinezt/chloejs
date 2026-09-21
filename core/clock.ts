// The clock: anything due this minute runs. What is due comes from the files on disk, so
// an edited or deleted job takes effect on the next tick with no table to
// get out of step with the folder.
import type { Agent, Job } from "#chloe/load/load.ts";
import { due, parse } from "#chloe/timer/cron.ts";
import { turn } from "#chloe/core/turn.ts";
import { sweep, waitingFor, work, WrongInput } from "#chloe/core/steps.ts";

/**
 * What a run came to, in the part both kinds of job have: a job made of code
 * can be waiting on a person, and a job made of a prompt cannot.
 */
export interface Fired {
  runId: string;
  text: string;
  steps: number;
  cost: number;
  parked?: boolean;
}

export interface Clock {
  stop(): void;
  /**
   * Run one now, whatever its cron line says, or when it has none. `input` is
   * what a job that declares an `input` shape is started with, and is checked
   * against it before the run exists: a caller that sent the wrong thing gets
   * the error rather than a failed run. `channel` is what the log shows it
   * came in on, and is "unknown" when left out.
   */
  fire(agent: Agent, job: Job, input?: unknown, channel?: string): Promise<Fired | undefined>;
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
   * Hands back what the run came to, so whoever started it can answer with it.
   * Nothing when it was skipped, because the same job was already going.
   *
   * It throws only for input that does not fit the job's shape, which is the
   * caller's mistake and worth telling them about. Anything that goes wrong
   * inside the run is that run's own record, and is logged rather than thrown:
   * the clock has nobody to tell.
   */
  async function fire(agent: Agent, job: Job, input?: unknown, channel = "unknown"): Promise<Fired | undefined> {
    const key = `${agent.name}/${job.id}`;
    if (busy.has(key)) {
      console.warn(`${key}: still running from last time, skipping this one`);
      return;
    }
    // A job waiting on a person is still that job's turn. Starting a second
    // one would ask the same question twice and act on whichever came back
    // first.
    if (job.run && waitingFor(agent.name, job.id)) {
      console.warn(`${key}: still waiting on an answer, skipping this one`);
      return;
    }
    busy.add(key);
    const began = Date.now();
    try {
      const result = job.run
        ? await work({ agent, job, source: channel, input })
        : await turn({ agent, prompt: job.prompt, model: job.model, source: channel, job: job.id });
      const seconds = Math.round((Date.now() - began) / 1000);
      const how = "parked" in result && result.parked ? "waiting on an answer" : "done";
      console.log(`${key}: ${how} in ${seconds}s, ${result.steps} steps, $${result.cost.toFixed(4)}`);
      return result;
    } catch (error) {
      if (error instanceof WrongInput) throw error;
      console.error(`${key}: failed`, error);
    } finally {
      busy.delete(key);
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
    running: () => [...busy],
  };
  return current;
}
