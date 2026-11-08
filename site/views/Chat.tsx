import { type CSSProperties, type DragEvent, Fragment, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentSummary, Group, Said, SentFile, Step, Thread } from "../lib/types.ts";
import { AnswerGone, api, CallFailed } from "../lib/api.ts";
import { ago, nameOf, many, money, saidAt, spent, threadName, when, words } from "../lib/format.ts";
import * as Icons from "./components/Icons.tsx";
import { CopyButton } from "./components/Code.tsx";
import { Markdown, rich } from "./components/Markdown.tsx";
import { type Choice, ContextMenu } from "./components/ContextMenu.tsx";
import { byPlace, moved } from "../lib/order.ts";
import { modelChoices, modelName, shortChoices, type Offered } from "../lib/models.ts";
import { Card, Prompt } from "./Log.tsx";
import { go, href } from "../lib/route.ts";
import { copy } from "../lib/copy.ts";
import { chatWidth, lastChat, setChatWidth, setLastChat, setTyped, typed } from "../lib/prefs.ts";
import { ideasFor, ideasFrom } from "../lib/ideas.ts";
import { Collapse } from "./components/Collapse.tsx";
import { Pick, type Option } from "./components/Pick.tsx";

interface Line extends Said {
  cost?: number;
  unpriced?: number;
  failed?: boolean;
  /** Pictures sent with it, as addresses for this page, until the runtime's own copy of the message is read. */
  pictures?: string[];
  /** The names of the other files sent with it, until then too. */
  named?: string[];
  /** The answers it asks to pick from, shown under it while it is the last line. Gone on a reload: the words still list them. */
  buttons?: Option[];
  multiple?: boolean;
}

/** A file waiting to be sent, and for a picture the address it is shown by. */
interface Held extends SentFile {
  url?: string;
}

/** How long a line under "Thinking" stays after the next one shows, in ms. */
const FOLD = 3000;
/** A reply's words without the files it handed over, which mean nothing anywhere else. */
export const withoutFiles = (content: string) => content.replace(/!?\[[^\]\n]*\]\(file:[^)\s]+\)\s*/g, "").trim();

/**
 * What somebody's message shows: without the lines that show the files they
 * sent, and without the block after it that tells the model about them.
 */
const shownOf = (content: string) => withoutFiles(content.replace(/\n*<files>\n[\s\S]*<\/files>\s*$/, ""));

/** What somebody wrote, without a channel's note on who wrote it or the files, which are not theirs to change or copy. */
export const written = (content: string) => shownOf(content.replace(/^\s*<([a-z_]+)>\n?[\s\S]*?\n?<\/\1>\s*/, ""));

/** The lines in a message that show the files sent with it. */
const filesIn = (content: string) => content.match(/!?\[[^\]\n]*\]\(file:[^)\s]+\)/g) ?? [];

/** The most files one turn takes, which is the runtime's own limit. */
const MOST = 4;
/** The largest file one turn takes, which is the runtime's own limit. */
const LARGEST = 10 << 20;
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

/** A file to send as it is, any kind. Its type is what the browser says, which the runtime checks against its bytes. */
async function asItIs(file: File): Promise<Held> {
  const url = await new Promise<string>((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(file);
  });
  return { name: file.name || "file", mediaType: file.type, data: url.slice(url.indexOf(",") + 1) };
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
/**
 * Scroll whatever holds `end` all the way down. Not `scrollIntoView`: that
 * stops with `end` at the bottom of the window, which on a phone leaves the
 * box you type into, stuck to the bottom below it, still to scroll past.
 */
function scrollToEnd(end: HTMLElement, behavior: ScrollBehavior = "auto"): void {
  for (let box = end.parentElement; box; box = box.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(box).overflowY)) continue;
    box.scrollTo({ top: box.scrollHeight, behavior });
    return;
  }
}

/** How many recent conversations are listed at first, and how many more each "Show more" adds. */
const RECENT_PAGE = 12;

const fromWeb = (one: Thread): boolean => threadName(one.thread).startsWith("visitor-");

/** Where a conversation is listed: under a group, pinned, or with null in Recents. */
type Section = number | "pinned" | null;

