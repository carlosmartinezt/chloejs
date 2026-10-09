import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Picture, Said, Thread } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ago, labelOf, many, money, threadName, when } from "../lib/format.ts";
import * as Icons from "./components/Icons.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Trail } from "./components/Link.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { Prompt } from "./Log.tsx";
import { go, href } from "../lib/route.ts";
import { Collapse } from "./components/Collapse.tsx";

interface Line extends Said {
  cost?: number;
  failed?: boolean;
  /** Pictures sent with it, as addresses for this page. Gone on a reload, as they are on the runtime. */
  pictures?: string[];
}

/** A picture waiting to be sent, and the address it is shown by. */
interface Held extends Picture {
  url: string;
}

/** The most pictures one turn takes, which is the runtime's own limit. */
const MOST = 4;
/** The longest side a picture is sent at. Past this a model shrinks it anyway. */
const SIDE = 1568;

/**
 * A file as a picture to send, made smaller first when it is big, so a photo
 * off a phone costs what it needs to.
 */
async function picture(file: File): Promise<Held> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
  const kept = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type);
  if (kept && scale === 1 && file.size < 1_000_000) {
    bitmap.close();
    const url = await new Promise<string>((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result as string);
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(file);
    });
    return { name: file.name || "picture", mediaType: file.type, data: url.slice(url.indexOf(",") + 1), url };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.85);
  const name = (file.name || "picture").replace(/\.[^.]*$/, "") + ".jpg";
  return { name, mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
}

/** Shown while something is being read, which can take a second or two. */
const Loading = () => (
  <p className="thinking">
    <span className="dots">
      <i />
      <i />
      <i />
    </span>
    Loading
  </p>
);

