// /compact: a conversation's summary so far, written by a small model, so a
// long conversation carries on from what mattered in it rather than from only
// its last few messages.

import { randomUUID } from "node:crypto";

import { db } from "#chloe/core/db";
import type { Agent } from "#chloe/load/load";

import { lastSummary, SUMMARY_HEAD } from "./memory.ts";
import { ask, quickFor } from "./model.ts";

const ASKED =
  "Summarise this conversation for whoever carries it on, who will see nothing else of it. Keep what was asked, what was " +
  "decided or done, the names, numbers, dates and links that matter, and what is still open or waiting on somebody. " +
  "Short plain lines, under 300 words. Only what the conversation says: add nothing, and leave out greetings and thanks.";

/** Fewer messages than this since the last summary is not worth a summary. */
const FEWEST = 4;
/** The most of a conversation handed over, in characters, newest kept. */
const MOST = 60_000;

/**
 * Writes a summary of `thread` as a message of its own, marked as one, with
 * `agent`'s quick model, or its own when it has none. Its last summary and
 * what came after are what is summed up. A run is kept for it, under the job
 * name "compact", with what it cost. Returns what to say back.
 */
export async function compact(agent: Agent, thread: string, source: string, owner?: string): Promise<{ text: string; cost: number; unpriced: number }> {
  const from = lastSummary(thread);
  const rows = db
    .prepare("select id, role, content from messages where thread = ? and id >= ? order by id")
    .all(thread, from) as { id: number; role: string; content: string }[];
  if (rows.length - (from ? 1 : 0) < FEWEST) return { text: "There is not enough in this conversation to compact yet.", cost: 0, unpriced: 0 };

  let words = rows
    .map((row) => (row.id === from ? `${SUMMARY_HEAD}\n${row.content}` : `${row.role === "user" ? "Person" : agent.name}: ${row.content}`))
    .join("\n\n");
  if (words.length > MOST) words = `(earlier messages left out)\n\n${words.slice(-MOST)}`;

  const model = quickFor(agent.model) ?? agent.model;
  const id = randomUUID();
  const started = new Date().toISOString();
  db.prepare("insert into runs (id, agent, started, source, job, model, prompt, kind, owner, thread) values (?, ?, ?, ?, 'compact', ?, '/compact', 'turn', ?, ?)").run(
    id,
    agent.id,
    started,
    source,
    model,
    owner ?? null,
    thread,
  );
  try {
    const answer = await ask({
      model,
      messages: [
        { role: "system", content: ASKED },
        { role: "user", content: words },
      ],
      maxOutputTokens: 1200,
    });
    const summary = answer.text.trim();
    if (!summary) throw new Error(`${model} wrote no summary.`);
    const cost = answer.cost ?? 0;
    const unpriced = answer.cost === undefined ? 1 : 0;
    db.prepare("insert into messages (thread, role, content, at, summary) values (?, 'assistant', ?, ?, 1)").run(thread, summary, new Date().toISOString());
    db.prepare("update runs set finished = ?, reply = ?, summary = ?, steps = 1, cost = ?, unpriced = ? where id = ?").run(
      new Date().toISOString(),
      summary,
      `Compacted ${rows.length} messages`,
      cost,
      unpriced,
      id,
    );
    return { text: `Compacted ${rows.length} messages. ${agent.name} carries on from the summary and what comes after it.`, cost, unpriced };
  } catch (error) {
    db.prepare("update runs set finished = ?, error = ?, steps = 1 where id = ?").run(new Date().toISOString(), (error as Error).message, id);
    return { text: `Could not compact: ${(error as Error).message}`, cost: 0, unpriced: 0 };
  }
}
