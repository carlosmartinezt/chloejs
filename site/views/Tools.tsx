import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { labelOf, words } from "../lib/format.ts";
import type { AgentFeature, AgentTool } from "../lib/types.ts";

/**
 * What an agent can do, by where each tool comes from: each feature with its
 * switch, then the agent's own tools, then each connection's. A tool opens to
 * the words the model is given for it and what it takes, so what is here is
 * what it knows. A switch changes `features` in the agent's agent.ts.
 */
export function Tools({ agent }: { agent: string }) {
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [features, setFeatures] = useState<AgentFeature[]>([]);
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
    // Somebody who may not read the features still sees the tools.
    api.features(agent).then(
      (all) => !stale && setFeatures(all),
      () => !stale && setFeatures([]),
    );
    return () => void (stale = true);
  }, [agent]);

  const flip = async (feature: AgentFeature) => {
    setBusy(feature.name);
    setTrouble("");
    try {
      // The agent as it now loads: asking again now could still find the one before.
      const now = await api.setFeature(agent, feature.name, !feature.on);
      setFeatures(now.features);
      setTools(now.tools);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  const from = (source?: string) => (tools ?? []).filter((tool) => tool.from === source);
  const others = [
    ...new Set((tools ?? []).map((tool) => tool.from).filter((one): one is string => !!one && !one.startsWith("features."))),
  ].sort();

  return (
    <>
      <div className="head">
        <h1>Tools</h1>
      </div>
      <p className="empty">
        What {labelOf(agent)} can do. Open a tool to read what the model is told about it. A switch changes{" "}
        <code>features</code> in its <code>agent.ts</code>.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {tools === null && !trouble && <p className="dim">Loading</p>}

      {tools && (
        <ul className="ways tools">
          {features.map((feature) => (
            <li key={feature.name} className={feature.on ? "" : "off"}>
              <span className="line">
                <b>{words(feature.name)}</b>
                <label className="switch">
                  <input type="checkbox" checked={feature.on} disabled={busy !== ""} onChange={() => flip(feature)} />
                  {busy === feature.name ? "Saving" : feature.on ? "On" : "Off"}
                </label>
              </span>
              <span className="does">{feature.does}</span>
              {feature.on ? (
                <Each tools={from(`features.${feature.name}`)} />
              ) : (
                <span className="needs">Adds {feature.tools.map(words).join(", ")}.</span>
              )}
            </li>
          ))}
          <li>
            <span className="line">
              <b>Its own</b>
            </span>
            <span className="does">
              The tools its <code>agent.ts</code> names. To take one away, take its line out there.
            </span>
            {from(undefined).length ? <Each tools={from(undefined)} /> : <span className="needs">None.</span>}
          </li>
          {others.map((source) => (
            <li key={source}>
              <span className="line">
                <b>{source}</b>
              </span>
              <Each tools={from(source)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Tools by their names in words, each opening to what the model is told and what it takes. */
function Each({ tools }: { tools: AgentTool[] }) {
  return (
    <div className="each">
      {tools.map((tool) => (
        <details key={tool.name}>
          <summary>{words(tool.name)}</summary>
          <div className="about">
            <p>{tool.does}</p>
            <p className="dim">
              The model calls it <code>{tool.name}</code>
              {tool.takes.length ? ", with:" : ", with nothing."}
            </p>
            {tool.takes.length > 0 && (
              <ul>
                {tool.takes.map((one) => (
                  <li key={one.name}>
                    <code>{one.name}</code>
                    {one.required ? "" : " (optional)"}
                    {one.about && <span className="dim">: {one.about}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
