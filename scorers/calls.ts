// Which tools a run had to use, and which it must never touch.
//
// A judge reads what an agent said. This reads what it did, and it does not
// ask a model: emailing on a quiet morning, or restarting the same service
// twice, are facts about the run, and a fact is worth checking exactly rather
// than asking a second model whether it happened.
//
// What to expect arrives with the run, from the eval case, so this file names
// no agent and no tool.
import type { Result } from "#chloe/core/turn";

/**
 * The tools a run should use, must not use, and may use only once. Each list
 * holds tool names, as the model calls them. Imported as `ExpectedCalls`.
 */
export interface Expected {
  /** Tools the run must call at least once. */
  mustCall?: string[];
  /** Tools the run must never call. */
  mustNotCall?: string[];
  /** Tools the run may call, but no more than once. Useful for a tool that should not run twice, such as a restart. */
  atMostOnce?: string[];
}

/** A score from 0 to 1, and the reason for it. */
export interface Mark {
  /** From 0 (failed) to 1 (passed). */
  score: number;
  /** Why the run got this score, in words. */
  reason: string;
}

/**
 * Scores a run on the tools it called, against `expected`. It only counts
 * the calls and asks no model, so it is free and gives the same answer every
 * time.
 *
 * The score is 1 if every rule is kept, and 0 if any rule is broken. The
 * reason lists what went wrong and every tool the run used.
 */
export function calls(result: Result, expected: Expected): Mark {
  const used = result.calls.map((c) => c.toolName);
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