/**
 * One agent's conversations, and the one open. `owner` has the whole list of
 * models and its groups; somebody invited picks from the owner's short list when
 * there is one. With `readOnly` (the owner viewing as somebody), it can be read and
 * nothing else. `railTop` and `railFoot` go at the two ends of the list of conversations:
 * this page has no bar, so what the bar holds elsewhere is there.
 */
export function Chat({ agent, thread: asked, about, owner, readOnly, railTop, railFoot }: { agent: string; thread?: string; about?: string; owner: boolean; readOnly?: boolean; railTop?: ReactNode; railFoot?: ReactNode }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [listed, setListed] = useState(false);
  const [thread, setThread] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, showPrompt] = useState("");
  const [held, setHeld] = useState<Held[]>([]);
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
  // A conversation being dragged, the section it would land in (a group's id,
  // "pinned", or null for Recents), and the row in a sorted section it would go
  // in front of, with null for the end.
  const [dragged, setDragged] = useState<Thread | null>(null);
  const [over, setOver] = useState<Section | undefined>(undefined);
  const [line, setLine] = useState<{ section: Section; before: string | null } | null>(null);
  const [archived, setArchived] = useState(false);
  // How many of the recent conversations are listed: a page at a time.
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);
  const [width, setWidth] = useState(chatWidth);
  const [doing, setDoing] = useState<Step[]>([]);
  // When this page first saw each line of `doing`, which is what folds it away.
  const seen = useRef<number[]>([]);
  // The lines under "Thinking" that had folded away, opened again.
  const [showing, setShowing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [offered, setOffered] = useState<Offered[]>([]);
  // Words that narrow the list of conversations, and whether the box for them is open.
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
  const [sharing, setSharing] = useState<{ x: number; y: number } | null>(null);
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
    api.groups(agent).then(setGroups, () => {});
    // Which model the answer will come from, so it is known before anything is asked.
    api.agent(agent).then(
      (one) => {
        setSummary(one);
        setIdeas(ideasFor(one));
      },
      () => setSummary(null),
    );
    setOffered([]);
    api.models(agent).then(setOffered, () => {});
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
  // One this conversation has, or else the one this person last picked.
  const picked = summary?.chosen.find((one) => one.scope === `chat:${thread}`)?.model ?? summary?.mine;
  const model = picked === "auto" || (!picked && summary?.auto) ? "Auto" : modelName(picked ?? summary?.model ?? "");
  const short = shortChoices(offered, (one) => void pick(one), picked ?? summary?.model);
  const titled = (name: string) => summary?.titles?.[name] ?? words(name);
  /** Where a tool comes from, in words: the agent's own, built into the runtime, or a connection or channel it was given. */
  const sourceOf = (name: string): string | undefined => {
    const from = summary?.toolsFrom?.[name];
    if (from?.startsWith("abilities.")) return `built in: ${words(from.slice("abilities.".length))}`;
    if (from) return from.replace(/^(\S+) (.+)$/, "the $2 $1");
    return summary?.tools.includes(name) ? `${nameOf(agent)}'s own tool, in its folder` : undefined;
  };

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
    const back = asked || about || readOnly ? "" : lastChat(agent);
    if (back) {
      window.history.replaceState({ at: "chat", agent, thread: back }, "", href({ at: "chat", agent, thread: back }));
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    if (!readOnly) setLastChat(agent, asked ?? "");
    setThread(asked ?? freshThread(agent));
    setFile(about ?? "");
  }, [agent, asked, about]);

  /** Start again, leaving what was said, and anything written and not sent, where it is. */
  function newChat() {
    setHeld([]);
    setFile("");
    setThread(freshThread(agent));
    if (!readOnly) setLastChat(agent, "");
    go({ at: "chat", agent });
  }

  // The box is kept in this browser as it is written, so a reload or a closed
  // window loses nothing. Each conversation has its own. One nobody has said
  // anything in is kept under no name at all, because its id is made afresh on
  // every load. Viewing as somebody, the box is empty and nothing is kept.
  const typedIn = asked || lines.length ? thread : "";
  function setPrompt(words: string) {
    showPrompt(words);
    if (!readOnly) setTyped(agent, typedIn, words);
  }
  useEffect(() => {
    if (thread) showPrompt(readOnly ? "" : typed(agent, typedIn));
  }, [agent, thread, typedIn, readOnly]);

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
      (error) => {
        if (!live) return;
        setLines([]);
        // One asked for that is not to be had, like somebody else's left over as the last one open.
        if (thread === asked && error instanceof CallFailed && error.status === 404) newChat();
      },
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

  // Whether the end of the conversation is in sight. Watched against the
  // window, not the list, because on a phone it is the whole column that scrolls.
  const [atEnd, setAtEnd] = useState(true);
  const wasAtEnd = useRef(true);
  useEffect(() => {
    const end = foot.current;
    if (!end) return;
    const watching = new IntersectionObserver(([one]) => {
      wasAtEnd.current = one.isIntersecting;
      setAtEnd(one.isIntersecting);
    });
    watching.observe(end);
    return () => watching.disconnect();
  }, []);

  // A new line, a tool or the answer keeps the end in sight only for somebody
  // already there: whoever scrolled up to read stays where they are. Sending,
  // or opening a conversation, always goes to the end.
  const toEnd = useRef(true);
  useEffect(() => {
    toEnd.current = true;
  }, [thread]);
  useEffect(() => {
    if (!wasAtEnd.current && !toEnd.current) return;
    toEnd.current = false;
    if (foot.current) scrollToEnd(foot.current);
  }, [lines, waiting, doing.length]);

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

  /** Pasted, dropped or picked: files are held to go with the next message, a picture made smaller first. */
  async function hold(files: FileList | File[]) {
    const all = [...files];
    const fits = all.filter((file) => file.size <= LARGEST);
    const room = MOST - held.length;
    setTrouble(
      fits.length < all.length
        ? `A file can be ${LARGEST >> 20} MB at most.`
        : fits.length > room
          ? `${MOST} files at most, with one message.`
          : "",
    );
    try {
      const made = await Promise.all(fits.slice(0, Math.max(room, 0)).map((file) => (file.type.startsWith("image/") ? picture(file).catch(() => asItIs(file)) : asItIs(file))));
      setHeld((was) => [...was, ...made].slice(0, MOST));
    } catch {
      setTrouble("That file could not be read.");
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
      if (!picked) setPrompt("");
      newChat();
      return;
    }
    const link = file ? `${window.location.origin}${href({ at: "memory", agent, path: file })}` : "";
    const words = picked ?? [prompt.trim(), link].filter(Boolean).join("\n\n");
    const sending = picked ? [] : held;
    // Words typed while a reply is going join it: the agent reads them before
    // its next step and answers both. Pictures, a picked answer, an edit or a
    // /command wait for the reply to end.
    const steering = waiting && !picked && edit === undefined && !sending.length && !words.startsWith("/");
    if ((!words && !sending.length) || (waiting && !steering)) return;
    toEnd.current = true;
    if (!picked) {
      setPrompt("");
      setHeld([]);
      setFile("");
    }
    setTrouble("");
    const replaces = edit === undefined ? undefined : lines[edit]?.id;
    const shown = sending.flatMap((one) => (one.url ? [one.url] : []));
    const named = sending.flatMap((one) => (one.url ? [] : [one.name]));
    const mine: Line = { role: "user", content: words, at: new Date().toISOString(), pictures: shown.length ? shown : undefined, named: named.length ? named : undefined };
    setLines((said) => [...(edit === undefined ? said : said.slice(0, edit)), mine]);
    const to = thread;
    if (!steering) setWaitingOn((all) => new Map(all).set(to, Date.now()));
    asking.current.add(to);
    let joined = false;
    // An answer to a conversation no longer open is not shown here: opening it
    // again reads it back with the answer in it.
    const here = (line: Line) => open.current === to && setLines((said) => [...said, line]);
    try {
      const answer = await api.say(agent, words, to, sending.map(({ name, mediaType, data }) => ({ name, mediaType, data })), replaces);
      // Taken into the reply already going, which answers it.
      if (answer.joined) {
        joined = true;
        return;
      }
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
      if (!(error instanceof AnswerGone)) {
        here({ role: "assistant", content: (error as Error).message, failed: true });
        return;
      }
      // The runtime restarted. What was said is kept, and a reply it carried on
      // is followed as one started in another window is.
      asking.current.delete(to);
      const [said, runs] = await Promise.all([api.said(to), api.runs(10, agent)]).catch((): [Said[], { finished?: string | null; thread?: string | null }[]] => [[], []]);
      if (said.length && open.current === to) setLines(said);
      joined = runs.some((run) => !run.finished && run.thread === to);
    } finally {
      if (!joined) {
        asking.current.delete(to);
        done(to);
      }
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

  /** Lets anybody signed in here read this conversation by its link, or stops it, and copies the link once it is shared. */
  async function share(on: boolean) {
    try {
      const done = await api.shareThread(thread, on);
      changed(thread, { shared: done.shared });
      if (on) await copyLink(href({ at: "shared", thread }));
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  async function copyLink(path: string) {
    const link = window.location.origin + path;
    if (!(await copy(link))) setTrouble(`This browser would not let the page copy. The link is ${link}`);
  }

  async function fileUnder(one: string, group: number | null) {
    const done = await api.groupThread(one, group);
    changed(one, { group: done.group });
  }

  /** Gone for good, unlike archiving: what was said is deleted, and the agent no longer remembers it. */
  async function remove(one: Thread) {
    if (!window.confirm(`Delete "${one.label || called(one)}"? It is gone for good, and ${nameOf(agent)} will not remember it. Archive keeps it.`)) return;
    await api.forget(one.thread);
    setTyped(agent, one.thread, "");
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
    if (!window.confirm(`Delete the group "${group.name}"? Its conversations are kept, under Recents.`)) return;
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

  const looked = search.trim().toLowerCase();
  const shown = threads.filter((one) => (archived || !one.archived) && (!looked || (one.label ?? threadName(one.thread)).toLowerCase().includes(looked)));
  const pinnedOf = (from: Thread[]) => byPlace(from.filter((one) => one.pinned));
  const groupedOf = (from: Thread[], group: number) => byPlace(from.filter((one) => !one.pinned && one.group === group));
  const pinned = pinnedOf(shown);
  const grouped = (group: Group) => groupedOf(shown, group.id);
  const recent = shown.filter((one) => !one.pinned && !groups.some((group) => group.id === one.group));
  const hidden = threads.filter((one) => one.archived).length;
  const blank = lines.length === 0 && !waiting && !loading;
  const shared = Boolean(threads.find((one) => one.thread === thread)?.shared);
  // Nothing said yet in a conversation that is not in the list.
  const isNew = blank && !threads.some((one) => one.thread === thread);
  // What has been talked about, and only for an agent with nothing named yet, what it can do.
  const fromHistory = ideasFrom(threads, groups);
  // Each is about setting the agent up or about its jobs, which are the owner's.
  const suggested = !owner ? [] : fromHistory.length ? fromHistory : ideas;

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

  /** What is sorted by hand in a section, whatever the search leaves showing. Recents is by time, so it has none. */
  const sorted = (section: Section): Thread[] =>
    section === "pinned" ? pinnedOf(threads) : section === null ? [] : groupedOf(threads, section);

  /**
   * Puts the conversation being dragged where it was dropped: into the section,
   * and in a sorted one in front of `before`. Pinned and Recents take a pin on or
   * off, and a group takes it out of any other.
   */
  async function drop(section: Section, before: string | null) {
    const one = dragged;
    setOver(undefined);
    setLine(null);
    if (!one) return;
    const order = moved(sorted(section).map((each) => each.thread), one.thread, before);
    const same = sorted(section).map((each) => each.thread).join() === order.join();
    try {
      if ((section === "pinned") !== Boolean(one.pinned)) await pin(one, section === "pinned");
      if (section !== "pinned" && (one.group ?? null) !== section) await fileUnder(one.thread, section);
      if (section === null || same) return;
      setThreads((all) => all.map((each) => (order.includes(each.thread) ? { ...each, place: order.indexOf(each.thread) } : each)));
      await api.orderThreads(agent, order);
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  /** A whole section takes a drop: on a group's own row, on Pinned, or on Recents. On top of its first row, where it sorts. */
  const dropOn = (section: Section) => ({
    onDragOver: (event: DragEvent) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(section);
      setLine(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void drop(section, sorted(section)[0]?.thread ?? null);
    },
  });

  /** A row in a sorted section takes a drop above or below itself, by which half the pointer is on, and shows it with a line. */
  const dropBeside = (one: Thread, section: Section) => {
    const before = (event: DragEvent): string | null => {
      const { top, height } = event.currentTarget.getBoundingClientRect();
      if (event.clientY < top + height / 2) return one.thread;
      const list = sorted(section);
      return list[list.findIndex((each) => each.thread === one.thread) + 1]?.thread ?? null;
    };
    return {
      onDragOver: (event: DragEvent) => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(undefined);
        setLine({ section, before: before(event) });
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void drop(section, before(event));
      },
    };
  };

  /**
   * One conversation in the list beside, which opens it, with its menu, and can
   * be dragged. Under Pinned or a group, a line shows where it would land.
   */
  const row = (one: Thread, section: Section) => {
    const list = line?.section === section ? sorted(section) : [];
    const last = list.at(-1)?.thread === one.thread;
    return (
    <li
      key={one.thread}
      className={
        [
          menu?.one.thread === one.thread && "held",
          typeof section === "number" && "in-group",
          dragged?.thread === one.thread && "dragging",
          line?.section === section && line.before === one.thread && "line-before",
          line?.section === section && line.before === null && last && "line-after",
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      {...(section !== null && dropBeside(one, section))}
      draggable={!readOnly && naming !== one.thread && !looked}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", one.label || called(one));
        setDragged(one);
      }}
      onDragEnd={() => {
        setDragged(null);
        setOver(undefined);
        setLine(null);
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
            onDoubleClick={() => !readOnly && setNaming(one.thread)}
          >
            <span className={one.archived ? "headline dim" : "headline"}>{one.label || called(one)}</span>
            {fromWeb(one) && (
              <span className="num dim" title="A visitor, on a web page">
                web
              </span>
            )}
          </button>
          {!readOnly && (
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
          )}
        </Fragment>
      )}
    </li>
    );
  };

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
      <nav
        className="past rail"
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setOver(undefined);
          setLine(null);
        }}
      >
        <Collapse closeOn={thread} label="Past conversations">
          <div className="rail-top">
            {railTop}
            <button
              className="plain find"
              title="Search chats"
              aria-label="Search chats"
              aria-pressed={searching}
              onClick={() => {
                setSearching(!searching);
                setSearch("");
              }}
            >
              <Icons.Search />
            </button>
          </div>
          <button className="new-chat" aria-current={isNew} onClick={newChat}>
            <Icons.NewConversation />
            New chat
          </button>
          {searching && (
            <label className="search-chats">
              <Icons.Search />
              <input
                type="search"
                autoFocus
                placeholder="Search chats"
                aria-label="Search chats"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setSearching(false);
                  setSearch("");
                }}
              />
            </label>
          )}

        {!listed && (
          <>
            <h2>Recents</h2>
            <Loading />
          </>
        )}
        {listed && (
          <div className={over === "pinned" ? "recent over" : "recent"} {...dropOn("pinned")}>
            <h2>Pinned</h2>
            {pinned.length > 0 ? <ul className="run-list">{pinned.map((one) => row(one, "pinned"))}</ul> : <p className="empty">No pinned chats</p>}
          </div>
        )}
        {listed && (
          <>
            <h2 className="adds">
              Groups
              {!readOnly && (
                <button className="plain add" title="New group" aria-label="New group" onClick={() => setNamingGroup("new")}>
                  <Icons.Plus />
                </button>
              )}
            </h2>
            <ul className="run-list">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <li
                    className={["group", groupMenu?.group.id === group.id && "held", over === group.id && "over"].filter(Boolean).join(" ")}
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
                          onDoubleClick={() => !readOnly && setNamingGroup(group.id)}
                        >
                          {shut.has(group.id) ? <Icons.Folder /> : <Icons.FolderOpen />}
                          <span className="headline">{group.name}</span>
                        </button>
                        {!readOnly && (
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
                        )}
                      </Fragment>
                    )}
                  </li>
                  {!shut.has(group.id) && grouped(group).map((one) => row(one, group.id))}
                </Fragment>
              ))}
              {namingGroup === "new" && <li>{groupName("")}</li>}
            </ul>
            {!groups.length && namingGroup !== "new" && <p className="empty">No groups</p>}
          </>
        )}
        {listed && recent.length > 0 && (
          <div className={over === null ? "recent over" : "recent"} {...dropOn(null)}>
            <h2>Recents</h2>
            <ul className="run-list">{recent.slice(0, recentShown).map((one) => row(one, null))}</ul>
            {recent.length > recentShown && (
              <button className="plain show-more" onClick={() => setRecentShown(recentShown + RECENT_PAGE)}>
                Show more
              </button>
            )}
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
              ...([
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
                  ] as Choice[]),
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
        {railFoot && <div className="rail-foot">{railFoot}</div>}
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
            (!readOnly && (owner || short.length) ? (
              <button
                className="model"
                title={picked ?? summary?.model}
                aria-haspopup="menu"
                aria-expanded={Boolean(picking)}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setPicking(picking ? null : { x: box.left, y: box.bottom + 4 });
                }}
              >
                {model}
                <Icons.Down />
              </button>
            ) : (
              <span className="model">{model}</span>
            ))}
          {picking && summary && (
            <ContextMenu
              at={picking}
              from="left"
              close={() => setPicking(null)}
              search={short.length ? undefined : "Search models"}
              choices={short.length ? short : [
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
          {/* Only once the address names the conversation, which is when a link to it opens it. */}
          {asked === thread && !blank && (
            <div className="ways">
              <CopyButton text={window.location.origin + href({ at: "chat", agent, thread })} label="Copy link" icon={<Icons.Link />} />
              {!readOnly && (
                <button
                  className="plain act share"
                  aria-haspopup="menu"
                  aria-expanded={Boolean(sharing)}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setSharing(sharing ? null : { x: box.right, y: box.bottom + 4 });
                  }}
                >
                  <Icons.Share />
                  {shared ? "Shared" : "Share"}
                </button>
              )}
            </div>
          )}
          {sharing && (
            <ContextMenu
              at={sharing}
              from="right"
              close={() => setSharing(null)}
              choices={[
                { head: "Anyone signed in can read it" },
                // On a phone the copy button is not beside it, for room.
                ...(window.matchMedia("(max-width: 860px)").matches
                  ? [{ label: "Copy link to this chat", icon: <Icons.Link />, run: () => void copyLink(href({ at: "chat", agent, thread })) }]
                  : []),
                ...(shared
                  ? [
                      { label: "Copy share link", icon: <Icons.Copy />, run: () => void copyLink(href({ at: "shared", thread })) },
                      { label: "Stop sharing", icon: <Icons.Close />, run: () => void share(false) },
                    ]
                  : [{ label: "Share and copy link", icon: <Icons.Share />, run: () => void share(true) }]),
              ]}
            />
          )}
        </div>

        <div className="scroll">
          {blank ? (
            <div className="hello">
              <h2>What's on the agenda today?</h2>
            </div>
          ) : null}
          <div className="thread run-thread">
            {loading && <Loading />}
            {lines.map((line, at) =>
              line.role === "user" ? (
                <Fragment key={at}>
                  {line.at && <p className="said-at num">{saidAt(line.at)}</p>}
                  {filesIn(line.content).length > 0 ? (
                    <div className="msg you pictures">{rich(filesIn(line.content).join(" "))}</div>
                  ) : (
                    (line.pictures || line.named) && (
                      <div className="msg you pictures">
                        {line.pictures?.map((url, n) => (
                          <img key={n} src={url} alt="" />
                        ))}
                        {line.named?.map((name, n) => (
                          <span key={`f${n}`} className="file-card">
                            <span className="kind">File</span>
                            <span className="name">{name}</span>
                          </span>
                        ))}
                      </div>
                    )
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
                    (written(line.content) || !(line.pictures || line.named || filesIn(line.content).length)) && (
                      <Prompt
                        whole
                        prompt={shownOf(line.content)}
                        visitor={thread.includes("/visitor-") ? { agent, id: thread.slice(thread.indexOf("/visitor-") + 9) } : undefined}
                        actions={
                          <>
                            <CopyButton text={written(line.content)} label="Copy message" />
                            {line.id !== undefined && !waiting && !readOnly && !thread.includes("/visitor-") && (
                              <button
                                className="plain act"
                                data-tip="Edit message"
                                aria-label="Edit message"
                                onClick={() => {
                                  setDraft(written(line.content));
                                  setEditing(at);
                                }}
                              >
                                <Icons.Edit />
                              </button>
                            )}
                          </>
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
                <Fragment key={at}>
                  {line.at && lines[at - 1]?.role !== "user" && <p className="said-at num">{saidAt(line.at)}</p>}
                  <div className={line.failed ? "msg them bad" : "msg them"} id={`said-${at}`}>
                    {line.run && line.did && <Steps run={line.run} did={line.did} titled={titled} sourceOf={sourceOf} />}
                    <div className="said">
                      <Markdown text={line.content} />
                    </div>
                    {line.buttons && at === lines.length - 1 && (
                      <Pick options={line.buttons} multiple={line.multiple} disabled={waiting || readOnly} pick={(text) => void send(text)} />
                    )}
                    <div className="meta num">
                      <CopyButton text={withoutFiles(line.content)} label="Copy response" />
                      {line.id !== undefined && !readOnly && (
                        <button className="plain act" data-tip="Fork into a new chat" aria-label="Fork into a new chat" onClick={() => void fork(line)}>
                          <Icons.Branch />
                        </button>
                      )}
                      {[nameOf(agent), line.at && when(line.at), line.cost !== undefined && (line.unpriced ? spent(line.cost, line.unpriced) : money(line.cost))].filter(Boolean).join(", ")}
                    </div>
                  </div>
                </Fragment>
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
                        <Card name={titled(step.tool ?? step.name ?? "")} step={step} from={step.tool ? sourceOf(step.tool) : undefined} />
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
              onClick={() => foot.current && scrollToEnd(foot.current, "smooth")}
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
            {held.length > 0 && (
              <div className="pictures">
                {held.map((one, n) => (
                  <button
                    key={n}
                    className={one.url ? "plain" : "plain held-file"}
                    title={`Take ${one.name} off`}
                    onClick={() => setHeld((was) => was.filter((_, at) => at !== n))}
                  >
                    {one.url ? (
                      <img src={one.url} alt={one.name} />
                    ) : (
                      <>
                        <Icons.File />
                        {one.name}
                      </>
                    )}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={box}
              rows={1}
              value={prompt}
              placeholder={readOnly ? "Read only, while viewing as them" : `Ask ${nameOf(agent)}`}
              disabled={readOnly}
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
              <label className="attach" title="Add files" aria-label="Add files" hidden={readOnly}>
                <Icons.Plus />
                <input
                  type="file"
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
                disabled={readOnly || (waiting && (held.length > 0 || prompt.trim().startsWith("/"))) || (!prompt.trim() && !held.length && !file)}
              >
                <Icons.Send />
              </button>
            </div>
          </div>
          {trouble && <p className="under">{trouble}</p>}
          {blank && !prompt && suggested.length > 0 && (
            <div className="ideas">
              <p>Try the following:</p>
              {suggested.map((idea) => (
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

/** What a reply's steps came to, in a line: "6 tool calls, 1 failed". */
function didLine(did: NonNullable<Said["did"]>): string {
  const calls = did.read + did.changed + did.ran + did.other + did.failed;
  return [many(calls, "tool call"), did.failed && `${did.failed} failed`].filter(Boolean).join(", ");
}

/** The steps behind a reply, folded into a grey line above it, read from its run when opened. */
function Steps({
  run,
  did,
  titled,
  sourceOf,
}: {
  run: string;
  did: NonNullable<Said["did"]>;
  titled: (name: string) => string;
  sourceOf: (name: string) => string | undefined;
}) {
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
              <div>{step.tool ?? step.name ? (
                  <Card name={titled(step.tool ?? step.name ?? "")} step={step} from={step.tool ? sourceOf(step.tool) : undefined} />
                ) : (
                  <p className="thought">{step.say}</p>
                )}</div>
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

