import { useCallback, useEffect, useState } from "react";

import { api } from "../../lib/api.ts";
import { ago, labelOf, many, when } from "../../lib/format.ts";
import type { Change, Changes, Place, RunCommit } from "../../lib/types.ts";
import { Link } from "./Link.tsx";

/** What the page calls each of an agent's two places. */
const PLACE: Record<Place, string> = { memory: "memory", folder: "own files" };

/** Enough lines of a diff to read one change by. A first commit can be every file there is. */
const LINES = 4000;

/**
 * An agent's changes, newest first: what it did to its memory and to its own
 * files, with the ones it made since you last looked marked, and a button that
 * says you have.
 */
export function AgentChanges({ agent }: { agent: string }) {
  const [found, setFound] = useState<Changes | null>(null);
  const [trouble, setTrouble] = useState("");

  const load = useCallback(
    () => api.changes(agent, { limit: 30 }).then(setFound, (error: Error) => setTrouble(error.message)),
    [agent],
  );
  useEffect(() => {
    setFound(null);
    setTrouble("");
    void load();
  }, [load]);

  return (
    <>
      <div className="head spread">
        <h2>
          Changes
          {found && found.unseen > 0 && <span className="new-count">{found.unseen} new since you last looked</span>}
        </h2>
        {found && found.unseen > 0 ? (
          <button className="small" onClick={() => void api.seen(agent).then(load)}>
            Seen
          </button>
        ) : (
          found?.seen && <span className="dim">You last looked {ago(found.seen)}</span>
        )}
      </div>
      {trouble && <p className="bad">{trouble}</p>}
      {!found && !trouble && <p className="dim">Loading</p>}
      {found && found.changes.length === 0 && <p className="empty">Nothing it keeps is in git, so there is no history to show.</p>}
      {found && <ChangeList agent={agent} changes={found.changes} changed={load} />}
    </>
  );
}

/** Every commit that touched one file, newest first. */
export function FileHistory({ agent, place, path }: { agent: string; place: Place; path: string }) {
  const [found, setFound] = useState<Change[] | null>(null);
  const [trouble, setTrouble] = useState("");

  const load = useCallback(
    () =>
      api.changes(agent, { place, path }).then(
        (got) => setFound(got.changes),
        (error: Error) => setTrouble(error.message),
      ),
    [agent, place, path],
  );
  useEffect(() => {
    setFound(null);
    setTrouble("");
    void load();
  }, [load]);

  if (trouble) return <p className="bad">{trouble}</p>;
  if (!found) return <p className="dim">Loading</p>;
  if (found.length === 0) return <p className="empty">No commit has touched {path} yet, so there is no history to show.</p>;
  return <ChangeList agent={agent} changes={found} changed={load} />;
}

function ChangeList({ agent, changes, changed }: { agent: string; changes: Change[]; changed: () => void }) {
  return (
    <div className="changes">
      {changes.map((one) => (
        <ChangeCard key={`${one.in}-${one.id}`} agent={agent} change={one} changed={changed} />
      ))}
    </div>
  );
}

/**
 * One commit, closed to a line. Opened, it fetches what it changed: the files,
 * the diff, the run it came from, and a button to undo it.
 */
export function ChangeCard({
  agent,
  change,
  changed,
}: {
  agent: string;
  change: RunCommit & Partial<Change>;
  changed?: () => void;
}) {
  const [shown, setShown] = useState<(Change & { diff: string }) | null>(null);
  const [trouble, setTrouble] = useState("");
  const [said, setSaid] = useState("");

  function opened(open: boolean) {
    if (!open || shown) return;
    api.change(agent, change.in, change.id).then(setShown, (error: Error) => setTrouble(error.message));
  }

  async function undo() {
    if (!window.confirm(`Undo "${change.subject}"? Every file it changed goes back to how it was before it.`)) return;
    try {
      const done = await api.undo(agent, change.in, change.id);
      setSaid(`Undone: ${many(done.files.length, "file")} put back${done.id ? ` and committed as ${done.id.slice(0, 7)}` : ""}.`);
      changed?.();
    } catch (error) {
      setSaid((error as Error).message);
    }
  }

  const about = shown ?? change;
  return (
    <details className={`call change${change.new ? " new" : ""}`} onToggle={(event) => opened(event.currentTarget.open)}>
      <summary>
        <b>{PLACE[change.in]}</b>
        <span className="gist">{change.subject}</span>
        <span className="kind">
          {about.by ? `${labelOf(about.by)}, ` : ""}
          {about.at ? ago(about.at) : change.id.slice(0, 7)}
        </span>
      </summary>
      <div className="open">
        {trouble && <p className="bad">{trouble}</p>}
        {!shown && !trouble && <p className="dim">Loading</p>}
        {shown && (
          <>
            <p className="dim num">
              {when(shown.at)} by {shown.by}, {shown.id.slice(0, 7)}
              {shown.run && (
                <>
                  , from <Link to={{ at: "log", agent, run: shown.run }}>the run that made it</Link>
                </>
              )}
            </p>
            <ul className="changed-files">
              {shown.files.map((file) => (
                <li key={file.path}>
                  <span className="status">{file.status}</span>
                  {file.status === "D" ? (
                    file.path
                  ) : (
                    <Link to={change.in === "memory" ? { at: "memory", agent, path: file.path } : { at: "file", agent, path: file.path }}>
                      {file.path}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <Diff text={shown.diff} />
            <div className="undo-line">
              <button className="small" onClick={() => void undo()}>
                Undo
              </button>
              {said && <span className="dim">{said}</span>}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

/** A unified diff, each line coloured by what it does. */
export function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="dim">No lines changed.</p>;
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className="diff">
      {lines.slice(0, LINES).map((line, at) => (
        <span key={at} className={kindOf(line)}>
          {line || " "}
        </span>
      ))}
      {lines.length > LINES && <span className="meta">...and {lines.length - LINES} more lines</span>}
    </pre>
  );
}

function kindOf(line: string): string | undefined {
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return undefined;
}
