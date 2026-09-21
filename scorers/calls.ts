// Which tools a run had to use, and which it must never touch.
//
// A judge reads what an agent said. This reads what it did, and it does not
// ask a model: emailing on a quiet morning, or restarting the same service
// twice, are facts about the run, and a fact is worth checking exactly rather
// than asking a second model whether it happened.
//
// What to expect arrives with the run, from the eval case, so this file names
// no agent and no tool.
import type { Result } from "#chloe/core/turn.ts";

/**
 * Which tools a run should have used, must not have used, and may use only
 * once.
 */
export interface Expected {
  mustCall?: string[];
  mustNotCall?: string[];
  /** Tools it may use, but only once in a run. Restarting twice is why this exists. */
  atMostOnce?: string[];
}

/** A score between zero and one, and why it came out that way. */
export interface Mark {
  score: number;
  reason: string;
}

/** Marks a run on the tools it used, which is arithmetic and asks nobody. */
export function calls(result: Result, expected: Expected): Mark {
  const used = result.calls.map((c) => c.tool);
  const times = (tool: string) => used.filter((name) => name === tool).length;

  const missing = (expected.mustCall ?? []).filter((tool) => !used.includes(tool));
  const forbidden = (expected.mustNotCall ?? []).filter((tool) => used.includes(tool));
  const repeated = (expected.atMostOnce ?? []).filter((tool) => times(tool) > 1);

  const parts: string[] = [];
  if (missing.length) parts.push(`never called ${missing.join(", ")}`);
  if (forbidden.length) parts.push(`called ${forbidden.join(", ")}, which it must not`);
  if (repeated.length) parts.push(`called ${repeated.join(", ")} more than once in one run`);

  return {
    score: parts.length === 0 ? 1 : 0,
    reason:
      parts.length === 0
        ? `Used: ${used.join(", ") || "nothing"}.`
        : `${parts.join("; ")}. Used: ${used.join(", ") || "nothing"}.`,
  };
}
