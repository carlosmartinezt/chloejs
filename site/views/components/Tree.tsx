import { useState } from "react";

import type { Entry } from "../../lib/types.ts";
import { kindOf, saidState, type State } from "../../lib/format.ts";
import type { View } from "../../lib/route.ts";
import { Collapse } from "./Collapse.tsx";
import { Link } from "./Link.tsx";
import { Places } from "./Places.tsx";

/**
 * The sidebar of one agent: everywhere it has, and, on the Files page, the
 * files it is made of under that. Its chat and its memory put their own thing in the same place, so
 * the column never changes shape as you move between them.
 */
export function Rail({ agent, view, files }: { agent: string; view: View; files: Entry[] | null }) {
  // The tree belongs to the Files page and to a file in it. Everywhere else it
  // is a second thing to read in a column that is there to move around in.
  const tree = view.at === "agent" || view.at === "file";
  return (
    <nav className="rail">
      <Collapse closeOn={view.at === "file" ? `${view.at}:${view.path}` : view.at}>
        <Places agent={agent} view={view} />
        {tree && files?.length ? (
          <>
            <p className="what">Files</p>
            <Branch entries={files} agent={agent} view={view} />
          </>
        ) : null}
      </Collapse>
    </nav>
  );
}

function Branch({ entries, agent, view }: { entries: Entry[]; agent: string; view: View }) {
  // Folders start open: an agent is small, and the shape of it is the point.
  const [shut, setShut] = useState<string[]>([]);

  return (
    <ul className="tree">
      {entries.map((entry) =>
        entry.dir ? (
          <li key={entry.path}>
            {/* The caret folds it away, the name opens it. */}
            <span className="node folder">
              <button
                className="flip"
                aria-label={shut.includes(entry.path) ? `Open ${entry.name}` : `Fold ${entry.name}`}
                onClick={() =>
                  setShut((paths) =>
                    paths.includes(entry.path) ? paths.filter((p) => p !== entry.path) : [...paths, entry.path],
                  )
                }
              >
                <Caret down={!shut.includes(entry.path)} />
              </button>
              <Link
                to={{ at: "file", agent, path: entry.path }}
                className="grow"
                current={view.at === "file" && view.path === entry.path}
              >
                {entry.name}
              </Link>
            </span>
            {!shut.includes(entry.path) && entry.children?.length ? (
              <Branch entries={entry.children} agent={agent} view={view} />
            ) : null}
          </li>
        ) : (
          <li key={entry.path}>
            <Link
              to={{ at: "file", agent, path: entry.path }}
              className={`node ${kindOf(entry.name)}`}
              current={view.at === "file" && view.path === entry.path}
            >
              <span className="caret" />
              <span className="grow">{entry.name}</span>
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

function Caret({ down }: { down: boolean }) {
  return (
    <svg className={down ? "caret down" : "caret"} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Dot({ state }: { state: State }) {
  if (!state) return null;
  return <span className={`dot ${state}`} title={saidState[state]} />;
}

/** The same thing with its meaning written out, for where there is room. */
export function Standing({ state }: { state: State }) {
  if (!state) return null;
  return (
    <span className={`standing ${state}`}>
      <span className="dot" />
      {saidState[state]}
    </span>
  );
}
