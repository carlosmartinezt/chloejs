import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { labelOf, words } from "../lib/format.ts";
import { Link } from "./components/Link.tsx";
import { Options } from "./components/Options.tsx";
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

  const flip = async (key: string, save: () => Promise<{ features: AgentFeature[]; tools: AgentTool[] }>) => {
    setBusy(key);
    setTrouble("");
    try {
      // The agent as it now loads: asking again now could still find the one before.
      const now = await save();
      setFeatures(now.features);
      setTools(now.tools);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const flipFeature = (feature: AgentFeature) => flip(feature.name, () => api.setFeature(agent, { name: feature.name, on: !feature.on }));
  const fillIn = (feature: AgentFeature, set: Record<string, unknown>) => flip(feature.name, () => api.setFeature(agent, { name: feature.name, set }));
  const flipTool = (tool: AgentTool) => flip(tool.name, () => api.setTool(agent, tool.name, !tool.on));

  const from = (source?: string) => (tools ?? []).filter((tool) => tool.from === source);
  const connections = [
    ...new Set(
      (tools ?? []).map((tool) => tool.from).filter((one): one is string => !!one && one !== "always" && !one.startsWith("features.")),
    ),
  ].sort();
  const each = (list: AgentTool[], switches: boolean) => <Each tools={list} busy={busy} flip={switches ? flipTool : undefined} />;

  return (
    <>
      <div className="head">
        <h1>Tools</h1>
      </div>
      <p className="empty">
        What {labelOf(agent)} can do. Open a tool to read what the model is told about it. A switch changes{" "}
        <code>agent.ts</code>, and the agent is loaded again with the change.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {tools === null && !trouble && <p className="dim">Loading</p>}

      {tools && (
        <>
          <h2>Always On</h2>
          <p className="empty">
            Every agent has these, with nothing to switch: reading its own files and skills and, when you are the one
            writing to it, its runs and the guides, and trying a job. None changes anything.
          </p>
          <ul className="ways tools">
            <li>{each(from("always"), false)}</li>
          </ul>

          <h2>Features</h2>
          <ul className="ways tools">
            {features.map((feature) => (
              <li key={feature.name} className={feature.on ? "" : "off"}>
                <span className="line">
                  <b>{feature.label}</b>
                  <Switch on={feature.on} saving={busy === feature.name} disabled={busy !== ""} flip={() => flipFeature(feature)} />
                </span>
                <span className="does">{feature.does}</span>
                {feature.needs && feature.needs.missing.length > 0 && (
                  <span className="needs">
                    Needs {feature.needs.name}: {feature.needs.missing.join(" ")} <Link to={{ at: "connections", agent }}>Connections</Link>
                  </span>
                )}
                {each(from(`features.${feature.name}`), feature.on && feature.tools.length > 1 && !feature.fields)}
                {feature.on && feature.fields && (
                  <Options fields={feature.fields} busy={busy !== ""} save={(set) => fillIn(feature, set)} />
                )}
              </li>
            ))}
          </ul>

          <h2>Declared tools</h2>
          <p className="empty">
            Named in <code>agent.ts</code>, with the limits it gave each one.
          </p>
          <ul className="ways tools">
            {from(undefined).length > 0 && <li>{each(from(undefined), true)}</li>}
            {connections.map((source) => (
              <li key={source}>
                <span className="line">
                  <b>{source}</b>
                </span>
                {each(from(source), true)}
              </li>
            ))}
            {from(undefined).length === 0 && connections.length === 0 && <li className="needs">None.</li>}
          </ul>
        </>
      )}
    </>
  );
}

/** A switch with its word: the state, or "Saving" while the file is written and the agent loaded again. */
function Switch({ on, saving, disabled, flip }: { on: boolean; saving: boolean; disabled: boolean; flip: () => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} disabled={disabled} onChange={flip} />
      {saving ? "Saving" : on ? "On" : "Off"}
    </label>
  );
}

/** Tools in words, each opening to what the model is told and what it takes, with a switch when `flip` is given. */
function Each({
  tools,
  busy,
  flip,
}: {
  tools: AgentTool[];
  busy: string;
  flip?: (tool: AgentTool) => void;
}) {
  return (
    <div className="each">
      {tools.map((tool) => (
        <div key={tool.name} className={tool.on ? "tool" : "tool off"}>
          <details>
            <summary>{tool.title ?? words(tool.name)}</summary>
            <div className="about">
              <p>{tool.does}</p>
              <p className="dim">
                The model calls it <code>{tool.name}</code>
                {tool.ownerOnly ? ", only when you are the one writing to it" : ""}
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
          {flip && <Switch on={tool.on} saving={busy === tool.name} disabled={busy !== ""} flip={() => flip(tool)} />}
        </div>
      ))}
    </div>
  );
}
