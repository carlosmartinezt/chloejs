import { useState } from "react";

import type { AgentSummary, ParkedRun, RunRow } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ago, labelOf, many, stateOf, when } from "../lib/format.ts";
import { Code } from "./components/Code.tsx";
import { Link } from "./components/Link.tsx";
import { Standing } from "./components/Tree.tsx";

/** How far back the figures at the top look. */
const DAYS = 7;

/** How many of an agent's skills or tools a tile names before it counts the rest. */
const FEW = 4;

/** The smallest agent there is, and the line that lists it. */
const AGENT = `// agents/helper/agent.ts
import { defineAgent } from "@chloejs/core";

export default defineAgent({
  id: "helper",
  description: "Answers my questions, briefly.",
  instructions: "Answer in a few lines.",
});

// chloe.config.ts
import helper from "./agents/helper/agent.ts";
// ...
  agents: [helper],
`;

/** What a new project's owner can hand their coding agent for the first agent. */
const FIRST =
  "Write me a Chloe agent that tells me every morning at 7 what the weather will be here, and that I can chat with on the page.";

/**
 * The way in. Every agent, and above them the few numbers that say how much is
 * going on at all. The only thing it asks you to do is pick one: what an agent
 * runs and what it has done are inside the agent, not out here.
 */
export function Home({
  agents,
  runs,
  parked,
  running,
  refresh,
}: {
  agents: AgentSummary[];
  runs: RunRow[];
  parked: ParkedRun[];
  running: string[];
  refresh: () => void;
}) {
  const since = Date.now() - DAYS * 86_400_000;
  const lately = runs.filter((run) => new Date(run.started).getTime() > since);
  const figures: [number, string][] = [
    [agents.length, many(agents.length, "agent")],
    [agents.reduce((n, one) => n + one.jobs.length, 0), "jobs on a clock"],
    [lately.length, `runs in ${DAYS} days`],
    [agents.reduce((n, one) => n + one.skills.length, 0), "skills between them"],
  ];

  return (
    <>
      {parked.map((one) => (
        <Waiting key={one.id} parked={one} done={refresh} />
      ))}

      <div className="head">
        <h1>Your agents</h1>
      </div>

      {agents.length === 0 ? (
        <First />
      ) : (
        <>
          <div className="figures">
            {figures.map(([count, what]) => (
              <div key={what}>
                <b>{count}</b>
                <span>{what}</span>
              </div>
            ))}
          </div>
          <div className="tiles">
            {agents.map((agent) => (
              <Link to={{ at: "chat", agent: agent.id }} className="tile" key={agent.id}>
                <span className="name">
                  {labelOf(agent.id)}
                  <Standing state={stateOf(agent.id, { runs, parked, running })} />
                </span>
                <span className="num model">{agent.model}</span>
                <Few what="Skills" names={agent.skills} />
                <Few what="Tools" names={agent.tools} />
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** The first few of them by name, and how many more there are. */
function Few({ what, names }: { what: string; names: string[] }) {
  return (
    <span className="few">
      <i>{what}</i>
      {names.length === 0 ? (
        <span className="dim">none</span>
      ) : (
        <span className="num">
          {names.slice(0, FEW).join(", ")}
          {names.length > FEW && <span className="dim"> +{names.length - FEW}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * A job that stopped to ask somebody. It is the only thing on the page that
 * shouts, because it is the only thing that does not carry on without a person.
 */
function Waiting({ parked, done }: { parked: ParkedRun; done: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState("");

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.answer(parked.id, text);
      done();
    } catch (error) {
      setTrouble((error as Error).message);
      setSending(false);
    }
  }

  return (
    <div className="waiting">
      <div className="who">
        {parked.agent}/{parked.job} asked {ago(parked.asked)}, waiting until {when(parked.expires)}
      </div>
      <p className="q">{parked.question}</p>
      <div className="reply">
        <input
          value={text}
          placeholder="Your answer"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void send()}
        />
        <button className="go" onClick={send} disabled={!text.trim() || sending}>
          {sending ? "Sending" : "Send answer"}
        </button>
      </div>
      {trouble && <p className="bad">{trouble}</p>}
    </div>
  );
}

/** A project with no agents: what an agent is, and what to ask for the first one. */
function First() {
  return (
    <section className="empty frame first">
      <p>
        No agents yet. An agent is a folder with an <code>agent.ts</code> in it, listed in <code>chloe.config.ts</code>:
      </p>
      <Code text={AGENT} language="agent.ts" />
      <p>Or ask the coding agent that set Chloe up, in the same folder, to write one. Say what it should do, for example:</p>
      <Code text={FIRST} />
      <p>
        It shows up here as soon as it is listed. Stuck? <Link to={{ at: "help" }}>Get help</Link>.
      </p>
    </section>
  );
}
