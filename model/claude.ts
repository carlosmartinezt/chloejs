// Asking the model through the Claude Code CLI rather than over HTTP.
//
// This exists for the credential, not the model. A Claude subscription
// authorises the CLI; it is not an API key and there is nothing in it to put in
// a bearer header. So a box with a subscription and no gateway credit runs the
// agents through here instead. Set MODEL_VIA=claude.
//
// The CLI brings its own tools and its own loop. Both are switched off, because
// chloe runs the tools itself, checks each one against its schema and writes
// every call down. A model that quietly read a file would leave nothing in the
// run record, which is the one thing this repo will not give up. So the tools
// are described in the prompt and asked for as JSON.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { setting, settings } from "#chloe/core/settings.ts";

import type { Answer, Ask, Message, ToolCall, ToolSpec } from "./model.ts";

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
      `MODEL_VIA=claude can only run Anthropic models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or set MODEL_VIA=gateway.`,
    );
  }
  return model.slice(at + 1).replace(/\./g, "-");
}

/** What the model is told about tools it cannot call itself. */
function protocol(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => `### ${t.name}\n${t.description}\n\nArguments, as JSON Schema:\n${JSON.stringify(t.parameters)}`)
    .join("\n\n");

  return [
    "# Tools",
    "",
    "You cannot run a tool yourself. To use one, end your reply with this and nothing after it:",
    "",
    '{"tool": "<name>", "arguments": { ... }}',
    "",
    "It must start its own line and be the last thing you write. A sentence before it is",
    "fine. The result comes back and you are asked again, so ask for one tool at a time.",
    "To answer instead, reply in plain words and end with no such object.",
    "",
    list,
  ].join("\n");
}

function render(message: Message): string {
  if (message.role === "tool") {
    return `[result]\n${message.content}`;
  }
  if (message.role === "assistant") {
    const asked = (message.tool_calls ?? [])
      .map((c) => `[asked for ${c.function.name} with ${c.function.arguments}]`)
      .join("\n");
    return [`[you]`, message.content, asked].filter(Boolean).join("\n");
  }
  return `[${message.role}]\n${message.content}`;
}

/**
 * Split a reply into what it said and what it asked for.
 *
 * The object has to be last and has to start its own line. Models narrate
 * before asking ("Let me check the site first."), and telling them not to does
 * not stop it, so the narration is kept and passed on rather than thrown away.
 * Requiring its own line at the end is what keeps a reply that merely writes
 * about JSON from being read as a request.
 */
export function readReply(text: string, tools: ToolSpec[] = []): { said: string; call?: ToolCall } {
  const whole = text.trim();
  const tagged = readTagged(whole, tools);
  if (tagged) return tagged;
  const fenced = whole.match(/^([\s\S]*?)```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  const before = fenced ? fenced[1] : whole;
  const tail = fenced ? fenced[2].trim() : "";

  const candidates = tail ? [{ body: tail, said: before }] : [];
  if (!tail) {
    // Every line that opens an object, latest first: the last one that parses
    // to the end of the reply is the request.
    const lines = whole.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith("{")) {
        candidates.push({ body: lines.slice(i).join("\n").trim(), said: lines.slice(0, i).join("\n") });
      }
    }
  }

  for (const { body, said } of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const asked = parsed as { tool?: unknown; arguments?: unknown };
    if (typeof asked.tool !== "string" || !asked.tool) continue;
    return {
      said: said.trim(),
      call: {
        id: randomUUID(),
        type: "function",
        function: { name: asked.tool, arguments: JSON.stringify(asked.arguments ?? {}) },
      },
    };
  }
  return { said: whole };
}

/**
 * The same request in the tag form Claude is trained on, which it sometimes
 * writes despite being told the JSON one:
 * `<invoke name="x"><parameter name="path">a.html</parameter></invoke>`.
 * The first one is the request, the way one JSON object is, and anything after
 * it is dropped: it is often the same call written again. Every value is text in
 * this form, so one the tool's schema says is not a string is read as JSON,
 * which is how a number or a list arrives as one.
 */
function readTagged(whole: string, tools: ToolSpec[]): { said: string; call: ToolCall } | undefined {
  const start = whole.search(/<(?:[\w-]+:)?invoke\s+name="/);
  if (start < 0) return undefined;
  const opened = whole.slice(start).match(/^<(?:[\w-]+:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/(?:[\w-]+:)?invoke>|$)/);
  if (!opened) return undefined;
  const wants = (tools.find((t) => t.name === opened[1])?.parameters as { properties?: Record<string, { type?: unknown }> })
    ?.properties;
  const args: Record<string, unknown> = {};
  for (const [, key, raw] of opened[2].matchAll(/<(?:[\w-]+:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:[\w-]+:)?parameter>/g)) {
    if (wants?.[key]?.type === "string") {
      args[key] = raw;
      continue;
    }
    try {
      args[key] = JSON.parse(raw);
    } catch {
      args[key] = raw;
    }
  }
  return {
    said: whole.slice(0, start).replace(/<(?:[\w-]+:)?function_calls>\s*$/, "").trim(),
    call: { id: randomUUID(), type: "function", function: { name: opened[1], arguments: JSON.stringify(args) } },
  };
}

interface CliAnswer {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The prompt goes in on stdin, never as an argument: Linux caps one argument at
 * 128KB and a long conversation goes past that.
 */
function invoke(args: string[], input: string, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, fail) => {
    const cli = setting("claude", "CLAUDE_BIN");
    const child = spawn(cli, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(
        error.code === "ENOENT"
          ? new Error(`model.via is "claude", but ${JSON.stringify(cli)} is not on the path. Install Claude Code, or put it on the path.`)
          : error,
      );
    });
    child.on("close", (code) => done({ code: code ?? 0, out, err }));
    child.stdin.end(input);
  });
}

export async function viaClaude({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const system = [
    ...messages.filter((m) => m.role === "system").map((m) => m.content),
    ...(tools?.length ? [protocol(tools)] : []),
  ].join("\n\n");

  const transcript = messages.filter((m) => m.role !== "system").map(render).join("\n\n");

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

  const { code, out, err } = await invoke(args, input, signal);
  if (code !== 0) {
    throw new Error(`Model call refused: claude exited ${code}: ${(err || out).slice(0, 500)}`);
  }

  let answer: CliAnswer;
  try {
    answer = JSON.parse(files.length ? out.trim().split("\n").pop()! : out) as CliAnswer;
  } catch {
    throw new Error(`Model call refused: claude did not answer with JSON: ${out.slice(0, 500)}`);
  }
  if (answer.is_error || typeof answer.result !== "string") {
    throw new Error(`Model call refused: ${answer.subtype ?? "no result"}: ${String(answer.result ?? "").slice(0, 500)}`);
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
