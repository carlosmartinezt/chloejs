// The last few messages of one thread, and nothing else: no summarising and
// nothing kept between threads. What an agent should remember across runs it
// writes into its own folder, where it can be read and corrected.
import { db } from "#chloe/core/db.ts";
import type { Message } from "./model.ts";

const RECALL = 10;

export interface Used {
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
export function remember(thread: string, role: "user" | "assistant", content: string, used: Used[] = []): void {
  if (!content) return;
  db.prepare("insert into messages (thread, role, content, at, used) values (?, ?, ?, ?, ?)").run(
    thread,
    role,
    content,
    new Date().toISOString(),
    used.length ? JSON.stringify(used.map((one) => ({ tool: one.tool, args: clipArgs(one.args) }))) : null,
  );
}

/**
 * The last few messages of a thread, oldest first. With `tools`, a reply that
 * called tools is preceded by those calls, in the same shape a turn's own
 * calls take, with results that were not kept. Without them a model reading
 * its own earlier answer cannot tell a fact it looked up from one it made up.
 */
export function recall(thread: string, limit = RECALL, { tools = false } = {}): Message[] {
  const rows = db
    .prepare("select id, role, content, used from messages where thread = ? order by id desc limit ?")
    .all(thread, limit) as { id: number; role: string; content: string; used: string | null }[];
  return rows.reverse().flatMap((r): Message[] => {
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
  });
}

export function forget(thread: string): void {
  db.prepare("delete from messages where thread = ?").run(thread);
}
