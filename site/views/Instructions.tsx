import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { ago, labelOf } from "../lib/format.ts";
import { Live } from "./components/Live.tsx";
import { Markdown } from "./components/Markdown.tsx";

/**
 * What an agent is told to do, as the model is given it. A definition that
 * points at a markdown file is that file by the time it gets here, so this
 * draws it as markdown either way: plain words come out as plain words.
 *
 * Words in a file can be written back from here, the whole file and its
 * frontmatter with it, because that is the file. Words written into the
 * definition have no file to write: that one is code, and is edited as code.
 */
export function Instructions({ agent }: { agent: string }) {
  const [said, setSaid] = useState<{ text: string; path?: string } | null>(null);
  const [again, setAgain] = useState(0);
  const [trouble, setTrouble] = useState("");
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [onDisk, setOnDisk] = useState("");
  const [saving, setSaving] = useState(false);
  const [kept, setKept] = useState<string | null>(null);

  const dirty = file !== null && file !== onDisk;

  useEffect(() => {
    let stale = false;
    setTrouble("");
    api.instructions(agent).then(
      (found) => !stale && setSaid(found),
      (error: Error) => !stale && setTrouble(missing(error, "instructions")),
    );
    return () => void (stale = true);
  }, [agent, again]);

  useEffect(() => {
    setSaid(null);
    setEditing(false);
    setFile(null);
    setKept(null);
  }, [agent]);

  async function edit() {
    if (!said?.path) return;
    setEditing(true);
    setTrouble("");
    if (file !== null) return;
    try {
      const found = await api.file(agent, said.path);
      if (found.dir) throw new Error(`${said.path} is a folder.`);
      setFile(found.content);
      setOnDisk(found.content);
    } catch (error) {
      setTrouble((error as Error).message);
      setEditing(false);
    }
  }

  async function keep() {
    if (!said?.path || file === null || !dirty || saving) return;
    setSaving(true);
    try {
      await api.save(agent, said.path, file);
      setOnDisk(file);
      setKept(new Date().toISOString());
      setTrouble("");
      // Read back, because what the model is given is the file without its
      // frontmatter and this has just written the file.
      setAgain(again + 1);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="head">
        <h1>Instructions</h1>
        {said?.path && (
          <div className="ends">
            {editing ? (
              <>
                <button className="small" onClick={() => setEditing(false)} disabled={dirty}>
                  Done
                </button>
                <button className="go small" onClick={keep} disabled={!dirty || saving}>
                  {saving ? "Saving" : "Save"}
                </button>
              </>
            ) : (
              <button className="small" onClick={edit}>
                Edit
              </button>
            )}
          </div>
        )}
      </div>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {said === null && !trouble && <p className="dim">Loading</p>}
      {editing && file !== null ? (
        <>
          <Live text={file} onChange={setFile} onSave={keep} />
          <p className="dim saveline">
            <span>
              {dirty
                ? "Not saved. It goes live the moment it is."
                : kept
                  ? `Saved ${ago(kept)}. It is live.`
                  : `Writing ${said?.path}. Saving makes it live in under a second.`}
            </span>
          </p>
        </>
      ) : (
        said !== null &&
        (said.text.trim() ? (
          <section className="told">
            <div className="prose">
              <Markdown text={said.text} />
            </div>
          </section>
        ) : (
          <p className="empty frame">
            {labelOf(agent)} is told nothing. It runs on its description and its tools alone.
          </p>
        ))
      )}
    </>
  );
}
