// Asking the model through the Claude Code CLI rather than over HTTP.
//
// This exists for the credential, not the model. A Claude subscription
// authorises the CLI; it is not an API key and there is nothing in it to put in
// a bearer header. So a box with a subscription and no gateway credit runs the
// agents through here instead. The route "claude" in settings picks it.
//
// The CLI's own tools and loop are switched off: see cli.ts for why. A turn's
// tools are handed over as real ones instead, through `toolServer.ts`, which
// runs nothing: the CLI stops after the model's first answer, and the calls in
// it are read from the CLI's record as data. A model trained to call tools
// asks that way however it is told, and asked to write requests as text it
// sometimes did, and what the reading missed was sent to the person.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { settings } from "#chloe/core/settings";

import { asText, invoke } from "./cli.ts";
import { type Answer, type Ask, type ToolCall, UsageLimit } from "./model.ts";

/** What the CLI calls a tool from the server it is handed, which is named "chloe". */
const PREFIX = "mcp__chloe__";

/** The server, beside this file: the .ts in a clone, the .js in an install, where Node strips no types. */
const SERVER = fileURLToPath(new URL(`./toolServer.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

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
        `Either change the model or put a route that carries it ahead in model.preferredRoute.`,
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

/**
 * The most one answer may be, in tokens. A model now and then loops on its own
 * tool syntax instead of answering, and goes on until the limit, which by
 * default takes ten minutes. At this the CLI cuts it within about a minute and
 * asks the model to carry on, up to three times, and fails the call when every
 * try is cut. It keeps only the last try's text, so this sits far above any
 * real answer: those are a few thousand.
 */
const MOST = "16000";

/** A plan that has run out answers 429, or says "limit" in place of a reply. */
function isLimit(answer: CliAnswer): boolean {
  if (answer.api_error_status === 429) return true;
  return answer.is_error === true && /usage limit|hit your limit|limit reached|rate limit/i.test(answer.result ?? "");
}

export async function viaClaude({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools, native: PREFIX });
  const folder = tools?.length ? await mkdtemp(join(tmpdir(), "chloe-claude-")) : "";
  try {
    return await asked({ model, system, transcript, messages, tools, signal, folder });
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

/** One event of the CLI's stream-json record. */
interface Event {
  type?: string;
  message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] };
}

/**
 * What the model said and asked for, out of the CLI's record: the text and
 * tool calls of every answer it gave, and the result line it ends on. Only
 * calls to the tools it was handed count.
 *
 * The instructions name a tool as its developer wrote it, `skillRead`, and
 * the CLI lists it as `mcp__chloe__skillRead`. The prompt says they are the
 * same (`asText`), but a model now and then calls the short name anyway, and
 * the CLI refuses that call, tries again past the one answer it is allowed,
 * and exits 1. It is still a call to a tool it was handed, so it counts, once.
 */
export function readStream(out: string, handed: string[] = []): { answer?: CliAnswer; said: string; calls: ToolCall[] } {
  const said: string[] = [];
  const calls: ToolCall[] = [];
  let answer: CliAnswer | undefined;
  for (const line of out.split("\n")) {
    let event: Event & CliAnswer;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result") answer = event;
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) said.push(block.text.trim());
      if (block.type !== "tool_use" || !block.name) continue;
      const name = block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : handed.includes(block.name) ? block.name : undefined;
      const args = JSON.stringify(block.input ?? {});
      if (!name || calls.some((c) => c.function.name === name && c.function.arguments === args)) continue;
      calls.push({ id: randomUUID(), type: "function", function: { name, arguments: args } });
    }
  }
  return { answer, said: said.join("\n\n"), calls };
}

async function asked({ model, system, transcript, messages, tools, signal, folder }: Ask & { system: string; transcript: string; folder: string }): Promise<Answer> {
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

  // The tools, as a server the CLI starts, allowed by name, and one answer:
  // the CLI would otherwise go on to a second one with a result nobody ran.
  if (tools?.length) {
    const specs = join(folder, "tools.json");
    const servers = join(folder, "servers.json");
    await writeFile(specs, JSON.stringify(tools));
    await writeFile(servers, JSON.stringify({ mcpServers: { chloe: { type: "stdio", command: process.execPath, args: [SERVER, specs] } } }));
    args.push("--mcp-config", servers, "--allowedTools", ...tools.map((one) => `${PREFIX}${one.name}`), "--max-turns", "1");
  }

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
  // The record of each answer, which is where a tool call is, comes only as stream-json.
  const streamed = files.length > 0 || Boolean(tools?.length);
  if (streamed) args.splice(args.indexOf("--output-format"), 2, "--output-format", "stream-json", "--verbose");
  if (files.length) args.push("--input-format", "stream-json");

  const cli = settings.model.program.claude;
  const { code, out, err } = await invoke(cli, args, input, {
    signal,
    missing: `The claude route needs ${JSON.stringify(cli)} on the path. Install Claude Code, or put it on the path.`,
    // The claude command uses either of these ahead of the subscription when
    // it finds one, so a project with an Anthropic key in .env would pay per
    // call on the route that says it is a subscription.
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: MOST, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
  });
  let answer: CliAnswer | undefined;
  let read: ReturnType<typeof readStream> | undefined;
  if (streamed) {
    read = readStream(out, tools?.map((one) => one.name));
    answer = read.answer;
    if (!answer && code === 0) throw new Error(`Model call refused: claude did not end with a result: ${out.slice(0, 500)}`);
  } else {
    try {
      answer = JSON.parse(out) as CliAnswer;
    } catch {
      if (code === 0) throw new Error(`Model call refused: claude did not answer with JSON: ${out.slice(0, 500)}`);
    }
  }
  // Stopped after one answer because it asked for tools, which is the point of
  // that limit, and not a failure.
  const asking = Boolean(read?.calls.length) && answer?.subtype === "error_max_turns";
  if (answer && isLimit(answer)) {
    const said = answer.result?.trim() ? ` It says: ${answer.result.trim()}` : "";
    throw new UsageLimit(`I have hit the usage limit on the Claude plan, so I cannot answer until it resets.${said}`);
  }
  // On a failure the CLI still prints its JSON, and the reason is in result,
  // or only in subtype when result is empty, after a long run of counters
  // that a cut at 500 characters loses.
  if (code !== 0 && !asking) {
    throw new Error(`Model call refused: claude exited ${code}: ${(answer?.result || answer?.subtype || err || out).slice(0, 500)}`);
  }
  if (!answer || (!asking && (answer.is_error || typeof answer.result !== "string"))) {
    throw new Error(`Model call refused: ${answer?.subtype ?? "no result"}: ${String(answer?.result ?? "").slice(0, 500)}`);
  }

  return {
    // With tools the words are those of the answer itself, never the result
    // line, which on a stop for tools is empty.
    text: read && tools?.length ? read.said : (answer.result ?? ""),
    toolCalls: read?.calls ?? [],
    // What it would have cost on the API. A subscription is not billed per
    // call, so this prices the run rather than charging it.
    cost: answer.total_cost_usd ?? 0,
    tokensIn: answer.usage?.input_tokens ?? 0,
    tokensOut: answer.usage?.output_tokens ?? 0,
  };
}
