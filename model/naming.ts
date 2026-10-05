// A conversation started on the page is named by a small model from the first
// thing said in it, so the list says what each is about and not only when.

import { db } from "#chloe/core/db";
import { settings } from "#chloe/core/settings";

import { ask } from "./model.ts";

const ASKED =
  "Name this conversation in two to five plain words, from the first thing somebody said in it. " +
  "Reply with the name alone: no quotes and no full stop.";

/**
 * Names the conversation from `prompt`, unless somebody named it first. Never
 * throws: one that could not be named is called by when it last moved, as
 * before, and the reason is in the log.
 */
export async function nameThread(thread: string, prompt: string): Promise<void> {
  const model = settings.model.naming;
  if (!model) return;
  try {
    const { text } = await ask({
      model,
      messages: [
        { role: "system", content: ASKED },
        { role: "user", content: prompt.slice(0, 2000) },
      ],
      maxOutputTokens: 30,
      signal: AbortSignal.timeout(30_000),
    });
    const name = (text.trim().split("\n")[0] ?? "").replace(/^["'\u201c\u201d]+|["'\u201c\u201d.]+$/g, "").trim().slice(0, 80);
    if (!name) return;
    db.prepare("insert into threads (thread, label) values (?, ?) on conflict (thread) do update set label = coalesce(threads.label, excluded.label)").run(
      thread,
      name,
    );
  } catch (error) {
    console.error(`naming ${thread} failed`, error);
  }
}
