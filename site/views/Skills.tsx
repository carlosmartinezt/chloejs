import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { ago, labelOf } from "../lib/format.ts";
import type { Skill } from "../lib/types.ts";
import * as Icons from "./components/Icons.tsx";
import { Live } from "./components/Live.tsx";
import { Markdown } from "./components/Markdown.tsx";

/**
 * Every skill in an agent's skills folder: what each one is called, what it is
 * for, and the words themselves, which can be written back from here the same
 * way any markdown file of the agent's can.
 */
export function Skills({ agent }: { agent: string }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [again, setAgain] = useState(0);
  // Skills are open, and folding one is for getting it out of the way. The
  // filter is the faster way to a long list.
  const [shut, setShut] = useState<string[]>([]);
  const [hunt, setHunt] = useState("");
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    let stale = false;
    setTrouble("");
    api.agentSkills(agent).then(
      (all) => !stale && setSkills(all),
      (error: Error) => !stale && setTrouble(missing(error, "skills")),
    );
    return () => void (stale = true);
  }, [agent, again]);

  useEffect(() => {
    setSkills(null);
    setShut([]);
    setHunt("");
  }, [agent]);

  const word = hunt.trim().toLowerCase();
  const shown = skills?.filter(
    (skill) => !word || `${skill.name} ${skill.description} ${skill.body}`.toLowerCase().includes(word),
  );

  return (
    <>
      <div className="head">
        <h1>Skills</h1>
      </div>
      {skills && skills.length > 1 && (
        <div className="filters">
          <input
            className="word"
            type="search"
            value={hunt}
            placeholder="Find a skill"
            onChange={(event) => setHunt(event.target.value)}
          />
          <span className="num dim">
            {word ? `${shown?.length ?? 0} of ${skills.length}` : `${skills.length} skills`}
          </span>
        </div>
      )}
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {skills === null && !trouble && <p className="dim">Loading</p>}
      {skills?.length === 0 && (
        <p className="empty frame">
          {labelOf(agent)} has none. Put a markdown file in its skills folder and it has one.
        </p>
      )}
      {skills?.length && shown?.length === 0 ? <p className="empty frame">No skill says that.</p> : null}
      {shown?.map((skill) => (
        <One
          key={skill.path}
          agent={agent}
          skill={skill}
          open={!shut.includes(skill.path)}
          fold={() =>
            setShut(shut.includes(skill.path) ? shut.filter((one) => one !== skill.path) : [...shut, skill.path])
          }
          saved={() => setAgain(again + 1)}
        />
      ))}
    </>
  );
}

/**
 * One skill: its frontmatter as the file writes it, then what it says. Editing
 * opens the whole file, frontmatter and all, because that is the file.
 */
function One({
  agent,
  skill,
  open,
  fold,
  saved,
}: {
  agent: string;
  skill: Skill;
  open: boolean;
  fold: () => void;
  saved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [onDisk, setOnDisk] = useState("");
  const [saving, setSaving] = useState(false);
  const [kept, setKept] = useState<string | null>(null);
  const [trouble, setTrouble] = useState("");

  const dirty = text !== null && text !== onDisk;

  async function edit() {
    setEditing(true);
    setTrouble("");
    if (text !== null) return;
    try {
      const found = await api.file(agent, skill.path);
      if (found.dir) throw new Error(`${skill.path} is a folder.`);
      setText(found.content);
      setOnDisk(found.content);
    } catch (error) {
      setTrouble((error as Error).message);
      setEditing(false);
    }
  }

  async function keep() {
    if (text === null || !dirty || saving) return;
    setSaving(true);
    try {
      await api.save(agent, skill.path, text);
      setOnDisk(text);
      setKept(new Date().toISOString());
      setTrouble("");
      saved();
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="skill">
      <div className="top">
        <button className="plain fold" aria-expanded={open} onClick={fold}>
          <Icons.Down />
          {/* The two lines a skill file starts with, said the way the file says
              them, so it is plain that this is the top of that file. */}
          <span className="front">
            <span>
              <i>name:</i> <b>{skill.name}</b>
            </span>
            {skill.description && (
              <span>
                <i>description:</i> {skill.description}
              </span>
            )}
          </span>
        </button>
        {open &&
          (editing ? (
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
          ))}
      </div>
      {open && (
        <div className="said">
          {trouble && <p className="bad">{trouble}</p>}
          {editing && text !== null ? (
            <>
              <Live text={text} onChange={setText} onSave={keep} />
              <p className="dim saveline">
                <span>
                  {dirty
                    ? "Not saved. It goes live the moment it is."
                    : kept
                      ? `Saved ${ago(kept)}. It is live.`
                      : `Writing ${skill.path}. Saving makes it live in under a second.`}
                </span>
              </p>
            </>
          ) : (
            <div className="prose">
              <Markdown text={skill.body} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
