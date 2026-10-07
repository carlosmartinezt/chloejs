import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Entry, Opened } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ago, kindOf } from "../lib/format.ts";
import { FileHistory } from "./components/Changes.tsx";
import { Code } from "./components/Code.tsx";
import { Live } from "./components/Live.tsx";
import type { View } from "../lib/route.ts";
import { Back, Link, Trail } from "./components/Link.tsx";

/** One address inside an agent's folder: a file to read or write, or a folder. */
export function Open({ agent, path }: { agent: string; path: string }) {
  const [found, setFound] = useState<Opened | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    setFound(null);
    setTrouble("");
    api.file(agent, path).then(setFound, (error: Error) => setTrouble(error.message));
  }, [agent, path]);

  if (trouble) {
    return (
      <>
        <Head agent={agent} path={path} />
        <p className="bad">{trouble}</p>
      </>
    );
  }
  if (!found) {
    return (
      <>
        <Head agent={agent} path={path} />
        <p className="dim">Loading</p>
      </>
    );
  }
  return found.dir ? (
    <Folder agent={agent} path={path} entries={found.entries} />
  ) : (
    <File agent={agent} path={path} found={found} />
  );
}

/** Where you are, and every step of the way back. */
function Head({ agent, path, children }: { agent: string; path: string; children?: ReactNode }) {
  const parts = path.split("/");
  // Back is the folder this is in, or the agent when it is already at the top.
  const up: View =
    parts.length > 1 ? { at: "file", agent, path: parts.slice(0, -1).join("/") } : { at: "agent", agent };
  return (
    <div className="head">
      <div>
        <Trail
          agent={agent}
          steps={parts.map((name, at) => ({
            name,
            to: at === parts.length - 1 ? undefined : { at: "file", agent, path: parts.slice(0, at + 1).join("/") },
          }))}
        />
        <h1>{parts[parts.length - 1]}</h1>
      </div>
      <div className="ends">
        {children}
        <Back to={up} />
      </div>
    </div>
  );
}

function Folder({ agent, path, entries }: { agent: string; path: string; entries: Entry[] }) {
  return (
    <>
      <Head agent={agent} path={path} />
      {entries.length === 0 ? (
        <p className="empty">This folder is empty.</p>
      ) : (
        <ul className="listing">
          {entries.map((entry) => (
            <li key={entry.path}>
              <Link
                to={{ at: "file", agent, path: entry.path }}
                className={entry.dir ? "folder" : kindOf(entry.name)}
              >
                {entry.name}
                {entry.dir ? "/" : ""}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function File({
  agent,
  path,
  found,
}: {
  agent: string;
  path: string;
  found: Extract<Opened, { dir: false }>;
}) {
  const [content, setContent] = useState(found.content);
  const [onDisk, setOnDisk] = useState(found.content);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [trouble, setTrouble] = useState("");
  const [history, setHistory] = useState(false);

  useEffect(() => {
    setContent(found.content);
    setOnDisk(found.content);
    setSaved(null);
    setTrouble("");
    setHistory(false);
  }, [found]);

  const dirty = content !== onDisk;

  async function keep() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.save(agent, path, content);
      setOnDisk(content);
      setSaved(new Date().toISOString());
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Head agent={agent} path={path}>
        <button className="small" onClick={() => setHistory(!history)} aria-pressed={history}>
          {history ? "Hide history" : "History"}
        </button>
        {found.editable && (
          <button className="go" onClick={keep} disabled={!dirty || saving}>
            {saving ? "Saving" : "Save"}
          </button>
        )}
      </Head>

      {trouble && <p className="bad">{trouble}</p>}
      {history && <FileHistory agent={agent} place="folder" path={path} />}
      <Together agent={agent} path={path} />
      {found.editable ? (
        <>
          <Live text={content} onChange={setContent} onSave={keep} />
          <div className="saveline">
            <span className="dim">
              {dirty
                ? "Not saved. It goes live the moment it is."
                : saved
                  ? `Saved ${ago(saved)}. It is live.`
                  : "Click a line to write in it. Saving makes it live in under a second."}
            </span>
            <span className="num dim">
              {count(content)} words, {content.length} characters
            </span>
          </div>
        </>
      ) : (
        <>
          <Code text={content} language={path} />
          <p className="dim">
            Code is read only here. Edit it where <code>npm run check</code> runs.
          </p>
        </>
      )}
    </>
  );
}

/**
 * A job can be two files, the code and its prompt, so each one offers the
 * other: morning-check.ts and morning-check.md, and the test beside them.
 */
function Together({ agent, path }: { agent: string; path: string }) {
  const [names, setNames] = useState<string[]>([]);
  const match = /^jobs\/([^/]+?)(\.test)?\.(md|ts)$/.exec(path);
  const stem = match?.[1];

  useEffect(() => {
    setNames([]);
    if (!stem) return;
    let stale = false;
    api.file(agent, "jobs").then((found) => {
      if (stale || !found.dir) return;
      setNames(found.entries.filter((entry) => !entry.dir && entry.name.startsWith(`${stem}.`)).map((entry) => entry.name));
    });
    return () => {
      stale = true;
    };
  }, [agent, stem]);

  if (names.length < 2) return null;
  return (
    <nav className="together">
      {names.map((name) => (
        <Link
          key={name}
          to={{ at: "file", agent, path: `jobs/${name}` }}
          className={kindOf(name)}
          current={`jobs/${name}` === path}
        >
          {name}
        </Link>
      ))}
    </nav>
  );
}

/** Words, counted the way a person would: anything between spaces. */
function count(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}
