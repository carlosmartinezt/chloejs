import { words } from "../../lib/format.ts";
import type { AgentTool } from "../../lib/types.ts";

/** A switch with its word: the state, or "Saving" while the file is written and the agent loaded again. */
export function Switch({ on, saving, disabled, flip }: { on: boolean; saving: boolean; disabled: boolean; flip: () => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} disabled={disabled} onChange={flip} />
      {saving ? "Saving" : on ? "On" : "Off"}
    </label>
  );
}

/** Tools in words, each opening to what the model is told and what it takes, with a switch when `flip` is given. */
export function Each({
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
