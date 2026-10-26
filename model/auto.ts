// Auto: before a reply, the quick model reads the message and says whether
// the agent's own model is needed. The reply then runs on the one it said.

import { db } from "#chloe/core/db";
import type { Agent } from "#chloe/load/load";

import { recall } from "./memory.ts";
import { ask, quickFor } from "./model.ts";

const ASKED =
  "You decide which model answers the newest message to an AI agent. " +
  "Answer quick when a small, fast model will do it as well: a greeting, thanks, a short answer, a simple question or a lookup. " +
  "Answer strong when it needs care: reasoning over several steps, writing that matters, code, a plan, a judgement, " +
  "a mistake that would cost something, or anything you are unsure of. " +
  "Reply with one line: quick or strong, a colon, and the reason in under twelve words.";

/** How long a conversation that went to the agent's own model stays there, in milliseconds. */
const STAYS = 60 * 60_000;

/** How many earlier messages of the conversation the quick model is shown. */
const SHOWN = 6;

/** The model a reply goes to, and the line the run's record shows for it. */
export interface Decided {
  model: string;
  /** Which model, and why, in words. */
  why: string;
  /** What asking the quick model cost, when it was asked and the route priced it. */
  cost?: number;
  /** Set when the quick model was asked and its answer came with no price. */
  unpriced?: boolean;
}

/**
 * Which model answers `prompt` for `agent` on Auto: the quick model, or the
 * agent's own. Its own when there is no quick model, when the conversation
 * went to it within the hour, and when the quick model fails or answers in
 * words that cannot be read. Throws only when `signal` stopped it.
 */
export async function decide(agent: Agent, prompt: string, thread?: string, signal?: AbortSignal): Promise<Decided> {
  const own = agent.model;
  const quick = quickFor(own);
  if (!quick) return { model: own, why: `Auto: ${own}, as there is no quick model to hand it to.` };
  if (thread && wentTo(thread, own)) return { model: own, why: `Auto: ${own}, as this conversation went to it within the hour.` };

  const earlier = thread ? recall(thread, { limit: SHOWN }) : [];
  const conversation = [
    ...earlier.map((one) => `${one.role === "user" ? "They said" : "The agent said"}: ${one.content.slice(0, 1000)}`),
    `The newest message: ${prompt.slice(0, 4000)}`,
  ].join("\n\n");
  try {
    const answer = await ask({
      model: quick,
      messages: [
        { role: "system", content: ASKED },
        { role: "user", content: conversation },
      ],
      maxOutputTokens: 60,
      signal,
    });
    const priced = answer.cost === undefined ? { unpriced: true } : { cost: answer.cost };
    const said = answer.text.trim().match(/^\W*(quick|strong)\b\W*(.*)/i);
    if (!said) return { model: own, why: `Auto: ${own}, as the quick model's answer could not be read.`, ...priced };
    const model = said[1].toLowerCase() === "quick" ? quick : own;
    const reason = said[2].split("\n")[0].trim();
    return { model, why: `Auto: ${model}${reason ? `, ${reason}` : ""}`, ...priced };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { model: own, why: `Auto: ${own}, as the quick model failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Whether a reply in `thread` went to `model` within the hour. */
function wentTo(thread: string, model: string): boolean {
  const since = new Date(Date.now() - STAYS).toISOString();
  return Boolean(db.prepare("select 1 from runs where thread = ? and model = ? and started > ? limit 1").get(thread, model, since));
}
