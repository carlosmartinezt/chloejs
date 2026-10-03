// What every route through a command line tool shares: the prompt as text,
// the tools described in words, the reply read back, and running the program.
//
// A CLI brings its own tools and its own loop. Both are switched off by the
// route that uses it, because chloe runs the tools itself, checks each one
// against its schema and writes every call down. A model that quietly read a
// file would leave nothing in the run record, which is the one thing this repo
// will not give up. So the tools are described in the prompt and asked for as
// JSON, and this file is how.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Message, ToolCall, ToolSpec } from "./model.ts";

/** What the model is told about tools it cannot call itself. */
export function protocol(tools: ToolSpec[]): string {
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
    // Written exactly as protocol() asks for one. A model copies the shape it
    // sees in the transcript over the shape the rules describe, and a call
    // copied in any other shape is read as its answer and sent to the user.
    const asked = (message.tool_calls ?? [])
      .map((c) => JSON.stringify({ tool: c.function.name, arguments: parsedArguments(c.function.arguments) }))
      .join("\n");
    return [`[you]`, message.content, asked].filter(Boolean).join("\n");
  }
  return `[${message.role}]\n${message.content}`;
}

function parsedArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A request as two pieces of text: the instructions (every system message,
 * then the tools) and the conversation so far, one turn after another.
 */
export function asText({ messages, tools }: { messages: Message[]; tools?: ToolSpec[] }): { system: string; transcript: string } {
  const system = [
    ...messages.filter((m) => m.role === "system").map((m) => m.content),
    ...(tools?.length ? [protocol(tools)] : []),
  ].join("\n\n");
  const transcript = messages.filter((m) => m.role !== "system").map(render).join("\n\n");
  return { system, transcript };
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
  return readWritten(whole, tools) ?? { said: whole };
}

/**
 * The same request written as a sentence, `list_notes with {"path": "a"}`,
 * bracketed or not, as transcripts once showed past calls and models still
 * copy. Only for a tool this agent has, starting the last line, with arguments
 * that parse to the end of the reply: anything looser would catch a reply that
 * talks about a tool.
 */
function readWritten(whole: string, tools: ToolSpec[]): { said: string; call: ToolCall } | undefined {
  const lines = whole.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const opened = lines[i].match(/^\[?(?:asked for )?([\w-]+) with (\{.*)$/);
    if (!opened || !tools.some((t) => t.name === opened[1])) continue;
    const body = [opened[2], ...lines.slice(i + 1)].join("\n").trim().replace(/\]$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return {
      said: lines.slice(0, i).join("\n").trim(),
      call: { id: randomUUID(), type: "function", function: { name: opened[1], arguments: JSON.stringify(parsed) } },
    };
  }
  return undefined;
}

/**
 * The same request in the tag form some models write despite being told the
 * JSON one:
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

/**
 * Runs the program with the prompt on stdin, never as an argument: Linux caps
 * one argument at 128KB and a long conversation goes past that. `missing` is
 * the message for a program that is not on the path.
 */
export function invoke(
  cli: string,
  args: string[],
  input: string,
  options: { signal?: AbortSignal; cwd?: string; missing: string },
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cli, args, { stdio: ["pipe", "pipe", "pipe"], signal: options.signal, cwd: options.cwd });
    // Buffers until the child ends, then decoded once: decoding chunk by
    // chunk turns a character that straddles two chunks into two replacement
    // marks, and the words are the one thing a model's answer must keep.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT" ? new Error(options.missing) : error);
    });
    child.on("close", (code) =>
      done({ code: code ?? 0, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(input);
  });
}
