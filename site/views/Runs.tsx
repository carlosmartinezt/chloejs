import { useState } from "react";

import { api, useLoad, type Run } from "../api.ts";
import { ago, exact, money } from "../format.ts";
import { Link } from "../route.tsx";

/** The latest runs, every agent's or one's. A row opens to show what was asked and answered. */
export function Runs({ agent }: { agent?: string }) {
  const { data, trouble } = useLoad(() => api.runs(agent), [agent]);
  const [open, setOpen] = useState<string>();

  if (trouble) return <p className="bad">{trouble}</p>;
  if (!data) return <p className="dim">Loading.</p>;
  if (!data.length) return <p className="dim">Nothing has run yet.</p>;
  return (
    <div className="table">
      <table>
        <thead>
          <tr>
            <th />
            <th>When</th>
            {!agent && <th>Agent</th>}
            <th>What</th>
            <th>Model</th>
            <th className="right">Cost</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {data.map((run) => (
            <Row key={run.id} run={run} agent={agent} open={open === run.id} toggle={() => setOpen(open === run.id ? undefined : run.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ run, agent, open, toggle }: { run: Run; agent?: string; open: boolean; toggle: () => void }) {
  const state = !run.finished ? "running" : run.error ? "failed" : "done";
  return (
    <>
      <tr className="click" onClick={toggle}>
        <td>
          <span className={`state ${state}`} title={state} />
        </td>
        <td className="dim nowrap" title={exact(run.started)}>{ago(run.started)}</td>
        {!agent && (
          <td>
            <Link to={`/agents/${encodeURIComponent(run.agent)}`} onClick={(event) => event.stopPropagation()}>
              {run.agent}
            </Link>
          </td>
        )}
        <td>{run.job ? <code>{run.job}</code> : <span className="dim">{run.source}</span>}</td>
        <td className="dim mono small nowrap">{run.model}</td>
        <td className="right dim mono small">{money(run.cost)}</td>
        <td className={`clip ${run.error ? "bad" : ""}`}>{run.error ?? run.summary ?? run.reply ?? ""}</td>
      </tr>
      {open && (
        <tr className="more">
          <td />
          <td colSpan={agent ? 5 : 6}>
            {run.asked && (
              <>
                <h4>Asked</h4>
                <pre>{run.asked}</pre>
              </>
            )}
            {run.error && (
              <>
                <h4>Failed</h4>
                <pre className="bad">{run.error}</pre>
              </>
            )}
            {run.reply && (
              <>
                <h4>Answered</h4>
                <pre>{run.reply}</pre>
              </>
            )}
            <p className="dim small">
              {run.steps} step{run.steps === 1 ? "" : "s"}, from {run.source}, started {exact(run.started)}.{" "}
              <code>{run.id}</code>
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
