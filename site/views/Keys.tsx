import { useState } from "react";

import { cloud, NeedsSignIn } from "../lib/api.ts";
import { copy } from "../lib/copy.ts";
import { ago, ZONE } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import type { Workspace } from "../lib/types.ts";
import { Setup } from "./Setup.tsx";

/** "2 Oct": the day, where the box is. */
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric", month: "short" });

/**
 * A workspace's keys, a page of its own: the one its runtime connects with and
 * the ones it replaced. The cloud keeps only a key's hash, so a new key is shown
 * here once, as it is made, and never again. `changed` is called after either
 * button, so the list is read again.
 */
export function Keys({ workspace, changed }: { workspace: Workspace; changed: () => unknown }) {
  const [made, setMade] = useState("");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState("");

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
    await changed();
  }

  return (
    <>
      <div className="head">
        <h1>Keys</h1>
        <span className="actions">
          <button
            className="go small"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`A new key revokes every other one, and ${workspace.label}'s runtime disconnects until it has the new one. Make one?`)) {
                void tried(async () => setMade((await cloud.newKey(workspace.name)).key));
              }
            }}
          >
            New key
          </button>
          <button
            className="plain small"
            disabled={busy || workspace.keys.every((one) => one.revoked)}
            onClick={() => {
              if (window.confirm(`Revoke every key for ${workspace.label}? Its runtime disconnects and cannot come back until it has a new one.`)) {
                void tried(() => cloud.revoke(workspace.name));
              }
            }}
          >
            Revoke every key
          </button>
        </span>
      </div>
      <p className="empty">
        {workspace.label}&rsquo;s runtime connects with its key. Only one works at a time, and a key is shown only once,
        when it is made.
      </p>

      {trouble && <p className="bad">{trouble}</p>}
      {made && <Key label={workspace.label} secret={made} done={() => setMade("")} />}

      {workspace.keys.length === 0 ? (
        <p className="empty frame">No keys yet. Make one, and put it in the runtime&rsquo;s .env.</p>
      ) : (
        <ul className="rows">
          {workspace.keys.map((one) => (
            <li key={one.id} className={one.revoked ? "gone" : undefined}>
              <span className={`dot ${one.revoked ? "bad" : "ok"}`} aria-hidden="true" />
              <span className="who">
                <b>{one.revoked ? "Revoked" : "In use"}</b>
                <span>
                  Made {day(one.created)}
                  {one.revoked ? `, revoked ${day(one.revoked)}` : ""}
                </span>
              </span>
              <span className="dim">{one.lastUsed ? `last connected ${ago(one.lastUsed)}` : "never connected"}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A key, the once, and the steps it belongs to. The cloud keeps only its hash,
 * so this is the only time it exists in one piece: what is on screen now either
 * gets into a runtime's .env or is replaced by another.
 */
export function Key({ label, secret, done }: { label: string; secret: string; done: () => void }) {
  // Null until the button is pressed, then whether the copy worked.
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <section className="ready">
      <header>
        <div>
          <h2>{label} is waiting for a runtime</h2>
          <p className="dim">Its key, shown this once. Make a new one under Keys if this is lost.</p>
        </div>
        <button className="go" onClick={() => void copy(secret).then(setCopied)}>
          {copied ? "Copied" : "Copy the key"}
        </button>
      </header>

      <p className="key">
        <code>{secret}</code>
      </p>

      {copied === false && (
        <p className="dim">This browser would not let the page copy. Select the key above and copy it yourself.</p>
      )}

      <Setup secret={secret} />

      <button className="small" onClick={done}>
        Done
      </button>
    </section>
  );
}
