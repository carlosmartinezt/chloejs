import { useEffect, useState } from "react";

import { api } from "../../lib/api.ts";
import type { WhereToRun } from "../../lib/types.ts";

/** An id out of a name: lower case, dashes between words, a letter first. */
const idOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 40);

/**
 * The card for making an agent: its name, its id, and where it runs. The
 * runtime writes its files and lists it, with no model asked, and answers once
 * it is there, so `made` gets an agent that can be talked to.
 */
export function NewAgent({ done, made }: { done: () => void; made: (id: string) => unknown }) {
  const [places, setPlaces] = useState<WhereToRun[]>([]);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTyped, setIdTyped] = useState(false);
  const [model, setModel] = useState("");
  const [where, setWhere] = useState("here");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    api.places().then(setPlaces, (error: Error) => setTrouble(error.message));
  }, []);

  const shownId = idTyped ? id : idOf(name);

  async function make(event: React.FormEvent) {
    event.preventDefault();
    if (!shownId || busy) return;
    setBusy(true);
    setTrouble("");
    try {
      await api.makeAgent({ id: shownId, name: name.trim(), where, ...(model.trim() && { model: model.trim() }) });
      await made(shownId);
    } catch (error) {
      setTrouble((error as Error).message);
      setBusy(false);
    }
  }

  const picked = places.find((one) => one.name === where);
  return (
    <section className="ready">
      <h2>New agent</h2>
      <p className="dim">It starts with a purpose and nothing else. Talk to it and it changes itself into what you ask for.</p>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={make}>
        <div className="fields">
          <label>
            Name
            <input value={name} autoFocus placeholder="Inbox" onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Id, which never changes
            <input
              value={shownId}
              placeholder="inbox"
              onChange={(event) => {
                setIdTyped(true);
                setId(event.target.value);
              }}
            />
          </label>
          <label>
            Model, if not the default
            <input value={model} placeholder="provider/model" onChange={(event) => setModel(event.target.value)} />
          </label>
        </div>
        <fieldset className="switches">
          <legend>Where it runs</legend>
          {places.map((one) => (
            <label key={one.name} title={one.missing || undefined}>
              <input type="radio" name="where" checked={where === one.name} disabled={!!one.missing} onChange={() => setWhere(one.name)} />
              <span>
                <b>{one.label}</b>
                <span>{one.missing || one.about}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="buttons">
          <button className="go small" type="submit" disabled={busy || !shownId || !!picked?.missing}>
            {busy ? (where === "here" ? "Making it" : "Making its machine") : "Make it"}
          </button>
          <button className="plain small" type="button" onClick={done} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
