import { useEffect, useState } from "react";

import { api, useLoad, type Entry } from "../api.ts";
import { Link } from "../route.tsx";

/**
 * One agent's memory: its files, and the one picked shown in a frame.
 *
 * The frame is the whole of the viewer's safety. The file is somebody's own
 * HTML and runs its own script, so it is loaded from the /memory/<pass>/
 * address the API hands out, sandboxed, and never with allow-same-origin.
 */
export function Memory({ agent, path }: { agent: string; path: string }) {
  const { data: about } = useLoad(() => api.agent(agent), [agent]);
  const { data: tree, trouble } = useLoad(() => api.memory(agent), [agent]);
  const [src, setSrc] = useState("");
  const here = `/agents/${encodeURIComponent(agent)}/memory`;

  // A pass lasts ten minutes, so each file opened asks for a fresh one.
  useEffect(() => {
    setSrc("");
    if (!path) return;
    api.memoryPass(agent).then(({ at }) => setSrc(`${at}/${path.split("/").map(encodeURIComponent).join("/")}`));
  }, [agent, path]);

  const label = about?.memory ?? "Memory";
  return (
    <>
      <p className="crumbs">
        <Link to="/">Agents</Link> / <Link to={`/agents/${encodeURIComponent(agent)}`}>{about?.label || agent}</Link> /{" "}
        {path ? <Link to={here}>{label}</Link> : label}
        {path && ` / ${path}`}
      </p>
      <div className="split">
        <aside className="tree">
          {trouble && <p className="bad">{trouble}</p>}
          {tree && (tree.length ? <Tree entries={tree} here={here} open={path} /> : <p className="dim">Nothing here yet.</p>)}
        </aside>
        <section>
          {src ? (
            <iframe
              src={src}
              title={path}
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            />
          ) : (
            <p className="dim empty">
              Pick a file. Every one opened here is written to the audit log, which reading it from a shell is not.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function Tree({ entries, here, open }: { entries: Entry[]; here: string; open: string }) {
  return (
    <ul>
      {entries.map((one) =>
        one.dir ? (
          <li key={one.path}>
            <details open={open.startsWith(`${one.path}/`)}>
              <summary>{one.name}</summary>
              {one.children?.length ? <Tree entries={one.children} here={here} open={open} /> : null}
            </details>
          </li>
        ) : (
          <li key={one.path}>
            <Link
              to={`${here}/${one.path.split("/").map(encodeURIComponent).join("/")}`}
              className={one.path === open ? "here" : undefined}
            >
              {one.name}
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}
