// The last few messages of one thread, and nothing kept between threads. The
// one summary is what /compact writes when somebody asks for it: a turn is
// then shown that and what came after. What an agent should remember across
// runs it writes into its own folder, where it can be read and corrected.
import { db } from "#chloe/core/db";
import type { Message } from "./model.ts";
import type { Call } from "./tool.ts";

/** How many messages of a conversation a turn is shown, when the agent does not say. */
export const RECALL = 10;

/** A call as a thread keeps it: which tool, and what it was called with. */
interface Used {
  tool: string;
  args: unknown;
}

/** Long strings in a call's arguments, like a whole file being written, are cut. */
function clipArgs(args: unknown): unknown {
  if (typeof args === "string") return args.length > 300 ? `${args.slice(0, 300)}...` : args;
  if (Array.isArray(args)) return args.map(clipArgs);
  if (args && typeof args === "object") return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, clipArgs(v)]));
  return args;
}

/** `used` is the tools a reply called, kept so a later turn can see how the reply was reached. */
export function remember(thread: string, role: "user" | "assistant", content: string, used: Pick<Call, "toolName" | "input">[] = []): void {
  if (!content) return;
  db.prepare("insert into messages (thread, role, content, at, used) values (?, ?, ?, ?, ?)").run(
    thread,
    role,
    content,
    new Date().toISOString(),
    used.length ? JSON.stringify(used.map((one): Used => ({ tool: one.toolName, args: clipArgs(one.input) }))) : null,
  );
}

/** What a summary is shown to a model as, before its words. */
export const SUMMARY_HEAD = "A summary of our conversation before this point:";

/** The id of the latest summary in a thread, or 0 when it has none. */
export function lastSummary(thread: string): number {
  return (db.prepare("select max(id) as id from messages where thread = ? and summary = 1").get(thread) as { id: number | null }).id ?? 0;
}

/**
 * The last `limit` messages of a thread, oldest first, leaving out any older
 * than `days` when it is given. Nothing is deleted: a message too old to be
 * recalled is still in the database and still on the page. A thread that was
 * compacted is recalled from its latest summary, which is always shown first,
 * however many came after it.
 *
 * With `tools`, a reply that called tools is preceded by those calls, in the
 * same shape a turn's own calls take, with results that were not kept.
 * Without them a model reading its own earlier answer cannot tell a fact it
 * looked up from one it made up.
 */
export function recall(thread: string, { limit = RECALL, days, tools = false }: { limit?: number; days?: number; tools?: boolean } = {}): Message[] {
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
  const from = lastSummary(thread);
  const rows = db
    .prepare("select id, role, content, used from messages where thread = ? and id > ? and at >= ? order by id desc limit ?")
    .all(thread, from, since, limit) as { id: number; role: string; content: string; used: string | null }[];
  const summary = from ? (db.prepare("select content from messages where id = ?").get(from) as { content: string }) : undefined;
  const head: Message[] = summary ? [{ role: "assistant", content: `${SUMMARY_HEAD}\n\n${summary.content}` }] : [];
  return head.concat(rows.reverse().flatMap((r): Message[] => {
    const said: Message = { role: r.role as Message["role"], content: r.content };
    if (!tools || !r.used) return [said];
    const calls = (JSON.parse(r.used) as Used[]).map((one, i) => ({
      id: `recalled-${r.id}-${i}`,
      type: "function" as const,
      function: { name: one.tool, arguments: JSON.stringify(one.args ?? {}) },
    }));
    return [
      { role: "assistant", content: "", tool_calls: calls },
      ...calls.map((call) => ({ role: "tool" as const, tool_call_id: call.id, content: "(done; the result was not kept)" })),
      said,
    ];
  }));
}

/**
 * Forgets a conversation: its messages, and the words in the runs it had, so
 * the log keeps only that a run happened and what it cost.
 */
export function forget(thread: string): void {
  db.prepare("delete from messages where thread = ?").run(thread);
  db.prepare("update runs set prompt = '', asked = null, reply = null, summary = null, context = null, trace = '[]' where thread = ?").run(thread);
  // One with an owner keeps it, so nobody else can take up its id.
  db.prepare("delete from threads where thread = ? and owner is null").run(thread);
  db.prepare("update threads set label = null, archived = null, pinned = null, group_id = null where thread = ?").run(thread);
}

/**
 * Starts conversation `to` as a copy of `thread` up to and including message
 * `through`, each message with the time it was said and the tools it used.
 * The two then go their own ways. Returns how many messages were copied: none
 * when `through` is not in `thread`.
 */
export function branch(thread: string, through: number, to: string): number {
  if (!db.prepare("select 1 from messages where thread = ? and id = ?").get(thread, through)) return 0;
  return Number(
    db
      .prepare("insert into messages (thread, role, content, at, used) select ?, role, content, at, used from messages where thread = ? and id <= ? order by id")
      .run(to, thread, through).changes,
  );
}

/**
 * Takes back message `from` of `thread` and every one after it, so the
 * conversation goes on from before it, as when somebody changes what they
 * wrote. The runs keep what was said in them, as the log. Returns how many
 * messages went.
 */
export function cut(thread: string, from: number): number {
  return Number(db.prepare("delete from messages where thread = ? and id >= ?").run(thread, from).changes);
}

/** The conversation a channel's chat is in now: the id the channel gives it, until `/clear` moves it on. */
export function current(thread: string): string {
  const row = db.prepare("select now from cleared where thread = ?").get(thread) as { now: string } | undefined;
  return row?.now ?? thread;
}

/**
 * Moves a channel's chat on to a new conversation and returns its id. The old
 * one is kept, with everything said in it, and stays on the page. Takes the
 * id the channel gives the chat or the one it is in now.
 */
export function startAgain(thread: string): string {
  const first = (db.prepare("select thread from cleared where now = ?").get(thread) as { thread: string } | undefined)?.thread ?? thread;
  const now = `${first}-${Date.now().toString(36)}`;
  db.prepare("insert into cleared (thread, now) values (?, ?) on conflict (thread) do update set now = excluded.now").run(first, now);
  return now;
}
