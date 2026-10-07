// What the page calls things: money, dates, an agent's colour and label, and
// what state a run is in. No fetching and no React.
import type { ParkedRun, RunRow } from "./types.ts";

export const money = (n: number | null | undefined) => `$${Number(n ?? 0).toFixed(4)}`;

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

/** What the page calls an agent: its label if it has one, or its id. */
const labels = new Map<string, string>();

export function shareLabels(agents: { id: string; label?: string }[]): void {
  labels.clear();
  for (const one of agents) if (one.label) labels.set(one.id, one.label);
}

export const labelOf = (id: string): string => labels.get(id) ?? id;

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
 */
export function threadName(thread: string): string {
  const own = thread.slice(thread.indexOf("/") + 1);
  return own.replace(/-(\d{5,})$/, (_, digits: string) => `-${digits.slice(-4)}`);
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

/** One or two letters for an account's square, out of the name, or out of what comes before the @. */
export function initials(called: string): string {
  const parts = called.split(/[\s.\-_+]/).filter(Boolean);
  if (!parts.length) return called.slice(0, 1).toUpperCase();
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
