import { useCallback, useEffect, useRef, useState } from "react";

import { FileHistory } from "./components/Changes.tsx";
import { ContextMenu, type Choice } from "./components/ContextMenu.tsx";
import * as Icons from "./components/Icons.tsx";
import { Code } from "./components/Code.tsx";
import { Collapse } from "./components/Collapse.tsx";
import { CopyPath } from "./components/CopyPath.tsx";
import { Listing } from "./components/Listing.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Minimap } from "./components/Minimap.tsx";
import { Offline } from "./components/Offline.tsx";
import { api, frameAt, type MemoryRead } from "../lib/api.ts";
import { copy } from "../lib/copy.ts";
import { labelOf, when } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import * as prefs from "../lib/prefs.ts";
import { loadOpen, loadTabs, saveLast, saveOpen, saveTabs, tabName } from "../lib/tabs.ts";
import type { AgentSummary, Entry, Git, Workspace } from "../lib/types.ts";

/**
 * Where one agent remembers things, laid out the way an editor lays out a
 * folder: the tree down the left, the files you have open as tabs, the one you
 * are reading in the middle, and what changed beside the tree when the folder
 * is a git repository. That is what people already know for "browse a folder
 * and read what is in it", so it needs no explaining.
 *
 * Every agent has a memory, and the picker at the top switches between them.
 * Each keeps its own tabs and its own open folders. A folder's address shows
 * it as a table, and the top of the memory is the top folder's table.
 *
 * A file is shown in a frame, from /memory/<pass>/<path>. It is somebody's own
 * HTML, and it runs its own script, so that frame is sandboxed by the headers it
 * is served with: its script cannot reach this page, and cannot call the API as
 * you. See framed() in chloejs serve/http.ts. Nothing here may undo that, which
 * is why the frame is never given allow-same-origin.
 */