/** One line of what it said, short enough to pick out of a list. */
export const gist = (words: string) => {
  const first = (words.trim().split("\n").find(Boolean) ?? "").replace(/\*\*|`/g, "");
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
};

/**
 * A conversation nobody has said anything in yet, named by a random id shaped
 * like a UUID. getRandomValues, because randomUUID needs https.
 */
const freshThread = (agent: string) => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${agent}/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * What to call a conversation in the list. One started somewhere else is
 * called after the place it is happening; one started here has no name worth
 * reading, so it is called by when it last moved.
 */
const called = (one: Thread): string => {
  const own = threadName(one.thread);
  return /^web(-|$)/.test(own) ? ago(one.last) || "just now" : own.replace(/^visitor-(.{6}).*/, "Visitor $1");
};

/** A visitor's conversation, from a chat box on a web page. */
const fromWeb = (one: Thread): boolean => threadName(one.thread).startsWith("visitor-");

export function Chat({ agent, thread: asked }: { agent: string; thread?: string }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [listed, setListed] = useState(false);
  const [thread, setThread] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pictures, setPictures] = useState<Held[]>([]);
  const [trouble, setTrouble] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; one: Thread } | null>(null);
  const [naming, setNaming] = useState("");
  const [archived, setArchived] = useState(false);
  const [doing, setDoing] = useState("");
  const [model, setModel] = useState("");
  const foot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // The box grows a line at a time as it is typed in, up to its max-height,
  // and scrolls past that. Measured before paint, so it never flickers.
  useLayoutEffect(() => {
    const area = box.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [prompt]);

  // Opening chat starts a new conversation, the way anything else with a chat
  // box does. The ones already going, here and on Telegram, are in the list
  // beside it and are one press away, and the agent remembers every one of
  // them whichever is picked.
  useEffect(() => {
    setListed(false);
    api.threads(agent).then(setThreads, () => setThreads([])).finally(() => setListed(true));
    // Which model the answer will come from, so it is known before anything is asked.
    api.agent(agent).then((one) => setModel(one.model), () => setModel(""));
  }, [agent]);

  // The conversation in the address, or a new one. Picking one puts it in the
  // address, so a reload comes back to it.
  useEffect(() => {
    setThread(asked ?? freshThread(agent));
  }, [agent, asked]);

  /** Start again, leaving what was said where it is. */
  function newChat() {
    setPrompt("");
    setPictures([]);
    setThread(freshThread(agent));
    go({ at: "chat", agent });
  }

  // Something said on another channel, or in another window, turns up here on
  // its own. The list of conversations is the one thing read every few
  // seconds; the open conversation is read again only when the list says it
  // grew.
  const known = useRef(0);
  useEffect(() => {
    if (waiting) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      api.threads(agent).then((all) => {
        setThreads(all);
        const open = all.find((one) => one.thread === thread);
        if (open && open.messages !== known.current) api.said(thread).then(setLines, () => {});
      }, () => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [agent, thread, waiting]);
  useEffect(() => {
    known.current = threads.find((one) => one.thread === thread)?.messages ?? lines.length;
  }, [threads, thread, lines.length]);

  // Only one picked from the list is shown as loading: a new one has nothing in it.
  useEffect(() => {
    if (!thread) return;
    let live = true;
    setLines([]);
    setLoading(thread === asked);
    api.said(thread).then(
      (said) => live && setLines(said),
      () => live && setLines([]),
    ).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [thread]);

  useEffect(() => {
    foot.current?.scrollIntoView({ block: "end" });
  }, [lines, waiting]);

  // What it is doing while it is doing it. A turn writes its trace step by
  // step, so the run it is in the middle of says which tool it just reached
  // for. Nothing here makes it happen, it only watches.
  useEffect(() => {
    if (!waiting) return void setDoing("");
    let live = true;
    let id: string | undefined;
    async function look() {
      try {
        if (!id) {
          const lately = await api.runs(5, agent);
          id = lately.find((run) => !run.finished && run.source === "chat")?.id;
        }
        if (!id) return;
        const run = await api.run(id);
        const last = [...run.trace].reverse().find((step) => step.tool ?? step.name);
        if (live) setDoing(last?.tool ?? last?.name ?? "");
      } catch {
        // The turn can finish between the two reads, which is not a problem.
      }
    }
    void look();
    const timer = setInterval(() => void look(), 800);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting, agent]);

  /** Pasted, dropped or picked: pictures are held to go with the next message, anything else is said no to. */
  async function hold(files: FileList | File[]) {
    const all = [...files];
    const images = all.filter((file) => file.type.startsWith("image/"));
    const room = MOST - pictures.length;
    setTrouble(
      images.length < all.length
        ? "Only pictures can be sent here."
        : images.length > room
          ? `${MOST} pictures at most, with one message.`
          : "",
    );
    try {
      const made = await Promise.all(images.slice(0, Math.max(room, 0)).map(picture));
      setPictures((held) => [...held, ...made].slice(0, MOST));
    } catch {
      setTrouble("That picture could not be read.");
    }
  }

  async function send() {
    const asked = prompt.trim();
    const sending = pictures;
    if ((!asked && !sending.length) || waiting) return;
    setPrompt("");
    setPictures([]);
    setTrouble("");
    setLines((said) => [
      ...said,
      { role: "user", content: asked, at: new Date().toISOString(), pictures: sending.length ? sending.map((one) => one.url) : undefined },
    ]);
    setWaiting(true);
    try {
      const answer = await api.say(agent, asked, thread, sending.map(({ name, mediaType, data }) => ({ name, mediaType, data })));
      setLines((said) => [...said, { role: "assistant", content: answer.text, cost: answer.cost, at: new Date().toISOString() }]);
      // A conversation started here only exists once something is in it, so
      // this is where it turns up in the list beside, and in the address.
      api.threads(agent).then(setThreads, () => {});
      if (!asked) window.history.replaceState(null, "", href({ at: "chat", agent, thread }));
    } catch (error) {
      setLines((said) => [...said, { role: "assistant", content: (error as Error).message, failed: true }]);
    } finally {
      setWaiting(false);
    }
  }

  /** Puts one conversation's new name or archive state into the list. */
  const changed = (thread: string, change: Partial<Thread>) =>
    setThreads((all) => all.map((one) => (one.thread === thread ? { ...one, ...change } : one)));

  async function rename(one: Thread, label: string) {
    setNaming("");
    if (label.trim() === (one.label ?? "")) return;
    const done = await api.renameThread(one.thread, label);
    changed(one.thread, { label: done.label });
  }

  async function archive(one: Thread, on: boolean) {
    const done = await api.archiveThread(one.thread, on);
    changed(one.thread, { archived: done.archived });
    if (on && one.thread === thread && !archived) newChat();
  }

  const shown = threads.filter((one) => archived || !one.archived);
  const hidden = threads.filter((one) => one.archived).length;
  const blank = lines.length === 0 && !waiting && !loading;

  return (
    <div className="chat">
      {/* Starting again, and every conversation this agent is in, each of
          which can be renamed or archived from its menu. The agent's other
          pages are Config in the bar. */}
      <nav className="past rail">
        <Collapse closeOn={thread}>
          <button className="new-chat" onClick={newChat}>
            <Icons.Plus />
            New chat
          </button>

        {!listed && (
          <>
            <h2>Conversations</h2>
            <Loading />
          </>
        )}
        {listed && shown.length > 0 && (
          <>
            <h2>Conversations</h2>
            <ul className="run-list">
              {shown.map((one) => (
                <li key={one.thread} className={menu?.one.thread === one.thread ? "held" : undefined}>
                  {naming === one.thread ? (
                    <input
                      className="naming"
                      autoFocus
                      defaultValue={one.label ?? called(one)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={(event) => void rename(one, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setNaming("");
                      }}
                    />
                  ) : (
                    <Fragment>
                      <button
                        id={`thread-${one.thread}`}
                        className="plain"
                        aria-current={one.thread === thread}
                        title={`${many(one.messages, "message")}, last ${ago(one.last) || "just now"}`}
                        onClick={() => go({ at: "chat", agent, thread: one.thread })}
                        onDoubleClick={() => setNaming(one.thread)}
                      >
                        <span className={one.archived ? "headline dim" : "headline"}>{one.label || called(one)}</span>
                        {fromWeb(one) && (
                          <span className="num dim" title="A visitor, on a web page">
                            web
                          </span>
                        )}
                        <span className="num dim">{one.messages}</span>
                      </button>
                      <button
                        className="plain more"
                        title="More"
                        aria-label="More"
                        onClick={(event) => {
                          const box = event.currentTarget.getBoundingClientRect();
                          setMenu({ x: box.right, y: box.bottom + 4, one });
                        }}
                      >
                        <Icons.More />
                      </button>
                    </Fragment>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {hidden > 0 && (
          <button className="plain show-archived" onClick={() => setArchived(!archived)}>
            {archived ? "Hide archived" : `Show ${many(hidden, "archived conversation")}`}
          </button>
        )}
        {menu && (
          <ContextMenu
            at={menu}
            from="right"
            close={() => setMenu(null)}
            choices={[
              { label: "Rename", run: () => setNaming(menu.one.thread) },
              { label: menu.one.archived ? "Unarchive" : "Archive", run: () => void archive(menu.one, !menu.one.archived) },
            ]}
          />
        )}
        </Collapse>
      </nav>

      <div
        className={blank ? "talking blank" : "talking"}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void hold(event.dataTransfer.files);
        }}
      >
        <div className="head">
          <Trail agent={agent} steps={[{ name: "chat" }]} />
          {model && <span className="model">{model}</span>}
        </div>

        <div className="scroll">
          {blank ? (
            <div className="hello">
              <h2>Ready when you are.</h2>
              <p>
                This conversation is kept, so {labelOf(agent)} remembers it next time, wherever it is
                next spoken to.
              </p>
            </div>
          ) : null}
          <div className="thread run-thread">
            {loading && <Loading />}
            {lines.map((line, at) =>
              line.role === "user" ? (
                <Fragment key={at}>
                  {line.pictures && (
                    <div className="msg you pictures">
                      {line.pictures.map((url, n) => (
                        <img key={n} src={url} alt="" />
                      ))}
                    </div>
                  )}
                  {(line.content || !line.pictures) && (
                    <Prompt
                      prompt={line.content}
                      at={line.at}
                      stamp={when}
                      visitor={thread.includes("/visitor-") ? { agent, id: thread.slice(thread.indexOf("/visitor-") + 9) } : undefined}
                    />
                  )}
                </Fragment>
              ) : (
                <div className={line.failed ? "msg them bad" : "msg them"} key={at} id={`said-${at}`}>
                  <div className="said">
                    <Markdown text={line.content} />
                  </div>
                  <div className="meta num">
                    {[labelOf(agent), line.at && when(line.at), line.cost !== undefined && money(line.cost)].filter(Boolean).join(", ")}
                  </div>
                </div>
              ),
            )}
            {waiting && (
              <p className="thinking">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                Thinking
                {doing && <span className="num doing">{doing}</span>}
              </p>
            )}
            <div ref={foot} />
          </div>
        </div>

        <div className="composer">
          <div className="box">
            {pictures.length > 0 && (
              <div className="pictures">
                {pictures.map((one, n) => (
                  <button
                    key={n}
                    className="plain"
                    title={`Take ${one.name} off`}
                    onClick={() => setPictures((held) => held.filter((_, at) => at !== n))}
                  >
                    <img src={one.url} alt={one.name} />
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={box}
              rows={1}
              value={prompt}
              placeholder={`Ask ${labelOf(agent)} something`}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                void hold(event.clipboardData.files);
              }}
              // Enter sends, because this is a chat box. A newline is shift-enter.
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {/* Under the words, the way other chat boxes are: adding on the left, sending on the right. */}
            <div className="row">
              <label className="attach" title="Add a picture" aria-label="Add a picture">
                <Icons.Plus />
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void hold(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <button
                className="go"
                aria-label={`Send to ${labelOf(agent)}`}
                onClick={send}
                disabled={waiting || (!prompt.trim() && !pictures.length)}
              >
                <Icons.Send />
              </button>
            </div>
          </div>
          {trouble && <p className="under">{trouble}</p>}
        </div>
      </div>
    </div>
  );
}
