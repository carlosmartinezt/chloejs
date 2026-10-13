import { type ReactNode, useEffect, useState } from "react";

import { api } from "../../lib/api.ts";
import type { Field } from "../../lib/types.ts";

/** One setting in a form: which, what to call it, and how to ask for it. */
export interface Ask {
  path: string;
  label: string;
  /**
   * Words by default. A secret is pasted, goes into .env and is never shown
   * again. A list is typed as words with commas between them.
   */
  kind?: "words" | "secret" | "switch" | "choice" | "list" | "number";
  /** For a choice: each value and what to call it. */
  choices?: [string, string][];
  placeholder?: string;
  /** A line under it, saying what it does. */
  about?: ReactNode;
}

/**
 * A few settings as one form, saved together: chloe.config.ts changes where
 * each one is, and a secret goes into .env with the config naming it. A
 * setting the file says as code is shown, not changed: the file is where to
 * change it. `saved` hands back every setting as the file now says it.
 */
export function Fields({ fields, asks, saved }: { fields: Field[]; asks: Ask[]; saved: (all: Field[]) => void }) {
  const byPath = new Map(fields.map((one) => [one.path, one]));
  const start = () => Object.fromEntries(asks.map((ask) => [ask.path, shown(ask, byPath.get(ask.path))]));
  const [draft, setDraft] = useState<Record<string, string | boolean>>(start);
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Each time the file changes, the form starts again from what it says.
  useEffect(() => setDraft(start()), [fields]);

  const changed = asks.filter((ask) => byPath.get(ask.path)?.written !== "code" && draft[ask.path] !== shown(ask, byPath.get(ask.path)));

  async function send(changes: { path: string; value: unknown }[]) {
    setTrouble("");
    setDone(false);
    setBusy(true);
    try {
      saved(await api.changeSettings(changes));
      setDone(true);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    // Words left empty put the default back, rather than writing "" into the file.
    void send(changed.map((ask) => ({ path: ask.path, value: draft[ask.path] === "" ? null : sent(ask, draft[ask.path]) })));
  }

  return (
    <form className="fields" onSubmit={save}>
      {asks.map((ask) => {
        const field = byPath.get(ask.path);
        if (!field) return null;
        const set = (value: string | boolean) => setDraft({ ...draft, [ask.path]: value });
        if (field.written === "code") {
          return (
            <div key={ask.path} className="field">
              <span className="label">{ask.label}</span>
              <span className="dim">
                Written as code in chloe.config.ts, so it is changed in <a href="#file">the file</a>.
              </span>
            </div>
          );
        }
        if (ask.kind === "switch") {
          return (
            <label key={ask.path} className="switch">
              <input type="checkbox" checked={draft[ask.path] === true} onChange={(event) => set(event.target.checked)} />
              {ask.label}
              {ask.about && <span className="about">{ask.about}</span>}
            </label>
          );
        }
        return (
          <label key={ask.path}>
            {ask.label}
            {ask.kind === "choice" ? (
              <select value={String(draft[ask.path])} onChange={(event) => set(event.target.value)}>
                {ask.choices?.map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            ) : (
              <span className="with">
                <input
                  type={ask.kind === "secret" ? "password" : "text"}
                  inputMode={ask.kind === "number" ? "decimal" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={String(draft[ask.path] ?? "")}
                  onChange={(event) => set(event.target.value)}
                  placeholder={ask.kind === "secret" && field.set ? "Set. Paste a new one to replace it" : ask.placeholder}
                />
                {ask.kind === "secret" && field.set && (
                  <button
                    type="button"
                    className="small plain"
                    disabled={busy}
                    onClick={() => window.confirm(`Take ${ask.label} out of chloe.config.ts and .env?`) && void send([{ path: ask.path, value: null }])}
                  >
                    Remove
                  </button>
                )}
              </span>
            )}
            {ask.kind === "secret" && field.set && field.key && (
              <span className="about">
                In <code>.env</code> as <code>{field.key}</code>.
              </span>
            )}
            {ask.about && <span className="about">{ask.about}</span>}
          </label>
        );
      })}
      <div>
        <button className="small" type="submit" disabled={busy || !changed.length}>
          {busy ? "Checking" : "Save"}
        </button>
      </div>
      {done && <p className="empty">Saved to chloe.config.ts{asks.some((ask) => ask.kind === "secret") ? " and .env" : ""}, and loaded.</p>}
      {trouble && <pre className="bad">{trouble}</pre>}
    </form>
  );
}

/** What the form starts with: what the file says, and an empty box for a secret, whose value is never sent here. */
function shown(ask: Ask, field: Field | undefined): string | boolean {
  if (ask.kind === "secret") return "";
  if (ask.kind === "switch") return field?.value === true;
  if (ask.kind === "list") return Array.isArray(field?.value) ? field.value.join(", ") : "";
  return typeof field?.value === "string" ? field.value : field?.value === undefined ? "" : String(field.value);
}

/** What a box's text is saved as: a list split at its commas, a number as a number, anything else as it is. */
function sent(ask: Ask, value: string | boolean): unknown {
  if (typeof value !== "string") return value;
  if (ask.kind === "list") return value.split(",").map((one) => one.trim()).filter(Boolean);
  // A number that is not one is sent as typed, and the server says what it takes.
  if (ask.kind === "number") return Number.isFinite(Number(value)) ? Number(value) : value;
  return value;
}