export function Memory({
  agents,
  agent,
  path,
  offline = false,
  where,
}: {
  agents: AgentSummary[];
  agent: string;
  path?: string;
  /** Reached through a cloud whose connection to the runtime is not open. */
  offline?: boolean;
  /** What the cloud knows about the workspace, which is what the panel says. */
  where?: Workspace | null;
}) {
  const [tree, setTree] = useState<Entry[] | null>(null);
  const [tabs, setTabs] = useState<string[]>(() => loadTabs(agent));
  const [open, setOpen] = useState<Set<string>>(() => loadOpen(agent));
  const [side, setSide] = useState<"files" | "changes" | "record" | "look">("files");
  const [look, setLook] = useState(() => ({ docStyle: prefs.docStyle(), minimap: prefs.minimap(), sort: prefs.sort() }));
  const [git, setGit] = useState<Git | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; choices: Choice[] } | null>(null);
  const [trouble, setTrouble] = useState("");
  const [pass, setPass] = useState<{ agent: string; at: string; until: number } | null>(null);

  const me = agents.find((one) => one.id === agent);
  const label = me?.memory ?? "Memory";
  const whose = labelOf(agent);

  // Switching agent is switching everything: its tree, its tabs, its folders.
  useEffect(() => {
    setTabs(loadTabs(agent));
    setOpen(loadOpen(agent));
    setTree(null);
    setGit(null);
    setPass(null);
  }, [agent]);

  const refresh = useCallback(async () => {
    try {
      const [entries, status] = await Promise.all([api.memory(agent), api.git(agent)]);
      setTree(entries);
      setGit(status);
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }, [agent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entry = path && tree ? find(tree, path) : undefined;
  const folder = !path || entry?.dir === true;

  // The address names the file. Opening one puts it in the strip if it is not
  // there already, and opens the folders above it so you can see where it is.
  // A folder opens itself too, and is not a tab.
  useEffect(() => {
    if (!path || !tree) return;
    const dir = find(tree, path)?.dir === true;
    setOpen((before) => {
      const after = new Set(before);
      const parts = path.split("/");
      for (let at = 1; at < parts.length; at++) after.add(parts.slice(0, at).join("/"));
      if (dir) after.add(path);
      saveOpen(agent, after);
      return after;
    });
    if (dir) return;
    saveLast(agent, path);
    setTabs((before) => {
      if (before.includes(path)) return before;
      const after = [...before, path];
      saveTabs(agent, after);
      return after;
    });
  }, [agent, path, tree]);

  /**
   * A pass lasts ten minutes. One is asked for when there is a file to show,
   * and again when it is close to running out, so a tab left open still loads
   * when you come back to it.
   */
  useEffect(() => {
    if (!path || folder) return;
    if (pass && pass.agent === agent && pass.until - Date.now() > 60_000) return;
    let stale = false;
    api.memoryPass(agent).then(
      (got) => !stale && setPass({ agent, at: got.at, until: Date.now() + 9 * 60_000 }),
      (error) => !stale && setTrouble((error as Error).message),
    );
    return () => void (stale = true);
  }, [agent, path, pass, folder]);

  const show = (to?: string) => go({ at: "memory", agent, path: to });

  function toggle(folder: string) {
    setOpen((before) => {
      const after = new Set(before);
      if (after.has(folder)) after.delete(folder);
      else after.add(folder);
      saveOpen(agent, after);
      return after;
    });
  }

  function closeTabs(keep: (one: string) => boolean) {
    const after = tabs.filter(keep);
    setTabs(after);
    saveTabs(agent, after);
    if (!after.length) saveLast(agent);
    // Closing the one you are reading moves you to its neighbour, as a strip
    // of tabs does, rather than leaving you looking at a file that has gone.
    if (path && !after.includes(path)) {
      const was = tabs.indexOf(path);
      show(after[Math.min(was, after.length - 1)]);
    }
  }

  async function renameFrom(from: string) {
    const to = window.prompt(`Move ${from} to`, from);
    if (!to || to === from) return;
    try {
      await api.renameMemory(agent, from, to);
      // A tab follows the file it had open rather than being left pointing at
      // somewhere that is empty now.
      const after = tabs.map((one) => (one === from || one.startsWith(`${from}/`) ? to + one.slice(from.length) : one));
      setTabs(after);
      saveTabs(agent, after);
      if (path && (path === from || path.startsWith(`${from}/`))) show(to + path.slice(from.length));
      await refresh();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  async function remove(target: string, dir: boolean) {
    const repo = git?.repo
      ? " It is still in git."
      : agent
        ? " This memory is not a git repository, so that is permanent."
        : " That is permanent.";
    if (!window.confirm(`Delete ${target}${dir ? " and everything in it" : ""}?${repo}`)) return;
    try {
      await api.deleteMemory(agent, target);
      closeTabs((one) => one !== target && !one.startsWith(`${target}/`));
      await refresh();
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  function onEntry(event: React.MouseEvent, entry: Entry) {
    event.preventDefault();
    const copyPath = () => void copy(entry.path);
    const choices: Choice[] = entry.dir
      ? [
          { label: open.has(entry.path) ? "Collapse" : "Expand", run: () => toggle(entry.path) },
          { label: "Open as a table", run: () => show(entry.path) },
          "line",
          { label: "Rename or move", run: () => void renameFrom(entry.path) },
          { label: "Copy path", run: copyPath },
          "line",
          { label: "Delete folder", run: () => void remove(entry.path, true), danger: true },
        ]
      : [
          { label: "Open", run: () => show(entry.path) },
          { label: "Close other tabs", run: () => closeTabs((one) => one === entry.path), disabled: !tabs.includes(entry.path) },
          "line",
          { label: "Rename or move", run: () => void renameFrom(entry.path) },
          { label: "Copy path", run: copyPath },
          "line",
          { label: "Delete", run: () => void remove(entry.path, false), danger: true },
        ];
    setMenu({ x: event.clientX, y: event.clientY, choices });
  }

  function onTab(event: React.MouseEvent, tab: string) {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      choices: [
        { label: "Close", run: () => closeTabs((one) => one !== tab) },
        { label: "Close others", run: () => closeTabs((one) => one === tab) },
        { label: "Close to the right", run: () => closeTabs((one) => tabs.indexOf(one) <= tabs.indexOf(tab)) },
        { label: "Close all", run: () => closeTabs(() => false) },
        "line",
        { label: "Copy path", run: () => void copy(tab) },
      ],
    });
  }

  const changed = git?.repo ? new Map(git.changes.map((one) => [one.path, one.status])) : new Map<string, string>();

  return (
    <div className="workbench">
      <aside className="sidebar rail">
        <Collapse closeOn={path}>
        <div className="side-head">
          <nav className="side-tabs">
            <button className={side === "files" ? "on" : undefined} onClick={() => setSide("files")} title="Files">
              <Icons.Files />
            </button>
            <button
              className={side === "changes" ? "on" : undefined}
              onClick={() => setSide("changes")}
              title="Source control"
            >
              <Icons.Branch />
              {git?.repo && git.changes.length > 0 && <span className="badge">{git.changes.length}</span>}
            </button>
            <button className={side === "record" ? "on" : undefined} onClick={() => setSide("record")} title="What has been read">
              <Icons.Record />
            </button>
            <button className={side === "look" ? "on" : undefined} onClick={() => setSide("look")} title="How it looks">
              <Icons.Look />
            </button>
          </nav>
        </div>

        {side === "files" && (
          <div className="side-body">
            <p className="side-title">{label}</p>
            {!tree && <p className="dim pad">Loading</p>}
            {tree && tree.length === 0 && (
              <p className="empty pad">Nothing yet. {whose} has not written anything down.</p>
            )}
            {tree && (
              <Tree
                entries={tree}
                open={open}
                current={path}
                changed={changed}
                toggle={toggle}
                pick={(to) => show(to)}
                menu={onEntry}
              />
            )}
          </div>
        )}

        {side === "changes" && <Changes agent={agent} git={git} refresh={refresh} pick={(to) => show(to)} />}

        {side === "record" && <Record agent={agent} />}

        {side === "look" && (
          <Look
            docStyle={look.docStyle}
            minimap={look.minimap}
            change={(next) => {
              if (next.docStyle !== undefined) prefs.setDocStyle(next.docStyle);
              if (next.minimap !== undefined) prefs.setMinimap(next.minimap);
              setLook((before) => ({ ...before, ...next }));
            }}
          />
        )}
        </Collapse>
      </aside>

      <section className="editor">
        {tabs.length > 0 && (
          <div className="tabstrip" role="tablist">
            {tabs.map((tab) => (
              <div
                key={tab}
                role="tab"
                aria-selected={tab === path}
                className={`tab${tab === path ? " on" : ""}${changed.has(tab) ? " dirty" : ""}`}
                title={tab}
                onClick={() => show(tab)}
                onContextMenu={(event) => onTab(event, tab)}
                // The middle button closes a tab, as it does everywhere else.
                onAuxClick={(event) => event.button === 1 && closeTabs((one) => one !== tab)}
              >
                <span className="tab-name">{tabName(tab)}</span>
                <button
                  className="tab-close"
                  aria-label={`Close ${tabName(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTabs((one) => one !== tab);
                  }}
                >
                  <Icons.Close />
                </button>
              </div>
            ))}
          </div>
        )}

        {offline && <Offline name={agent} where={where ?? null} />}

        {trouble && !offline && <p className="bad pad">{trouble}</p>}

        {path && <Crumbs label={label} path={path} pick={(to) => show(to)} />}
        {path && !tree ? (
          <p className="dim pad">Loading</p>
        ) : path && !folder ? (
          <Shown
            key={`${agent}/${path}`}
            agent={agent}
            path={path}
            at={pass?.agent === agent ? pass.at : null}
            docStyle={look.docStyle}
            minimap={look.minimap}
            open={(to) => show(to)}
          />
        ) : (
          <div className="folder-page">
            {tree && (
              <Listing
                entries={entry?.children ?? (path ? [] : tree)}
                sort={look.sort}
                resort={(next) => {
                  prefs.setSort(next);
                  setLook((before) => ({ ...before, sort: next }));
                }}
                pick={(one) => show(one.path)}
                menu={onEntry}
              />
            )}
            {!path && (
              <p className="dim pad">
                Everything opened here is written to {labelOf(agent)}&rsquo;s audit log before it is shown. Reading
                the same file from a shell on the box is not.
              </p>
            )}
          </div>
        )}
      </section>

      <footer className="statusbar">
        {/* Installed on a phone, the page has no browser around it to reload it. */}
        <button className="status-reload" aria-label="Reload the page" title="Reload the page" onClick={() => window.location.reload()}>
          <Icons.Reload />
        </button>
        <span className="status-whose">
          {whose}&rsquo;s {label.toLowerCase()}
        </span>
        {git?.repo && (
          <>
            <span className="status-part">
              <Icons.Branch /> {git.branch}
            </span>
            {git.changes.length > 0 && <span className="status-part">{git.changes.length} changed</span>}
            {git.ahead > 0 && <span className="status-part">{git.ahead} to push</span>}
            {git.behind > 0 && <span className="status-part">{git.behind} to pull</span>}
          </>
        )}
        {path && <CopyPath path={path} className="status-part end" />}
      </footer>

      {menu && <ContextMenu at={menu} choices={menu.choices} close={() => setMenu(null)} />}
    </div>
  );
}

function Tree({
  entries,
  open,
  current,
  changed,
  toggle,
  pick,
  menu,
  depth = 0,
}: {
  entries: Entry[];
  open: Set<string>;
  current?: string;
  changed: Map<string, string>;
  toggle: (folder: string) => void;
  pick: (path: string) => void;
  menu: (event: React.MouseEvent, entry: Entry) => void;
  depth?: number;
}) {
  return (
    <ul className="memory-tree" role={depth === 0 ? "tree" : "group"}>
      {entries.map((entry) => {
        const shut = entry.dir && !open.has(entry.path);
        // A folder with a changed file somewhere inside it says so, so a change
        // is findable without opening every folder to look.
        const mark = entry.dir
          ? [...changed.keys()].some((one) => one.startsWith(`${entry.path}/`))
            ? "•"
            : ""
          : (changed.get(entry.path) ?? "");
        return (
          <li key={entry.path} role="treeitem" aria-expanded={entry.dir ? !shut : undefined}>
            <button
              className={`row${entry.path === current ? " on" : ""}${mark ? " changed" : ""}`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => (entry.dir ? toggle(entry.path) : pick(entry.path))}
              onContextMenu={(event) => menu(event, entry)}
              title={entry.path}
            >
              <span className="row-icon">
                {entry.dir ? shut ? <Icons.Folder /> : <Icons.FolderOpen /> : <Icons.File />}
              </span>
              <span className="row-name">{entry.name}</span>
              {mark && <span className="row-mark">{mark}</span>}
            </button>
            {entry.dir && !shut && entry.children && entry.children.length > 0 && (
              <Tree
                entries={entry.children}
                open={open}
                current={current}
                changed={changed}
                toggle={toggle}
                pick={pick}
                menu={menu}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Where the file is, each folder a place you can click back to, and the file itself a press that copies its path. */
function Crumbs({ label, path, pick }: { label: string; path: string; pick: (to?: string) => void }) {
  const parts = path.split("/");
  return (
    <nav className="crumbs" aria-label="Where this file is">
      <button onClick={() => pick()}>{label}</button>
      {parts.map((part, at) => (
        <span key={at}>
          <span className="sep">/</span>
          {at === parts.length - 1 ? (
            <CopyPath path={path} className="here">
              {part}
            </CopyPath>
          ) : (
            <button onClick={() => pick(parts.slice(0, at + 1).join("/"))}>{part}</button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * The file itself. Markdown and plain text are drawn here, because this page
 * already knows how. Everything else goes in the frame, under the pass, where it runs its own
 * script sandboxed. "Source" shows any text file as its words, to read or to
 * change and save.
 */
function Shown({
  agent,
  path,
  at,
  docStyle,
  minimap,
  open,
}: {
  agent: string;
  path: string;
  at: string | null;
  docStyle: boolean;
  minimap: boolean;
  open: (path: string) => void;
}) {
  const [source, setSource] = useState(false);
  const [history, setHistory] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState("");
  const markdown = path.endsWith(".md");
  // Plain text is painted here too, rather than handed to the frame: a browser
  // shows a bare JSON or text file on its own white page, which flashes before
  // its own dark styling arrives, and it cannot colour the file anyway.
  const painted = /\.(txt|css|js|mjs|json|jsonl|ya?ml|toml|csv|ts|sh|log)$/i.test(path);
  const textual = markdown || painted || /\.html?$/i.test(path);
  const frame = useRef<HTMLIFrameElement>(null);
  const pane = useRef<HTMLDivElement>(null);

  // A link in a note to another file in this memory arrives as a message from
  // notes.js in the frame, and opens here as a tab. Only this frame's messages
  // count, and all one can do is open a path in the same memory.
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const said = event.data as { type?: unknown; path?: unknown } | null;
      if (said?.type === "chloe:open" && typeof said.path === "string" && said.path) open(said.path);
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [open]);

  useEffect(() => {
    if (!markdown && !painted && !source) return;
    let stale = false;
    api.memoryFile(agent, path).then(
      (got) => {
        if (stale) return;
        setText(got.content ?? "");
        setDraft(got.content ?? "");
      },
      (error) => !stale && setText(`Could not read ${path}: ${(error as Error).message}`),
    );
    return () => void (stale = true);
  }, [agent, path, markdown, painted, source]);

  async function save() {
    setSaving("Saving");
    try {
      await api.saveMemory(agent, path, draft);
      setText(draft);
      setSaving("Saved");
      // A frame showing the old version is reloaded, so what is shown is what
      // is on disk rather than what was on disk when it was opened.
      frame.current?.contentWindow?.location.reload();
    } catch (error) {
      setSaving((error as Error).message);
    }
  }

  // frameAt hangs the address the runtime handed out off wherever that runtime
  // is: the root when the page is in front of one, and that workspace's when
  // it is in front of a cloud. Never anywhere else: this is the only address a
  // memory file may be loaded from, and it is what carries the sandbox.
  const src = at ? `${frameAt(at)}/${path.split("/").map(encodeURIComponent).join("/")}${docStyle ? "?style=basic" : ""}` : null;

  // A folder with no agent behind it has no history to ask for.
  const kept = Boolean(agent);

  return (
    <div className="shown">
      {(textual || kept) && (
        <div className="shown-bar">
          <button
            className={!source && !history ? "on" : undefined}
            onClick={() => {
              setSource(false);
              setHistory(false);
            }}
          >
            Page
          </button>
          {textual && (
            <button
              className={source ? "on" : undefined}
              onClick={() => {
                setSource(true);
                setHistory(false);
              }}
            >
              Source
            </button>
          )}
          {kept && (
            <button
              className={history ? "on" : undefined}
              onClick={() => {
                setHistory(true);
                setSource(false);
              }}
            >
              History
            </button>
          )}
          {source && (
            <>
              <button className="small" disabled={draft === text} onClick={() => void save()}>
                Save
              </button>
              {saving && <span className="dim">{saving}</span>}
            </>
          )}
        </div>
      )}

      {history ? (
        <div className="history-page">
          <FileHistory agent={agent} place="memory" path={path} />
        </div>
      ) : source ? (
        <textarea
          className="memory-source"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaving("");
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
      ) : markdown || painted ? (
        <div className="shown-with-map">
          <div className={markdown ? "markdown-page" : "code-page"} ref={pane}>
            {text === null ? (
              <p className="dim">Loading</p>
            ) : markdown ? (
              <Markdown text={text} />
            ) : (
              <Code text={text} language={path} />
            )}
          </div>
          {minimap && text !== null && <Minimap pane={pane} revision={text} />}
        </div>
      ) : src ? (
        <iframe
          ref={frame}
          className="memory-frame"
          src={src}
          title={path}
          // Scripts, and links that open somewhere else. Never allow-same-origin:
          // with it, the file's script could reach this page and the API as you.
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="dim pad">Loading</p>
      )}
    </div>
  );
}

/** How documents in the memory view look. The theme is in the bar. */
function Look({
  docStyle,
  minimap,
  change,
}: {
  docStyle: boolean;
  minimap: boolean;
  change: (next: { docStyle?: boolean; minimap?: boolean }) => void;
}) {
  return (
    <div className="side-body look">
      <p className="side-title">Documents</p>
      <label className="check pad">
        <input type="checkbox" checked={docStyle} onChange={(event) => change({ docStyle: event.target.checked })} />
        <span>
          Document style
          <span className="dim"> for HTML with no stylesheet of its own: a reading width, a system face, sized headings.</span>
        </span>
      </label>
      <label className="check pad">
        <input type="checkbox" checked={minimap} onChange={(event) => change({ minimap: event.target.checked })} />
        <span>
          Minimap
          <span className="dim"> beside markdown and code. A note in a frame cannot be read from here, so it has none.</span>
        </span>
      </label>
    </div>
  );
}

/** Source control for a memory that is a git repository. */
function Changes({
  agent,
  git,
  refresh,
  pick,
}: {
  agent: string;
  git: Git | null;
  refresh: () => Promise<void>;
  pick: (path: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState("");

  if (!git) return <p className="dim pad">Loading</p>;
  if (!git.repo) {
    return (
      <div className="side-body">
        <p className="side-title">Source control</p>
        <p className="empty pad">This memory is not a git repository, so there is no history to show.</p>
      </div>
    );
  }

  async function act(what: string, run: () => Promise<string>) {
    setBusy(what);
    setSaid("");
    try {
      setSaid(await run());
      await refresh();
    } catch (error) {
      setSaid((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="side-body">
      <p className="side-title">
        Source control <span className="dim">{git.branch}</span>
      </p>

      <div className="commit-box">
        <textarea
          value={message}
          placeholder="What changed"
          onChange={(event) => setMessage(event.target.value)}
          rows={2}
        />
        <button
          className="small"
          disabled={!message.trim() || !git.changes.length || Boolean(busy)}
          onClick={() =>
            void act("commit", async () => {
              const done = await api.commit(agent, message);
              setMessage("");
              return `Committed ${done.files} file${done.files === 1 ? "" : "s"} as ${done.commit}.`;
            })
          }
        >
          {busy === "commit" ? "Committing" : "Commit all"}
        </button>
        <div className="row-buttons">
          <button
            className="small"
            disabled={!git.ahead || Boolean(busy)}
            title={git.upstream ? `Push to ${git.upstream}` : "No upstream branch"}
            onClick={() =>
              void act("push", async () => {
                const done = await api.push(agent);
                return done.pushed ? `Pushed ${done.pushed} to ${done.url || done.upstream}.` : "Nothing to push.";
              })
            }
          >
            {busy === "push" ? "Pushing" : `Push${git.ahead ? ` ${git.ahead}` : ""}`}
          </button>
          <button
            className="small"
            disabled={Boolean(busy)}
            onClick={() => void act("pull", async () => (await api.pull(agent)).output || "Up to date.")}
          >
            {busy === "pull" ? "Pulling" : `Pull${git.behind ? ` ${git.behind}` : ""}`}
          </button>
        </div>
        {said && <p className="dim said">{said}</p>}
      </div>

      <p className="side-title">Changes</p>
      {git.changes.length === 0 && <p className="empty pad">Nothing has changed since the last commit.</p>}
      <ul className="memory-tree">
        {git.changes.map((one) => (
          <li key={one.path}>
            <button className="row changed" onClick={() => pick(one.path)} title={one.path}>
              <span className="row-mark status">{one.status}</span>
              <span className="row-name">{one.path}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="side-title">Recent</p>
      <ul className="history">
        {git.log.map((one) => (
          <li key={one.sha} title={`${one.sha} by ${one.author}`}>
            <span className="dim num">{one.date}</span> {one.subject}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What has been read out of this memory over the web, newest first. The record
 * is where the reading happens rather than somewhere nobody looks.
 */
function Record({ agent }: { agent: string }) {
  const [lines, setLines] = useState<MemoryRead[] | null>(null);

  useEffect(() => {
    let stale = false;
    api.memoryLog(agent, 100).then(
      (got) => !stale && setLines(got),
      () => !stale && setLines([]),
    );
    return () => void (stale = true);
  }, [agent]);

  return (
    <div className="side-body">
      <p className="side-title">What has been read</p>
      <p className="dim pad">
        Every file opened here, and everything it loaded, is written down before it is shown. A shell on the box is
        not recorded.
      </p>
      {lines === null && <p className="dim pad">Loading</p>}
      <ul className="history">
        {(lines ?? []).map((one, at) => (
          <li key={`${one.at}-${at}`} title={one.from}>
            <span className="dim num">{when(one.at)}</span> <span className="dim">{one.what}</span> {one.path}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The entry at a path in the tree, or undefined when there is none. */
function find(entries: Entry[], path: string): Entry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.dir && entry.children && path.startsWith(`${entry.path}/`)) return find(entry.children, path);
  }
  return undefined;
}
