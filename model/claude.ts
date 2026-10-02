// Asking the model through the Claude Code CLI rather than over HTTP.
//
// This exists for the credential, not the model. A Claude subscription
// authorises the CLI; it is not an API key and there is nothing in it to put in
// a bearer header. So a box with a subscription and no gateway credit runs the
// agents through here instead. The route "claude" in settings picks it.
//
// The CLI's own tools and loop are switched off: see cli.ts for why and how.
import { settings } from "#chloe/core/settings";

import { asText, invoke, readReply } from "./cli.ts";
import { type Answer, type Ask, UsageLimit } from "./model.ts";

/**
 * The CLI names a model without a provider in front of it, and writes a version
 * with a dash where the gateway writes a dot: "anthropic/claude-haiku-4.5"
 * there is "claude-haiku-4-5" here. A non-Anthropic model says so rather than
 * being handed over and refused.
 */
export function cliModel(model: string): string {
  const at = model.indexOf("/");
  const provider = at < 0 ? "anthropic" : model.slice(0, at);
  if (provider !== "anthropic") {
    throw new Error(
      `The claude route can only run Anthropic models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or route its provider elsewhere in model.routes.`,
    );
  }
  return model.slice(at + 1).replace(/\./g, "-");
}

interface CliAnswer {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  api_error_status?: number | null;
}

/** A plan that has run out answers 429, or says "limit" in place of a reply. */
function isLimit(answer: CliAnswer): boolean {
  if (answer.api_error_status === 429) return true;
  return answer.is_error === true && /usage limit|hit your limit|limit reached|rate limit/i.test(answer.result ?? "");
}

export async function viaClaude({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools });

  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    cliModel(model),
    // No tools of its own, no settings from this machine, no MCP servers: the
    // same prompt has to mean the same thing on anyone's box.
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--exclude-dynamic-system-prompt-sections",
    "--system-prompt",
    system,
  ];

  // Files cannot go in plain text, so a turn with any is sent as one message
  // of blocks instead, which the CLI only takes as stream-json. Its last line
  // is the same answer the plain call prints.
  const files = messages.flatMap((m) => m.attachments ?? []);
  const input = files.length
    ? JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: transcript },
            ...files.map((f) => ({
              type: f.mediaType.startsWith("image/") ? "image" : "document",
              source: { type: "base64", media_type: f.mediaType, data: f.data },
            })),
          ],
        },
      }) + "\n"
    : transcript;
  if (files.length) {
    args.splice(args.indexOf("--output-format"), 2, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
  }

  const cli = settings.model.program.claude;
  const { code, out, err } = await invoke(cli, args, input, {
    signal,
    missing: `The claude route needs ${JSON.stringify(cli)} on the path. Install Claude Code, or put it on the path.`,
  });
  let answer: CliAnswer | undefined;
  try {
    answer = JSON.parse(files.length ? out.trim().split("\n").pop()! : out) as CliAnswer;
  } catch {
    if (code === 0) throw new Error(`Model call refused: claude did not answer with JSON: ${out.slice(0, 500)}`);
  }
  if (answer && isLimit(answer)) {
    const said = answer.result?.trim() ? ` It says: ${answer.result.trim()}` : "";
    throw new UsageLimit(`I have hit the usage limit on the Claude plan, so I cannot answer until it resets.${said}`);
  }
  // On a failure the CLI still prints its JSON, and the reason is in result,
  // after a long run of counters that a cut at 500 characters loses.
  if (code !== 0) {
    throw new Error(`Model call refused: claude exited ${code}: ${(answer?.result || err || out).slice(0, 500)}`);
  }
  if (!answer || answer.is_error || typeof answer.result !== "string") {
    throw new Error(`Model call refused: ${answer?.subtype ?? "no result"}: ${String(answer?.result ?? "").slice(0, 500)}`);
  }

  const { said, call } = tools?.length ? readReply(answer.result, tools) : { said: answer.result, call: undefined };
  return {
    text: said,
    toolCalls: call ? [call] : [],
    // What it would have cost on the API. A subscription is not billed per
    // call, so this prices the run rather than charging it.
    cost: answer.total_cost_usd ?? 0,
    tokensIn: answer.usage?.input_tokens ?? 0,
    tokensOut: answer.usage?.output_tokens ?? 0,
  };
}
