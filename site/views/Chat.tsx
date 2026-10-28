import { type CSSProperties, type DragEvent, Fragment, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentSummary, Group, Picture, Said, Step, Thread } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ago, nameOf, many, money, spent, threadName, when, words } from "../lib/format.ts";
import * as Icons from "./components/Icons.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { type Choice, ContextMenu } from "./components/ContextMenu.tsx";
import { modelChoices, type Offered } from "../lib/models.ts";
import { Card, Prompt } from "./Log.tsx";
import { go, href } from "../lib/route.ts";
import { chatWidth, lastChat, setChatWidth, setLastChat } from "../lib/prefs.ts";
import { ideasFor } from "../lib/ideas.ts";
import { Collapse } from "./components/Collapse.tsx";
import { Pick, type Option } from "./components/Pick.tsx";

interface Line extends Said {
  cost?: number;
  unpriced?: number;
  failed?: boolean;
  /** Pictures sent with it, as addresses for this page. Gone on a reload, as they are on the runtime. */
  pictures?: string[];
  /** The answers it asks to pick from, shown under it while it is the last line. Gone on a reload: the words still list them. */
  buttons?: Option[];
  multiple?: boolean;
}

/** A picture waiting to be sent, and the address it is shown by. */
interface Held extends Picture {
  url: string;
}

/** How long a line under "Thinking" stays after the next one shows, in ms. */
const FOLD = 3000;
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

