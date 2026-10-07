import type { ReactNode } from "react";

import { api, useLoad, type Agent } from "../api.ts";
import { plural } from "../format.ts";
import { Link } from "../route.tsx";
import { Runs } from "./Runs.tsx";

/** Every agent that is loaded, and what ran lately. */
export function Home() {
  const { data, trouble } = useLoad(api.agents, []);
  return (
    <>
      <div className="head">
        <h1>Agents</h1>
        {data && <span className="dim">{plural(data.length, "agent")} loaded</span>}
      </div>
      {trouble && <p className="bad">{trouble}</p>}
      {data?.length === 0 && (
        <p className="dim">
          None. An agent runs when <code>chloe.config.ts</code> lists it.
        </p>
      )}
      <div className="cards">
        {data?.map((agent) => <Card key={agent.id} agent={agent} />)}
      </div>

      <h2>Recent runs</h2>
      <Runs />

      <p className="dim small foot">
        This is the runtime&rsquo;s own page. <code>npm install @chloejs/ui</code> replaces it with a dashboard that
        also has conversations, files and settings.
      </p>
    </>
  );
}

function Card({ agent }: { agent: Agent }) {
  const href = `/agents/${encodeURIComponent(agent.id)}`;
  return (
    <Link to={href} className="card agent">
      <div className="title">
        <strong>{agent.label || agent.id}</strong>
        {agent.label && agent.label !== agent.id && <code className="dim">{agent.id}</code>}
      </div>
      <p className="dim">{agent.description || "No description."}</p>
      <div className="tags">
        <span className="tag mono">{agent.model}</span>
        <span className="tag">{plural(agent.jobs.length, "job")}</span>
        {agent.channels.map((one) => (
          <span key={one} className="tag">{one}</span>
        ))}
      </div>
    </Link>
  );
}

/** One agent: how it is set up, its jobs, how to reach it, and its runs. Read only: its folder is on disk. */
export function AgentPage({ id }: { id: string }) {
  const { data: agent, trouble } = useLoad(() => api.agent(id), [id]);
  if (trouble) return <p className="bad">{trouble}</p>;
  if (!agent) return null;
  const memory = `/agents/${encodeURIComponent(agent.id)}/memory`;

  return (
    <>
      <p className="crumbs">
        <Link to="/">Agents</Link> / {agent.label || agent.id}
      </p>
      <div className="head">
        <h1>{agent.label || agent.id}</h1>
        <Link to={memory} className="button">
          {agent.memory}
        </Link>
      </div>
      <p className="dim">{agent.description || "No description."}</p>

      <dl className="facts">
        <Fact name="Id"><code>{agent.id}</code></Fact>
        <Fact name="Model"><code>{agent.model}</code></Fact>
        <Fact name="Channels"><List items={agent.channels} /></Fact>
        <Fact name="Tools"><List items={agent.tools} /></Fact>
        <Fact name="Skills"><List items={agent.skills} /></Fact>
      </dl>

      <h2>Jobs</h2>
      {agent.jobs.length ? (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>When</th>
                <th>How</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {agent.jobs.map((job) => (
                <tr key={job.id}>
                  <td><code>{job.id}</code></td>
                  <td className="nowrap">
                    {job.cron ? job.when ?? <code>{job.cron}</code> : <span className="dim">when started</span>}
                  </td>
                  <td className="dim mono small">{job.code ? "code" : job.model}</td>
                  <td className="dim">{job.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dim">No jobs.</p>
      )}

      <h2>Reaching it</h2>
      {agent.api ? (
        <>
          <p>It binds an api channel, so a token may talk to it and run its jobs.</p>
          <pre>{`curl -X POST ${location.origin}/api/agents/${agent.id}/chat \\
  -H "authorization: Bearer $CHLOE_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"prompt":"what is late?"}'`}</pre>
        </>
      ) : (
        <p className="dim">
          It has no api channel, so only the account can talk to it. Add <code>apiChannel()</code> to the channels in
          its <code>agent.ts</code> to open it to a token.
        </p>
      )}

      <h2>Recent runs</h2>
      <Runs agent={agent.id} />
    </>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <span className="dim">none</span>;
  return (
    <span className="tags">
      {[...items].sort().map((one) => (
        <code key={one} className="tag">{one}</code>
      ))}
    </span>
  );
}
