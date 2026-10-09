import { kindOf, labelOf } from "../lib/format.ts";
import type { AgentSummary } from "../lib/types.ts";
import { Link } from "./components/Link.tsx";

/**
 * What an agent runs on a clock: when each job goes, what it is written in,
 * and the way to start one by hand. A job with no cron line runs only when
 * somebody or something asks for it.
 */
export function Jobs({
  agent,
  id,
  running,
  offline,
  cannot,
  fire,
}: {
  agent?: AgentSummary;
  id: string;
  running: string[];
  /** Reached through a cloud, and its connection is not open: nothing can be started. */
  offline: boolean;
  /** Why this account may not start a job here, when it may not: a guest who was not given that. */
  cannot?: string;
  fire: (agent: string, job: string) => Promise<void>;
}) {
  if (!agent) return <p className="dim">Loading</p>;

  return (
    <>
      <div className="head">
        <h1>Jobs</h1>
      </div>
      <p className="empty">What {labelOf(id)} runs on a clock, and what it will run when asked.</p>
      {agent.jobs.length === 0 ? (
        <p className="empty frame">
          Nothing on a clock. Put a markdown file in its jobs folder, or name one in its definition.
        </p>
      ) : (
        <ul className="ways">
          {agent.jobs.map((job) => {
            const now = running.includes(`${id}/${job.id}`);
            return (
              <li key={job.id}>
                <span className="line">
                  <b className="num">{job.id}</b>
                  {job.channels ? (
                    <span className="dim">answers {job.channels.join(" and ")}</span>
                  ) : (
                    <button
                      className="small"
                      onClick={() => fire(id, job.id)}
                      disabled={now || offline || Boolean(cannot)}
                      title={offline ? "This runtime is offline." : cannot}
                    >
                      {now ? "Running" : "Run now"}
                    </button>
                  )}
                </span>
                {job.description && <span className="does">{job.description}</span>}
                <span className="num dim needs">
                  {job.channels ? `each message on ${job.channels.join(" and ")}` : (job.when ?? job.cron ?? "when started")} · {job.timezone} · {job.code ? "code" : job.model}
                </span>
                {job.files.length ? (
                  <span className="num needs made">
                    {job.files.map((path) => (
                      <Link key={path} to={{ at: "file", agent: id, path }} className={kindOf(path)}>
                        {path}
                      </Link>
                    ))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
