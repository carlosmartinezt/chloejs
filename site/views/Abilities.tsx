import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { nameOf } from "../lib/format.ts";
import { Link } from "./components/Link.tsx";
import { Options } from "./components/Options.tsx";
import { Each, Switch } from "./components/ToolList.tsx";
import type { AgentAbility, AgentTool } from "../lib/types.ts";

/**
 * Everything chloe brings an agent, built in: the tools every agent has with
 * nothing to switch, and each ability with its switch and its fields. What you
 * set up yourself, your own tools and your connections', is on the Tools page.
 */
export function Abilities({ agent }: { agent: string }) {
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [abilities, setAbilities] = useState<AgentAbility[]>([]);
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let stale = false;
    setTools(null);
    setTrouble("");
    api.agentTools(agent).then(
      (all) => !stale && setTools(all),
      (error: Error) => !stale && setTrouble(missing(error, "abilities")),
    );
    api.abilities(agent).then(
      (all) => !stale && setAbilities(all),
      () => !stale && setAbilities([]),
    );
    return () => void (stale = true);
  }, [agent]);

  const flip = async (key: string, save: () => Promise<{ abilities: AgentAbility[]; tools: AgentTool[] }>) => {
    setBusy(key);
    setTrouble("");
    try {
      // The agent as it now loads: asking again now could still find the one before.
      const now = await save();
      setAbilities(now.abilities);
      setTools(now.tools);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const flipAbility = (ability: AgentAbility) => flip(ability.name, () => api.setAbility(agent, { name: ability.name, on: !ability.on }));
  const fillIn = (ability: AgentAbility, set: Record<string, unknown>) => flip(ability.name, () => api.setAbility(agent, { name: ability.name, set }));
  const flipTool = async (tool: AgentTool) => {
    setBusy(tool.name);
    setTrouble("");
    try {
      setTools((await api.setTool(agent, tool.name, !tool.on)).tools);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  const from = (source: string) => (tools ?? []).filter((tool) => tool.from === source);

  return (
    <>
      <div className="head">
        <h1>Abilities</h1>
      </div>
      <p className="empty">
        Everything {nameOf(agent)} comes with, built into chloe. A switch changes <code>agent.ts</code>, and the agent is
        loaded again with the change. What you set up yourself is under Tools.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {tools === null && !trouble && <p className="dim">Loading</p>}

      {tools && (
        <>
          <h2>Always on</h2>
          <p className="empty">
            Every agent has these, with nothing to switch: reading its own files and skills and, when you are the one
            writing to it, its runs and the guides, and trying a job. None changes anything.
          </p>
          <ul className="ways tools">
            <li>
              <Each tools={from("always")} busy={busy} />
            </li>
          </ul>

          <h2>Switched on or off</h2>
          <ul className="ways tools">
            {abilities.map((ability) => (
              <li key={ability.name} className={ability.on ? "" : "off"}>
                <span className="line">
                  <b>{ability.label}</b>
                  <Switch on={ability.on} saving={busy === ability.name} disabled={busy !== ""} flip={() => flipAbility(ability)} />
                </span>
                <span className="does">{ability.does}</span>
                {ability.needs && ability.needs.missing.length > 0 && (
                  <span className="needs">
                    Needs {ability.needs.name}: {ability.needs.missing.join(" ")} <Link to={{ at: "connections", agent }}>Connections</Link>
                  </span>
                )}
                <Each tools={from(`abilities.${ability.name}`)} busy={busy} flip={ability.on ? flipTool : undefined} />
                {ability.on && ability.fields && (
                  <Options fields={ability.fields} busy={busy !== ""} save={(set) => fillIn(ability, set)} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
