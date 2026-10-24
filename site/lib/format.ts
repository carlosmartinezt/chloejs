// What the page calls things: money, dates, an agent's colour and label, and
// what state a run is in. No fetching and no React.
import type { ParkedRun, RunRow } from "./types.ts";

export const money = (n: number | null | undefined) => `$${Number(n ?? 0).toFixed(4)}`;
/** What a run or a step spent: "free", "$0.0004", or "unknown" and "at least $0.0004" when some of its answers came with no price. */
export const spent = (cost: number | null | undefined, unpriced?: number | boolean) =>
  unpriced ? (cost ? `at least ${money(cost)}` : "unknown") : cost ? money(cost) : "free";

/** How long ago, for a page somebody reads in the morning. */
export const ago = (iso: string | null): string => {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 7) return `${Math.round(seconds / 86_400)}d ago`;
  return when(iso);
};

/** Several picked answers as one message: joined with commas, or as a JSON list when one holds a comma. */
export const together = (picked: string[]): string => (picked.some((one) => one.includes(",")) ? JSON.stringify(picked) : picked.join(", "));

/** What the page calls an agent: its name if it has one, or its id. */
const names = new Map<string, string>();

export function shareNames(agents: { id: string; name?: string }[]): void {
  names.clear();
  for (const one of agents) if (one.name) names.set(one.id, one.name);
}

export const nameOf = (id: string): string => names.get(id) ?? id;

/**
 * What a file is, for the tree. Markdown is words an agent reads, .ts is code
 * that runs, a script is something it shells out to, and a test is code about
 * code.
 */
export function kindOf(name: string): string {
  if (name.endsWith(".md")) return "words";
  if (name.endsWith(".test.ts")) return "proof";
  if (/\.(ts|tsx|js)$/.test(name)) return "code";
  if (/\.(sh|py|rb)$/.test(name)) return "script";
  return "plain";
}

/**
 * What to call a conversation. A channel's thread is "<agent>/telegram-111111111",
 * and the long number is a chat id nobody reads, so it keeps its last four.
 * After a `/clear` the chat's new one has more after the number.
 */
export function threadName(thread: string): string {
  const own = thread.slice(thread.indexOf("/") + 1);
  return own.replace(/-(\d{5,})(?=-|$)/, (_, digits: string) => `-${digits.slice(-4)}`);
}

/** A name written run together, like "memoryReadFile", in words: "Memory read file". */
export function words(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "1 skill", "2 skills". */
export const many = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What one agent's dot says. Only the four things worth a colour: nothing to
 * report is no dot at all, which is most mornings.
 */
export type State = "busy" | "wait" | "bad" | "ok" | "";

/** What each one means, in the words the page puts beside the dot. */
export const saidState: Record<Exclude<State, "">, string> = {
  busy: "running now",
  wait: "waiting on you",
  bad: "a run failed today",
  ok: "all clean",
};

export function stateOf(
  agent: string,
  { runs, parked, running }: { runs: RunRow[]; parked: ParkedRun[]; running: string[] },
): State {
  if (running.some((key) => key.startsWith(`${agent}/`))) return "busy";
  if (parked.some((one) => one.agent === agent)) return "wait";
  const mine = runs.filter((run) => run.agent === agent);
  if (mine.length === 0) return "";
  // A failure earlier today still matters at breakfast, so the dot does not go
  // green again just because the next quarter-hourly check passed.
  const aDayAgo = Date.now() - 86_400_000;
  return mine.some((run) => run.error && new Date(run.started).getTime() > aDayAgo) ? "bad" : "ok";
}

/**
 * Every time on this page is shown in one zone, whatever the browser's own is.
 * A run happened at one moment, and reading it from a laptop in another country
 * should not move it.
 */
export const ZONE = "America/New_York";

/** Which day it was, where the box is, so a date filter means that day there. */
export const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: ZONE });

/** The exact moment, to the second. */
export const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        timeZone: ZONE,
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    : "";

/** The time of day alone, to the second, for moments inside one run. */
export const clock = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-GB", {
        timeZone: ZONE,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    : "";

export const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
