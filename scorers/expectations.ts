// Judging one run against what a person said a good run looks like.
//
// The expectations are not in this file. They arrive with the run, from the
// eval case, so one judge covers every agent and every job: the file that says
// what good means is the eval file, which is JSON a person can read and change
// without touching code.
import { ask, type Message } from "#chloe/model/model";
import type { Result } from "#chloe/core/turn";
import type { Mark } from "./calls.ts";

/**
 * The situation a case sets up, and what the agent should and should not have
 * done about it.
 */
export interface Expected {
  situation?: string;
  should?: string[];
  shouldNot?: string[];
}

const JUDGE = `You grade one run of an agent against expectations written by the person who owns it.
Grade only what is written. Do not invent standards, do not reward extra work nobody asked for, and
do not excuse a miss because the run was otherwise good. An expectation about what the agent said is
met only if it actually said it. An expectation about what it did is met only if the tool calls show
it. When you are not sure, it is not met, and say what you would have needed to see. An
expectation that says what it should not do is met when it did not do it.

Answer with JSON and nothing else, in this shape:
{"checks":[{"expectation":"the line, copied back whole","met":true,"why":"one sentence, quoting the run where you can"}]}
One check per expectation, in the order they are given.`;

/**
 * Marks what a run said against what it should have said, by asking a model to
 * judge it. `instructions` are the agent's own, shown to the judge as what it
 * was told, so an expectation like "invents nothing the CV does not say" can be
 * judged when the CV is in them.
 */
export async function expectations(
  prompt: string,
  result: Result,
  expected: Expected,
  model: string,
  instructions?: string,
): Promise<Mark> {
  const lines = [
    ...(expected.should ?? []).map((s) => `It should: ${s}`),
    ...(expected.shouldNot ?? []).map((s) => `It should not: ${s}`),
  ];
  if (lines.length === 0) return { score: 1, reason: "Nothing was expected." };

  const did = result.calls.map((c) => ({
    toolName: c.toolName,
    input: c.input,
    // A tool result is often the whole site list or the whole disk table. The
    // judge needs to know what came back, not to re-read all of it.
    output: JSON.stringify(c.output ?? "").slice(0, 2000),
  }));

  const messages: Message[] = [
    { role: "system", content: JUDGE },
    {
      role: "user",
        content: `An agent was asked to do a job. Here is what it was told, what was true at the
time, what it said, and what it did. Grade it against the expectations below.
${instructions ? `\nITS INSTRUCTIONS\n${instructions}\n` : ""}
WHAT IT WAS ASKED
${prompt}

WHAT WAS TRUE AT THE TIME
${expected.situation ?? "Not written down."}

WHAT IT SAID
${result.text || "(it said nothing)"}

WHAT IT DID
${JSON.stringify(did, null, 2)}

EXPECTATIONS, one check each, in this order
${lines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`,
    },
  ];
  let answer = await ask({ model, messages });
  let checks = parse(answer.text);
  // Told what was wrong and asked once more, because a judge that writes broken
  // JSON is a broken judge, and scoring that against the agent would blame it.
  if (!checks) {
    messages.push(
      { role: "assistant", content: answer.text },
      { role: "user", content: `That is not JSON that reads: ${jsonProblem(answer.text)}. Answer again, with the JSON alone.` },
    );
    answer = await ask({ model, messages });
    checks = parse(answer.text);
  }
  if (!checks) return { score: 0, reason: `The judge did not answer with JSON, twice: ${answer.text.slice(0, 200)}` };

  const met = checks.filter((c) => c.met).length;
  const score = checks.length === 0 ? 1 : met / checks.length;
  const missed = checks.filter((c) => !c.met);
  return {
    score,
    reason:
      missed.length === 0
        ? "Met every expectation."
        : `${score.toFixed(2)}. Missed: ${missed.map((c) => `${c.expectation} (${c.why})`).join(" ")}`,
  };
}

interface Check {
  expectation: string;
  met: boolean;
  why: string;
}

/**
 * A model asked for JSON usually returns JSON, and sometimes returns JSON
 * inside a code fence or with a sentence in front of it. Take the first
 * object in the text rather than failing the case over punctuation.
 */
/** What is wrong with the JSON in a judge's answer, in the parser's words. */
function jsonProblem(text: string): string {
  try {
    JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return "it has no list of checks";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parse(text: string): Check[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { checks?: Check[] };
    return Array.isArray(parsed.checks) ? parsed.checks : null;
  } catch {
    return null;
  }
}
