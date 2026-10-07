import { useCallback, useEffect, useState } from "react";

import { cloud, NeedsSignIn } from "../lib/api.ts";
import { ago, many, money, when } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import type { Workspace } from "../lib/types.ts";
import { Dots, workspaceChoices } from "./components/Manage.tsx";
import { Key } from "./Keys.tsx";

/**
 * Every runtime this cloud hosts. A runtime is here because somebody made an
 * workspace and put its key in that runtime's settings; nothing here reaches
 * out to find one.
 *
 * Online means its connection is open right now, so everything about it is live.
 * Offline means what is shown of it is what it sent while it was connected.
 */
export function Workspaces() {
  const [all, setAll] = useState<Workspace[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  /** A key, only ever just after it was made. The cloud does not have it to give again. */
  const [key, setKey] = useState<{ label: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAll(await cloud.workspaces());
      setTrouble("");
    } catch (error) {
      // No session is an address to go to, not an error to read.
      if (error instanceof NeedsSignIn) return go({ at: "signin", making: false });
      setTrouble((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Often enough that a runtime coming up shows, rarely enough to be quiet.
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function tried(what: () => Promise<unknown>) {
    setBusy(true);
    try {
      await what();
      setTrouble("");
    } catch (error) {
      if (error instanceof NeedsSignIn) return go({ at: "signin", making: false });
      setTrouble((error as Error).message);
    }
    setBusy(false);
    await refresh();
  }

  async function make() {
    const called = label.trim();
    if (!called) return;
    await tried(async () => {
      const made = await cloud.make(called);
      setKey({ label: made.workspace.label, key: made.key });
      setNaming(false);
      setLabel("");
    });
  }

  return (
    <>
      <div className="head spread">
        <h1>Workspaces</h1>
        <span className="actions">
          {!naming && (
            <button className="small" onClick={() => setNaming(true)} disabled={busy}>
              New workspace
            </button>
          )}
        </span>
      </div>

      {trouble && <p className="bad">{trouble}</p>}

      {naming && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void make();
          }}
        >
          <input
            value={label}
            autoFocus
            placeholder="What to call it, like Acme Dental"
            aria-label="What to call the workspace"
            onChange={(event) => setLabel(event.target.value)}
          />
          <button className="go small" type="submit" disabled={!label.trim() || busy}>
            Save
          </button>
          <button
            className="plain small"
            type="button"
            onClick={() => {
              setNaming(false);
              setLabel("");
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {key && <Key label={key.label} secret={key.key} done={() => setKey(null)} />}

      {!all ? (
        <p className="dim">Loading</p>
      ) : all.length === 0 ? (
        <p className="empty frame">No workspaces yet. Make one, and put its key in a runtime&rsquo;s settings.</p>
      ) : (
        <table className="roomy workspaces">
          <colgroup>
            <col />
            <col className="state" />
            <col className="today" />
            <col className="doing" />
            <col className="menu" />
          </colgroup>
          <tbody>
            {all.map((one) => (
              <tr key={one.name}>
                <td>
                  {!one.online && (
                    <span
                      className="dot bad"
                      aria-hidden="true"
                      title={
                        one.lastSeen
                          ? `Offline since ${when(one.lastSeen)}. Showing what was synced.`
                          : "Never connected."
                      }
                    />
                  )}
                  <a
                    href={`/workspaces/${encodeURIComponent(one.name)}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      go({ at: "workspaces" });
                      window.location.assign(`/workspaces/${encodeURIComponent(one.name)}`);
                    }}
                  >
                    {one.label}
                  </a>
                  <br />
                  <span className="dim num what">{one.guest ? "shared with you" : one.name}</span>
                </td>
                <td>
                  <span className={`dot ${one.online ? "ok" : "bad"}`} />
                  {one.online ? "Online" : "Offline"}
                  <br />
                  <span className="dim num what">
                    {one.online ? one.coreVersion ?? "" : one.lastSeen ? `last seen ${ago(one.lastSeen)}` : "never connected"}
                  </span>
                  <span
                    className="dim num what"
                    title={one.machine ?? "This runtime has not said which machine it is on."}
                  >
                    from {one.machine ?? "somewhere"}
                  </span>
                </td>
                <td className="num dim">
                  {many(one.today.runs, "run")} today
                  {one.today.failed > 0 && <span className="bad">, {one.today.failed} failed</span>}
                  <br />
                  {one.today.cost ? money(one.today.cost) : "free"}
                </td>
                <td className="dim doing">
                  <span className="what" title={one.agents.join(", ")}>
                    {one.agents.length ? one.agents.join(", ") : "no agents yet"}
                  </span>
                </td>
                <td className="right">
                  {/* A guest has nothing of the workspace's to manage. */}
                  {!one.guest && (
                    <Dots label={one.label} choices={() => workspaceChoices(one, { tried, gone: () => void refresh() })} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
