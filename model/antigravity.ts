// Asking the model through the Antigravity CLI rather than over HTTP.
//
// Like claude.ts, codex.ts and opencode.ts this exists for the credential: a
// Google account with AI Pro authorises the CLI, and it is not an API key, so
// there is nothing to put in a bearer header. The route "antigravity" in
// settings picks it, and it runs Google models only.
//
// The CLI's own tools are switched off the only way it allows headless: it
// cannot prompt, so every tool that would need approval is refused, and chloe
// hands its own tools over by describing them in the prompt and reading the
// calls back out of the reply, the same as codex (see cli.ts for why the loop
// is chloe's). Real MCP tools are not used here: agy denies a tool it cannot
// prompt for unless the account's own settings allow it, and that file is the
// person's, not chloe's.
//
// Two traps, both found by running it:
// - `agy -p` hangs in a pipe, so the prompt goes in over stdin in the CLI's
//   stream-json shape and the answer comes back as stream-json too.
// - the CLI carries about 12k tokens of its own instructions on every call, so
//   a step here is heavier than it looks.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "#chloe/core/settings";

import { asText, invoke, readReply } from "./cli.ts";
import { type Answer, type Ask, UsageLimit } from "./model.ts";

/** "google/gemini-3.8-flash-high" is "gemini-3.8-flash-high" to the CLI. Another provider is refused here rather than by the CLI. */
export function antigravityModel(model: string): string {
  const at = model.indexOf("/");
  const provider = at < 0 ? "" : model.slice(0, at);
  if (provider !== "google") {
    throw new Error(
      `The antigravity route can only run Google models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or put a route that carries it ahead in model.preferredRoute.`,
    );
  }
  return model.slice(at + 1);
}

/** What the CLI's stream-json lines say about one run. */
export interface Reading {
  /** The answer's words, from the result line or, failing that, the streamed deltas. */
  said: string;
  tokensIn: number;
  tokensOut: number;
  /** What the CLI said went wrong, from its result or error line. Empty when it finished. */
  problem: string;
}

/**
 * Reads the words, the tokens and the failure out of the CLI's stream-json
 * lines. The result line carries the whole answer and the totals; the deltas
 * are only a fallback, because a run cut off before its result line leaves the
 * words there.
 */
export function readAntigravity(out: string): Reading {
  const deltas: string[] = [];
  let said = "";
  let problem = "";
  let tokensIn = 0;
  let tokensOut = 0;
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: { event?: string; result?: ResultLine; step_update?: StepLine; error?: { message?: string }; message?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.event === "step_update") {
      const step = event.step_update ?? {};
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") deltas.push(step.text_delta);
    }
    if (event.event === "error") problem = event.error?.message ?? event.message ?? problem;
    if (event.event === "result") {
      const result = event.result ?? {};
      said = typeof result.response === "string" ? result.response : said;
      tokensIn = result.usage?.input_tokens ?? tokensIn;
      tokensOut = result.usage?.output_tokens ?? tokensOut;
      if (result.status && result.status !== "SUCCESS") problem = result.error ?? `it stopped: ${result.status}`;
    }
  }
  return { said: (said.trim() || deltas.join("").trim()), tokensIn, tokensOut, problem };
}

/** One line of the CLI's stream-json output. Only the fields read here are named. */
interface ResultLine {
  response?: string;
  status?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface StepLine {
  step_type?: string;
  text_delta?: string;
}

/** A plan that has run out or a quota the account has hit is said as one. */
function isLimit(problem: string): boolean {
  return /RESOURCE_EXHAUSTED|quota|usage limit|rate limit|\b429\b/i.test(problem);
}

export async function viaAntigravity({ model, messages, tools, signal }: Ask): Promise<Answer> {
  // The instructions, the tools described in words, then the conversation. Its
  // own tools are refused because it cannot prompt headless, so what it may ask
  // for is only what the prompt describes.
  const { system, transcript } = asText({ messages, tools });
  const folder = await mkdtemp(join(tmpdir(), "chloe-antigravity-"));
  try {
    const prompt = system ? `${system}\n\n${transcript}` : transcript;
    // One user message in the CLI's stream-json stdin shape: `agy -p` hangs in a
    // pipe, this does not.
    const input = `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      antigravityModel(model),
      // Skills and slash commands of this machine's, off: the same prompt has to
      // mean the same thing on anyone's box.
      "--disable-slash-commands",
    ];

    const cli = settings.model.program.antigravity;
    const { code, out, err } = await invoke(cli, args, input, {
      signal,
      cwd: folder,
      missing: `The antigravity route needs ${JSON.stringify(cli)} on the path. Install Antigravity CLI, or put it on the path.`,
      // The CLI would bill a Gemini API key ahead of the plan if one is in the
      // environment, the way the claude command would bill an Anthropic key.
      env: { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined },
    });

    const read = readAntigravity(out);
    if (read.problem) {
      if (isLimit(read.problem)) {
        throw new UsageLimit(`I have hit a usage limit on the Google account the antigravity route reaches the model through, so I cannot answer until it resets. It says: ${read.problem.slice(0, 300)}`);
      }
      throw new Error(`Model call refused: antigravity: ${read.problem.slice(0, 500)}`);
    }
    if (code !== 0) {
      throw new Error(`Model call refused: antigravity exited ${code}: ${(read.said || err || out).slice(0, 500)}`);
    }
    // An empty answer is the CLI's own note when a run tried one of its refused
    // tools and stopped, not something to hand on as words.
    if (!read.said) throw new Error(`Model call refused: antigravity wrote no answer: ${(err || out).slice(0, 500)}`);

    const { said, calls, dropped } = tools?.length ? readReply(read.said, tools) : { said: read.said, calls: [] };
    // A plan is not billed per call and the CLI names no price, so what a run on
    // this route cost is unknown, the same as codex.
    return { text: said, toolCalls: calls, ...(dropped && { dropped }), tokensIn: read.tokensIn, tokensOut: read.tokensOut };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The models the CLI lists for this account, "google/gemini-3.8-flash-high" and
 * so on, from `agy models`, whose lines are an id, a tab, and the label the
 * picker shows. Empty when the CLI is missing or nobody is signed in.
 */
export async function antigravityModels(): Promise<string[]> {
  const cli = settings.model.program.antigravity;
  try {
    const { code, out } = await invoke(cli, ["models"], "", { signal: AbortSignal.timeout(30_000), missing: "" });
    if (code !== 0) return [];
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("\t"))
      .map((line) => line.split("\t")[0]!.trim())
      .filter((id) => /^[\w.-]+$/.test(id))
      .map((id) => `google/${id}`);
  } catch {
    return [];
  }
}
