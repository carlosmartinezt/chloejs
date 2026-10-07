import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { labelOf } from "../lib/format.ts";
import type { AgentTool } from "../lib/types.ts";

/**
 * What an agent can do. A tool is a thing it may run, with the same words the
 * model is given for when to reach for it, so what is here is what it knows.
 */
export function Tools({ agent }: { agent: string }) {
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [trouble, setTrouble] = useState("");

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

  return (
    <>
      <div className="head">
        <h1>Tools</h1>
      </div>
      <p className="empty">What {labelOf(agent)} can do, in the words the model is given for each one.</p>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {!trouble && tools === null && <p className="dim">Loading</p>}
      {tools?.length === 0 && (
        <p className="empty frame">{labelOf(agent)} is bound no tools. It can only answer.</p>
      )}
      {tools?.length ? (
        <ul className="ways">
          {tools.map((tool) => (
            <li key={tool.name}>
              <span className="line">
                <b className="num">{tool.name}</b>
              </span>
              <span className="does">{tool.does}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
