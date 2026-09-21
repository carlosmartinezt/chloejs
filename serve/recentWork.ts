// What each agent did recently, for the overview. The same job run again and
// again is one line with a count, or a check every quarter hour would be all
// there is to see.
import { db } from "#chloe/core/db.ts";
import type { Agent } from "#chloe/load/load.ts";

export interface RecentWork {
  /** The newest run of the group, which is the one a click opens. */
  id: string;
  /** The channel it came in on, like "schedule" or "telegram". */
  source: string;
  /** The job it was, or null for a turn somebody started by talking to it. */
  job: string | null;
  started: string;
  finished: string | null;
  summary: string | null;
  error: string | null;
  /** How many runs in a row this line stands for, and how many of them failed. */
  times: number;
  failed: number;
  cost: number;
}

/** Far enough back to find a few different things behind a busy job. */
const LOOK_BACK = 200;

interface Row {
  id: string;
  source: string;
  job: string | null;
  started: string;
  finished: string | null;
  summary: string | null;
  error: string | null;
  cost: number;
}

export function recentWork(agent: Agent, count = 3): RecentWork[] {
  const rows = db
    .prepare(
      "select id, source, job, started, finished, summary, error, cost from runs where agent = ? order by started desc limit ?",
    )
    .all(agent.name, LOOK_BACK) as unknown as Row[];

  const out: RecentWork[] = [];
  for (const run of rows) {
    const last = out[out.length - 1];
    if (last && last.source === run.source && last.job === run.job) {
      last.times++;
      last.failed += run.error ? 1 : 0;
      last.cost += Number(run.cost ?? 0);
      continue;
    }
    if (out.length === count) break;
    out.push({
      id: run.id,
      source: run.source,
      job: run.job,
      started: run.started,
      finished: run.finished,
      summary: run.summary,
      error: run.error,
      times: 1,
      failed: run.error ? 1 : 0,
      cost: Number(run.cost ?? 0),
    });
  }
  return out;
}
