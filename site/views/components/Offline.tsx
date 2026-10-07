import { when } from "../../lib/format.ts";
import type { Workspace } from "../../lib/types.ts";

/**
 * A workspace whose runtime is not connected, seen from inside it. The pages
 * around it still show what the runtime synced while it was connected; this
 * panel says the state, which machine it was on, and when it was last heard.
 * It is light red rather than white so nobody reads a page of stale things as
 * a live one.
 */
export function Offline({ name, where }: { name: string | null; where: Workspace | null }) {
  const label = where?.label ?? name;
  const said = where?.lastSeen ? `Offline since ${when(where.lastSeen)}. Showing what was synced.` : undefined;
  return (
    <section className="ready offline">
      <header>
        <div>
          <h2>
            <span className="dot bad" aria-hidden="true" title={said} /> {label} is offline
          </h2>
          <p className="dim">
            {said ?? `Nothing has shown up with this workspace\u2019s key yet.`}
          </p>
          <p className="dim">Last connected from {where?.machine ?? "somewhere"}.</p>
        </div>
        <button className="small" onClick={() => window.location.reload()}>
          Check again
        </button>
      </header>
    </section>
  );
}
