import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { nameOf } from "../lib/format.ts";
import { Each } from "./components/ToolList.tsx";
import type { AgentTool } from "../lib/types.ts";

/**
 * What an agent can do because you set it up: the tools its `agent.ts` names,
 * then each connection's. Everything chloe ships is on the Abilities page. A
 * tool opens to the words the model is given for it and what it takes, so what
 * is here is what it knows.
 */
export function Tools({ agent }: { agent: string }) {
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let stale = false;
    setTools(null);
    setTrouble("");
    api.agentTools(agent).then(
      (all) => !stale && setTools(all),
      (error: Error) => !stale && setTrouble(missing(error, "tools")),
    );
    return () => void (stale = true);
  }, [agent]);

  const flipTool = async (tool: AgentTool) => {
    setBusy(tool.name);
    setTrouble("");
    try {
      const now = await api.setTool(agent, tool.name, !tool.on);
      setTools(now.tools);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  const from = (source?: string) => (tools ?? []).filter((tool) => tool.from === source);
  const connections = [
    ...new Set(
      (tools ?? []).map((tool) => tool.from).filter((one): one is string => !!one && one !== "always" && !one.startsWith("abilities.")),
    ),
  ].sort();
  const each = (list: AgentTool[]) => <Each tools={list} busy={busy} flip={flipTool} />;

  return (
    <>
      <div className="head">
        <h1>Tools</h1>
      </div>
      <p className="empty">
        What {nameOf(agent)} can do because you set it up: the tools its <code>agent.ts</code> names, and each connection's.
        Open one to read what the model is told about it. Everything chloe ships is under Abilities. A switch changes{" "}
        <code>agent.ts</code>, and the agent is loaded again with the change.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {tools === null && !trouble && <p className="dim">Loading</p>}

      {tools && (
        <>
          <h2>Declared tools</h2>
          <ul className="ways tools">
            {from(undefined).length > 0 && <li>{each(from(undefined))}</li>}
            {connections.map((source) => (
              <li key={source}>
                <span className="line">
                  <b>{source}</b>
                </span>
                {each(from(source))}
              </li>
            ))}
            {from(undefined).length === 0 && connections.length === 0 && (
              <li className="needs">None. What chloe ships for you to switch on is under Abilities.</li>
            )}
          </ul>
        </>
      )}
    </>
  );
}