/** `owner` may pick the model for a conversation; anybody else only sees it. */
export function Chat({ agent, thread: asked, about, owner }: { agent: string; thread?: string; about?: string; owner: boolean }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [listed, setListed] = useState(false);
  const [thread, setThread] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pictures, setPictures] = useState<Held[]>([]);
  // A file in its memory, held to go with the next message as its full link.
  const [file, setFile] = useState("");
  const [trouble, setTrouble] = useState("");
  // The conversations waiting on an answer. Each one is its own, so another
  // conversation opened meanwhile is not shown as thinking, and can be spoken to.
  // Each with when it was asked, for the clock beside "Thinking".
  const [waitingOn, setWaitingOn] = useState<ReadonlyMap<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; one: Thread } | null>(null);
  const [naming, setNaming] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: Group } | null>(null);
  // The group being named: its id, or "new" for one being made. A new one made
  // from a conversation's menu has that conversation filed under it.
  const [namingGroup, setNamingGroup] = useState<number | "new" | null>(null);
  const [fileInNew, setFileInNew] = useState("");
  // The groups folded shut, which leaves only their name showing.
  const [shut, setShut] = useState<ReadonlySet<number>>(new Set());
  // A conversation being dragged, and where it would land: a group's id, or null for Recent.
  const [dragged, setDragged] = useState<Thread | null>(null);
  const [over, setOver] = useState<number | null | undefined>(undefined);
  const [archived, setArchived] = useState(false);
  const [width, setWidth] = useState(chatWidth);
  const [doing, setDoing] = useState<Step[]>([]);
  // When this page first saw each line of `doing`, which is what folds it away.
  const seen = useRef<number[]>([]);
  // The lines under "Thinking" that had folded away, opened again.
  const [showing, setShowing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [offered, setOffered] = useState<Offered[]>([]);
  const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
  // Up to three things to ask under an empty box, chosen as the agent opens.
  const [ideas, setIdeas] = useState<string[]>([]);
  // The message of theirs being changed, by where it is in `lines`, and what it says now.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // What a "/" in the box offers, the one picked with the arrow keys, and
  // whether Escape put the list away until the "/" is gone.
  const [commands, setCommands] = useState<{ command: string; description: string }[]>([]);
  const [chosen, setChosen] = useState(0);
  const [noList, setNoList] = useState(false);
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
    setGroups([]);
    if (owner) api.groups(agent).then(setGroups, () => {});
    // Which model the answer will come from, so it is known before anything is asked.
    api.agent(agent).then(
      (one) => {
        setSummary(one);
        setIdeas(ideasFor(one));
      },
      () => setSummary(null),
    );
    setOffered([]);
    if (owner) api.models(agent).then(setOffered, () => {});
    setCommands([]);
    if (owner) api.commands(agent).then(setCommands, () => {});
  }, [agent, owner]);

  // A pick for this conversation beats what the agent runs on otherwise.
  const waiting = waitingOn.has(thread);
  const since = waitingOn.get(thread);
  // A line under "Thinking" folds away once the one after it has been showing a
  // few seconds, so the newest is always there and the rest scroll past.
  const foldedAt = (at: number) => at < doing.length - 1 && now - (seen.current[at + 1] ?? now) > FOLD;
  const folded = doing.filter((_, at) => foldedAt(at)).length;
  const open = useRef(thread);
  // The conversations this page is waiting on an answer from.
  const asking = useRef(new Set<string>());
  const done = (one: string) =>
    setWaitingOn((all) => {
      const left = new Map(all);
      left.delete(one);
      return left;
    });
  open.current = thread;
  const picked = summary?.chosen.find((one) => one.scope === `chat:${thread}`)?.model;
  const model = picked === "auto" || (!picked && summary?.auto) ? "Auto" : (picked ?? summary?.model ?? "");
  const titled = (name: string) => summary?.titles?.[name] ?? words(name);

  async function pick(to: string) {
    try {
      setSummary(await api.pickModel(agent, `chat:${thread}`, to));
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  // The conversation in the address, or a new one. Picking one puts it in the
  // address, so a reload comes back to it. Coming back to chat with none in
  // the address opens the one that was open last, which is a new one when
  // that was.
  useEffect(() => {
    const back = asked || about ? "" : lastChat(agent);
    if (back) {
      window.history.replaceState({ at: "chat", agent, thread: back }, "", href({ at: "chat", agent, thread: back }));
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    setLastChat(agent, asked ?? "");
    setThread(asked ?? freshThread(agent));
    setFile(about ?? "");
  }, [agent, asked, about]);

  /** Start again, leaving what was said where it is. */
  function newChat() {
    setPrompt("");
    setPictures([]);
    setFile("");
    setThread(freshThread(agent));
    setLastChat(agent, "");
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
    setEditing(null);
    setLoading(thread === asked);
    api.said(thread).then(
      (said) => live && setLines(said),
      () => live && setLines([]),
    ).finally(() => live && setLoading(false));
    // A turn still going, asked before a reload or from another window, is
    // shown as thinking from when it started.
    api.runs(10, agent).then((runs) => {
      const going = runs.find((run) => !run.finished && run.thread === thread);
      if (live && going) setWaitingOn((all) => (all.has(thread) ? all : new Map(all).set(thread, Date.parse(going.started))));
    }, () => {});
    return () => {
      live = false;
    };
  }, [thread]);

  useEffect(() => {
    foot.current?.scrollIntoView({ block: "end" });
  }, [lines, waiting, doing.length]);

  // Whether the end of the conversation is in sight. Watched against the
  // window, not the list, because on a phone it is the whole column that scrolls.
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    const end = foot.current;
    if (!end) return;
    const watching = new IntersectionObserver(([one]) => setAtEnd(one.isIntersecting));
    watching.observe(end);
    return () => watching.disconnect();
  }, []);

  // What it is doing while it is doing it. A turn writes its trace step by
  // step, so the run it is in the middle of says which tools it has reached
  // for. Nothing here makes it happen, it only watches. A turn this page did
  // not ask for has no answer coming back to wait on, so when its run
  // finishes, the conversation is read again instead.
  useEffect(() => {
    seen.current = [];
    if (!waiting) {
      setDoing([]);
      setShowing(false);
      return;
    }
    let live = true;
    let id: string | undefined;
    // A turn keeps the question as it starts, so a conversation started here
    // joins the list beside as soon as it is asked, not when it is answered.
    let listed = false;
    async function look() {
      try {
        if (!id) {
          const lately = await api.runs(5, agent);
          id = lately.find((run) => !run.finished && run.thread === thread)?.id;
        }
        if (!id) return;
        if (!listed) {
          const all = await api.threads(agent);
          listed = all.some((one) => one.thread === thread);
          if (live) setThreads(all);
        }
        const run = await api.run(id);
        if (live) {
          const steps = run.trace.filter((step) => step.tool ?? step.name ?? (step.wants?.length && step.say?.trim()));
          while (seen.current.length < steps.length) seen.current.push(Date.now());
          setDoing(steps);
        }
        if (live && run.finished && !asking.current.has(thread)) {
          done(thread);
          api.said(thread).then((said) => open.current === thread && setLines(said), () => {});
          api.threads(agent).then(setThreads, () => {});
        }
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
  }, [waiting, agent, thread]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

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

  /**
   * Sends what is in the box, or `picked`, an answer pressed under the last
   * reply or a message changed in place, leaving the box as it is. With
   * `edit`, the line at `edit` and everything after it are taken back first.
   */
  async function send(picked?: string, edit?: number) {
    // On the page a new conversation is a new chat, which is all /clear asks for.
    if (/^\/clear\s*$/i.test(picked ?? prompt)) {
      newChat();
      return;
    }
    const link = file ? `${window.location.origin}${href({ at: "memory", agent, path: file })}` : "";
    const words = picked ?? [prompt.trim(), link].filter(Boolean).join("\n\n");
    const sending = picked ? [] : pictures;
    if ((!words && !sending.length) || waiting) return;
    if (!picked) {
      setPrompt("");
      setPictures([]);
      setFile("");
    }
    setTrouble("");
    const replaces = edit === undefined ? undefined : lines[edit]?.id;
    const mine: Line = { role: "user", content: words, at: new Date().toISOString(), pictures: sending.length ? sending.map((one) => one.url) : undefined };
    setLines((said) => [...(edit === undefined ? said : said.slice(0, edit)), mine]);
    const to = thread;
    setWaitingOn((all) => new Map(all).set(to, Date.now()));
    asking.current.add(to);
    // An answer to a conversation no longer open is not shown here: opening it
    // again reads it back with the answer in it.
    const here = (line: Line) => open.current === to && setLines((said) => [...said, line]);
    try {
      const answer = await api.say(agent, words, to, sending.map(({ name, mediaType, data }) => ({ name, mediaType, data })), replaces);
      // The ids it was kept under, so it can be forked or edited without reading it all again.
      const asked = answer.kept?.find((one) => one.role === "user")?.id;
      if (asked !== undefined && open.current === to) setLines((said) => said.map((line) => (line === mine ? { ...line, id: asked } : line)));
      here({
        id: answer.kept?.findLast((one) => one.role === "assistant")?.id,
        role: "assistant",
        content: answer.text,
        cost: answer.cost,
        unpriced: answer.unpriced,
        at: new Date().toISOString(),
        ...(answer.buttons?.length && { buttons: answer.buttons, multiple: answer.multiple }),
      });
      // Which run wrote it, and what that run did, are only kept on the runtime.
      api.said(to).then((said) => {
        const kept = new Map(said.filter((one) => one.run).map((one) => [one.id, one]));
        if (open.current === to) setLines((all) => all.map((line) => (kept.has(line.id) ? { ...line, run: kept.get(line.id)?.run, did: kept.get(line.id)?.did } : line)));
      }, () => {});
      // The answer moves it to the top of the list beside, and a conversation
      // started here goes into the address now that it exists.
      api.threads(agent).then(setThreads, () => {});
      // /model typed in the box picks one too.
      if (/^\/models?\b/i.test(words)) api.agent(agent).then(setSummary, () => {});
      if (!asked && open.current === to) {
        window.history.replaceState(null, "", href({ at: "chat", agent, thread: to }));
        setLastChat(agent, to);
      }
    } catch (error) {
      here({ role: "assistant", content: (error as Error).message, failed: true });
    } finally {
      asking.current.delete(to);
      done(to);
    }
  }

  /** A new conversation with what was said up to and including `line`, opened. This one stays as it is. */
  async function fork(line: Line) {
    if (line.id === undefined) return;
    try {
      const made = await api.fork(thread, line.id);
      api.threads(agent).then(setThreads, () => {});
      go({ at: "chat", agent, thread: made.thread });
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  /** Sends the message being changed in place of the one it was. */
  function resend(at: number) {
    if (!draft.trim()) return;
    setEditing(null);
    void send(draft.trim(), at);
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

  async function pin(one: Thread, on: boolean) {
    const done = await api.pinThread(one.thread, on);
    changed(one.thread, { pinned: done.pinned });
  }

  async function fileUnder(one: string, group: number | null) {
    const done = await api.groupThread(one, group);
    changed(one, { group: done.group });
  }

  /** Gone for good, unlike archiving: what was said is deleted, and the agent no longer remembers it. */
  async function remove(one: Thread) {
    if (!window.confirm(`Delete "${one.label || called(one)}"? It is gone for good, and ${nameOf(agent)} will not remember it. Archive keeps it.`)) return;
    await api.forget(one.thread);
    setThreads((all) => all.filter((each) => each.thread !== one.thread));
    if (one.thread === thread) newChat();
  }

  async function nameGroup(name: string) {
    const which = namingGroup;
    setNamingGroup(null);
    const into = fileInNew;
    setFileInNew("");
    if (!name.trim()) return;
    try {
      if (which === "new") {
        const made = await api.makeGroup(agent, name.trim());
        setGroups((all) => [...all, made].sort((a, b) => a.name.localeCompare(b.name)));
        if (into) await fileUnder(into, made.id);
      } else if (which !== null) {
        const done = await api.renameGroup(agent, which, name.trim());
        setGroups((all) => all.map((one) => (one.id === which ? done : one)).sort((a, b) => a.name.localeCompare(b.name)));
      }
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  async function deleteGroup(group: Group) {
    if (!window.confirm(`Delete the group "${group.name}"? Its conversations are kept, under Recent.`)) return;
    await api.deleteGroup(agent, group.id);
    setGroups((all) => all.filter((one) => one.id !== group.id));
    setThreads((all) => all.map((one) => (one.group === group.id ? { ...one, group: null } : one)));
  }

  // The browser's tab is named after the open conversation, and goes back to what it was on leaving chat.
  const openOne = threads.find((one) => one.thread === thread);
  const tabName = openOne ? openOne.label || called(openOne) : "New chat";
  useEffect(() => {
    const was = document.title;
    return () => {
      document.title = was;
    };
  }, []);
  useEffect(() => {
    document.title = tabName;
  }, [tabName]);

  // The commands that start with what follows the "/", while nothing else is typed.
  const slash = /^\/(\w*)$/.exec(prompt);
  const offer = slash && !noList ? commands.filter((one) => one.command.startsWith(slash[1].toLowerCase())) : [];
  useEffect(() => {
    setChosen(0);
    if (!prompt.startsWith("/")) setNoList(false);
  }, [prompt]);

  /** Runs a command picked from the list, as if it had been typed and sent. */
  function command(name: string) {
    setPrompt("");
    void send(`/${name}`);
  }

  const shown = threads.filter((one) => archived || !one.archived);
  const pinned = shown.filter((one) => one.pinned);
  const grouped = (group: Group) => shown.filter((one) => !one.pinned && one.group === group.id);
  const recent = shown.filter((one) => !one.pinned && !groups.some((group) => group.id === one.group));
  const hidden = threads.filter((one) => one.archived).length;
  const blank = lines.length === 0 && !waiting && !loading;

  // The list of conversations widens when its edge is dragged, so a long name
  // can be read, up to a limit that leaves the conversation room.
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const edge = event.currentTarget;
    const { left } = (edge.parentElement as HTMLElement).getBoundingClientRect();
    edge.setPointerCapture(event.pointerId);
    let now = width;
    const move = (moved: globalThis.PointerEvent) => {
      now = Math.min(Math.max(moved.clientX - left, 220), 480);
      setWidth(now);
    };
    const done = () => {
      edge.removeEventListener("pointermove", move);
      setChatWidth(now);
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("lostpointercapture", done, { once: true });
  };

  /**
   * Where a conversation can be dropped: on a group, or with `null` on Recent,
   * which takes it out of its group. Dropped where it already is, nothing changes.
   */
  const dropOn = (group: number | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(group);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setOver(undefined);
      if (dragged && (dragged.group ?? null) !== group) void fileUnder(dragged.thread, group);
    },
  });

  /**
   * One conversation in the list beside, which opens it, with its menu, and can
   * be dragged into a group or out. One in a group takes a drop for that group.
   */
  const row = (one: Thread, group?: number) => (
    <li
      key={one.thread}
      className={menu?.one.thread === one.thread ? "held" : undefined}
      {...(group !== undefined && dropOn(group))}
      draggable={owner && naming !== one.thread}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", one.label || called(one));
        setDragged(one);
      }}
      onDragEnd={() => {
        setDragged(null);
        setOver(undefined);
      }}
    >
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
  );

  /** The box a group is named in, in its row's place. */
  const groupName = (name: string) => (
    <input
      className="naming"
      autoFocus
      placeholder="Group name"
      defaultValue={name}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => void nameGroup(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setNamingGroup(null);
          setFileInNew("");
        }
      }}
    />
  );

  return (
    <div className="chat" style={width ? ({ "--rail-w": `${width}px` } as CSSProperties) : undefined}>
      {/* Starting again, and every conversation this agent is in: pinned, then
          by group, then the rest, each pinned, renamed, grouped, archived or
          deleted from its menu. The agent's other pages are Config in the bar. */}
      <nav className="past rail">
        <Collapse closeOn={thread} label="Past conversations">
          <button className="new-chat" onClick={newChat}>
            <Icons.NewConversation />
            New chat
          </button>

        {!listed && (
          <>
            <h2>Recent</h2>
            <Loading />
          </>
        )}
        {listed && pinned.length > 0 && (
          <>
            <h2>Pinned</h2>
            <ul className="run-list">{pinned.map((one) => row(one))}</ul>
          </>
        )}
        {listed && owner && (
          <>
            <h2 className="adds">
              Groups
              <button className="plain add" title="New group" aria-label="New group" onClick={() => setNamingGroup("new")}>
                <Icons.Plus />
              </button>
            </h2>
            <ul className="run-list">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <li
                    className={[groupMenu?.group.id === group.id && "held", over === group.id && "over"].filter(Boolean).join(" ") || undefined}
                    {...dropOn(group.id)}
                  >
                    {namingGroup === group.id ? (
                      groupName(group.name)
                    ) : (
                      <Fragment>
                        <button
                          id={`group-${group.id}`}
                          className="plain"
                          aria-expanded={!shut.has(group.id)}
                          onClick={() =>
                            setShut((all) => {
                              const next = new Set(all);
                              if (!next.delete(group.id)) next.add(group.id);
                              return next;
                            })
                          }
                          onDoubleClick={() => setNamingGroup(group.id)}
                        >
                          {shut.has(group.id) ? <Icons.Folder /> : <Icons.FolderOpen />}
                          <span className="headline">{group.name}</span>
                        </button>
                        <button
                          className="plain more"
                          title="More"
                          aria-label="More"
                          onClick={(event) => {
                            const box = event.currentTarget.getBoundingClientRect();
                            setGroupMenu({ x: box.right, y: box.bottom + 4, group });
                          }}
                        >
                          <Icons.More />
                        </button>
                      </Fragment>
                    )}
                  </li>
                  {!shut.has(group.id) && grouped(group).map((one) => row(one, group.id))}
                </Fragment>
              ))}
              {namingGroup === "new" && <li>{groupName("")}</li>}
            </ul>
          </>
        )}
        {listed && recent.length > 0 && (
          <div className={over === null ? "recent over" : "recent"} {...dropOn(null)}>
            <h2>Recent</h2>
            <ul className="run-list">{recent.map((one) => row(one))}</ul>
          </div>
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
              { label: menu.one.pinned ? "Unpin" : "Pin", run: () => void pin(menu.one, !menu.one.pinned) },
              { label: "Rename", run: () => setNaming(menu.one.thread) },
              ...(owner
                ? ([
                    {
                      label: "Move to group",
                      more: [
                        ...groups.map((group) => ({
                          label: group.name,
                          current: menu.one.group === group.id,
                          run: () => void fileUnder(menu.one.thread, menu.one.group === group.id ? null : group.id),
                        })),
                        ...(groups.length ? ["line" as const] : []),
                        {
                          label: "New group…",
                          run: () => {
                            setFileInNew(menu.one.thread);
                            setNamingGroup("new");
                          },
                        },
                      ],
                    },
                    "line",
                  ] as Choice[])
                : []),
              { label: menu.one.archived ? "Unarchive" : "Archive", run: () => void archive(menu.one, !menu.one.archived) },
              { label: "Delete", danger: true, run: () => void remove(menu.one) },
            ]}
          />
        )}
        {groupMenu && (
          <ContextMenu
            at={groupMenu}
            from="right"
            close={() => setGroupMenu(null)}
            choices={[
              { label: "Rename", run: () => setNamingGroup(groupMenu.group.id) },
              { label: "Delete", danger: true, run: () => void deleteGroup(groupMenu.group) },
            ]}
          />
        )}
        </Collapse>
        {/* Only on a phone, where the list is closed: starting again without opening it. */}
        <button className="plain start" title="New chat" aria-label="New chat" onClick={newChat}>
          <Icons.NewConversation />
        </button>
      </nav>

      <div className="edge" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown={drag} />

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
          {model &&
            (owner ? (
              <button
                className={picked ? "model picked" : "model"}
                title={picked ? "Picked for this conversation" : "What the agent runs on. Pick another for this conversation."}
                aria-haspopup="menu"
                aria-expanded={Boolean(picking)}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setPicking(picking ? null : { x: box.left, y: box.bottom + 4 });
                }}
              >
                {model}
              </button>
            ) : (
              <span className="model">{model}</span>
            ))}
          {picking && summary && (
            <ContextMenu
              at={picking}
              from="left"
              close={() => setPicking(null)}
              search="Search models"
              choices={[
                { head: "For this conversation" },
                { label: `Default (${summary.auto ? "Auto" : summary.model})`, run: () => void pick(""), current: !picked },
                ...(summary.quick && !summary.auto
                  ? [
                      {
                        label: "Auto",
                        title: `${summary.quick} for an easy message, ${summary.model} for the rest`,
                        run: () => void pick("auto"),
                        current: picked === "auto",
                      },
                    ]
                  : []),
                ...modelChoices(offered, (one) => void pick(one), picked),
              ]}
            />
          )}
        </div>

        <div className="scroll">
          {blank ? (
            <div className="hello">
              <h2>Ready when you are.</h2>
              <p>
                This conversation is kept, so {nameOf(agent)} remembers it next time, wherever it is
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
                  {editing === at ? (
                    <div className="msg you editing">
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            resend(at);
                          }
                          if (event.key === "Escape") setEditing(null);
                        }}
                      />
                      <div className="row">
                        <button className="plain" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button onClick={() => resend(at)} disabled={!draft.trim() || waiting}>
                          Send
                        </button>
                      </div>
                    </div>
                  ) : (
                    (line.content || !line.pictures) && (
                      <Prompt
                        whole
                        prompt={line.content}
                        at={line.at}
                        stamp={when}
                        visitor={thread.includes("/visitor-") ? { agent, id: thread.slice(thread.indexOf("/visitor-") + 9) } : undefined}
                        actions={
                          line.id !== undefined &&
                          !waiting &&
                          !thread.includes("/visitor-") && (
                            <button
                              className="plain act"
                              title="Edit"
                              aria-label="Edit"
                              onClick={() => {
                                // A channel's note on who wrote it is not theirs to change.
                                setDraft(line.content.replace(/^\s*<([a-z_]+)>\n?[\s\S]*?\n?<\/\1>\s*/, ""));
                                setEditing(at);
                              }}
                            >
                              <Icons.Edit />
                            </button>
                          )
                        }
                      />
                    )
                  )}
                </Fragment>
              ) : line.summary ? (
                // What /compact wrote: the agent carries on from this, and the page keeps it folded.
                <details className="msg summed" key={at} id={`said-${at}`}>
                  <summary>Compacted: what came before, summed up{line.at && <span className="num">, {when(line.at)}</span>}</summary>
                  <div className="said">
                    <Markdown text={line.content} />
                  </div>
                </details>
              ) : (
                <div className={line.failed ? "msg them bad" : "msg them"} key={at} id={`said-${at}`}>
                  {line.run && line.did && <Steps run={line.run} did={line.did} titled={titled} />}
                  <div className="said">
                    <Markdown text={line.content} />
                  </div>
                  {line.buttons && at === lines.length - 1 && (
                    <Pick options={line.buttons} multiple={line.multiple} disabled={waiting} pick={(text) => void send(text)} />
                  )}
                  <div className="meta num">
                    {line.id !== undefined && (
                      <button className="plain act" title="Fork into a new chat" aria-label="Fork into a new chat" onClick={() => void fork(line)}>
                        <Icons.Branch />
                      </button>
                    )}
                    {[nameOf(agent), line.at && when(line.at), line.cost !== undefined && (line.unpriced ? spent(line.cost, line.unpriced) : money(line.cost))].filter(Boolean).join(", ")}
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
                {since !== undefined && <span className="num">{lasted(now - since)}</span>}
                {folded > 0 && (
                  <button className="plain num doing" aria-expanded={showing} onClick={() => setShowing(!showing)}>
                    {showing ? "Hide earlier" : many(folded, "earlier step")}
                  </button>
                )}
              </p>
            )}
            {waiting && doing.length > 0 && (
              <div className="did">
                {doing.map((step, at) => (
                  <div key={at} className={!showing && foldedAt(at) ? "line folded" : "line"}>
                    <div>
                      {step.tool ?? step.name ? (
                        <Card name={titled(step.tool ?? step.name ?? "")} step={step} />
                      ) : (
                        <p className="thought">{step.say}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div ref={foot} />
          </div>
        </div>

        <div className="composer">
          {!atEnd && !blank && (
            <button
              className="to-end"
              title="Down to the newest"
              aria-label="Down to the newest"
              onClick={() => foot.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
            >
              <Icons.ToEnd />
            </button>
          )}
          <div className="box">
            {offer.length > 0 && (
              <ul className="commands" role="listbox" aria-label="Commands">
                {offer.map((one, at) => (
                  <li key={one.command} role="option" aria-selected={at === chosen}>
                    <button
                      className="plain"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setChosen(at)}
                      onClick={() => command(one.command)}
                    >
                      <span className="name">/{one.command}</span>
                      <span className="about">{one.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {file && (
              <button className="plain held-file" title={`Take ${file} off`} onClick={() => setFile("")}>
                <Icons.File />
                {file.split("/").pop()}
              </button>
            )}
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
              placeholder={`Ask ${nameOf(agent)} something`}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                void hold(event.clipboardData.files);
              }}
              // Enter sends, because this is a chat box. A newline is shift-enter.
              // With the list of commands showing, the arrows move in it, Enter
              // runs the one picked, Tab writes it in to add words after, and
              // Escape puts the list away.
              onKeyDown={(event) => {
                if (offer.length) {
                  const pick = offer[Math.min(chosen, offer.length - 1)];
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setChosen((at) => (at + (event.key === "ArrowDown" ? 1 : offer.length - 1)) % offer.length);
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    command(pick.command);
                    return;
                  }
                  if (event.key === "Tab") {
                    event.preventDefault();
                    setPrompt(`/${pick.command} `);
                    return;
                  }
                  if (event.key === "Escape") {
                    setNoList(true);
                    return;
                  }
                }
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
                aria-label={`Send to ${nameOf(agent)}`}
                onClick={() => void send()}
                disabled={waiting || (!prompt.trim() && !pictures.length && !file)}
              >
                <Icons.Send />
              </button>
            </div>
          </div>
          {trouble && <p className="under">{trouble}</p>}
          {blank && !prompt && ideas.length > 0 && (
            <div className="ideas">
              {ideas.map((idea) => (
                <button
                  key={idea}
                  className="plain"
                  onClick={() => {
                    setPrompt(idea);
                    box.current?.focus();
                  }}
                >
                  {idea}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a reply's steps came to, in a line: "Read 5, changed 2, 1 failed". */
function didLine(did: NonNullable<Said["did"]>): string {
  const parts = [
    did.read && `read ${did.read}`,
    did.changed && `changed ${did.changed}`,
    did.ran && `ran ${did.ran}`,
    did.other && (did.read || did.changed || did.ran ? many(did.other, "other step") : many(did.other, "step")),
    did.failed && `${did.failed} failed`,
  ].filter(Boolean) as string[];
  const said = parts.join(", ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** The steps behind a reply, folded into a grey line above it, read from its run when opened. */
function Steps({ run, did, titled }: { run: string; did: NonNullable<Said["did"]>; titled: (name: string) => string }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [trouble, setTrouble] = useState("");
  function toggle() {
    setOpen(!open);
    if (steps || open) return;
    api.run(run).then(
      (one) => setSteps(one.trace.filter((step) => step.tool ?? step.name ?? (step.wants?.length && step.say?.trim()))),
      (error) => setTrouble((error as Error).message),
    );
  }
  return (
    <div className="steps">
      <button className="plain num" aria-expanded={open} onClick={toggle}>
        {didLine(did)}
      </button>
      {open && trouble && <p className="thought">{trouble}</p>}
      {open && steps && (
        <div className="did">
          {steps.map((step, at) => (
            <div key={at} className="line">
              <div>{step.tool ?? step.name ? <Card name={titled(step.tool ?? step.name ?? "")} step={step} /> : <p className="thought">{step.say}</p>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** How long it has been thinking: "8s", "1m 05s". */
function lasted(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

