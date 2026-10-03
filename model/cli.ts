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
    "fine. To use several tools whose results do not depend on each other, such as reading",
    "three files or running two searches, put one object on each line, all at the end:",
    "they all run, and every result comes back together. When one call needs another's",
    "result, ask for the first alone and wait. To answer instead, reply in plain words and",
    "end with no such object.",
    "",
    list,
  ].join("\n");
}

function render(message: Message, names: Map<string, string>): string {
  if (message.role === "tool") {
    // Named when the answer asked for several, so each result can be told
    // apart; a single call keeps the plain heading it always had.
    const name = names.size > 1 ? names.get(message.tool_call_id ?? "") : undefined;
    return `${name ? `[result of ${name}]` : "[result]"}\n${message.content}`;
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
  let names = new Map<string, string>();
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "assistant") names = new Map((m.tool_calls ?? []).map((c) => [c.id, c.function.name]));
      return render(m, names);
    })
    .join("\n\n");
  return { system, transcript };
}

/**
 * Split a reply into what it said and what it asked for: `calls` in the order
 * written, and `call`, the first of them, for a caller that takes one.
 *
 * The objects have to be last and each has to start its own line. Models
 * narrate before asking ("Let me check the site first."), and telling them not
 * to does not stop it, so the narration is kept and passed on rather than
 * thrown away. Requiring their own lines at the end is what keeps a reply that
 * merely writes about JSON from being read as a request. The one exception is
 * a request followed by a result the model wrote itself, which `readAhead`
 * reads. The same call written twice runs once.
 */
export function readReply(
  text: string,
  tools: ToolSpec[] = [],
): { said: string; call?: ToolCall; calls: ToolCall[]; dropped?: string } {
  const whole = text.trim();
  const tagged = readTagged(whole, tools);
  if (tagged) return { ...tagged, calls: [tagged.call] };
  const ahead = readAhead(whole, tools);
  if (ahead) return ahead;
  const fenced = whole.match(/^([\s\S]*?)```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    const inside = trailingCalls(fenced[2].trim());
    if (inside.calls.length && !inside.said) return { said: fenced[1].trim(), call: inside.calls[0], calls: inside.calls };
  } else {
    const found = trailingCalls(whole);
    if (found.calls.length) return { said: found.said, call: found.calls[0], calls: found.calls };
  }
  const written = readWritten(whole, tools);
  if (written) return { ...written, calls: [written.call] };
  const broken = readBroken(whole, tools);
  return broken ? { ...broken, calls: [broken.call] } : { said: whole, calls: [] };
}

/**
 * A request in the JSON shape that does not parse, for a tool this agent has,
 * from the last line that opens with `{"tool"` to the end. A model most often
 * leaves off the closing braces, so those are added and it runs. Anything else
 * goes to the tool as arguments that are not JSON, which tells the model so
 * and lets it ask again, where reading it as words would send a half written
 * request to the user as the answer and run nothing. An object that closes and
 * has words after it is an answer that shows a request, not one.
 */
function readBroken(whole: string, tools: ToolSpec[]): { said: string; call: ToolCall } | undefined {
  const lines = whole.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const opened = lines[i].match(/^\{\s*"tool"\s*:\s*"([\w-]+)"/);
    if (!opened) continue;
    if (!tools.some((t) => t.name === opened[1])) return undefined;
    const body = lines.slice(i).join("\n").trim();
    const missing = stillOpen(body);
    if (missing === "closed") return undefined;
    let asked: { tool?: unknown; arguments?: unknown } | undefined;
    try {
      asked = missing === undefined ? undefined : JSON.parse(body + missing);
    } catch {}
    return {
      said: lines.slice(0, i).join("\n").trim(),
      call: {
        id: randomUUID(),
        type: "function",
        function: { name: opened[1], arguments: asked?.tool === opened[1] ? JSON.stringify(asked.arguments ?? {}) : body },
      },
    };
  }
  return undefined;
}

/**
 * The braces and brackets that would close what `text` leaves open, "closed"
 * when the first value closes with more text after it, and undefined when it
 * cannot be closed by adding to the end (a string left open, a mismatched
 * bracket).
 */
function stillOpen(text: string): string | "closed" | undefined {
  const open: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") open.push("}");
    else if (c === "[") open.push("]");
    else if (c === "}" || c === "]") {
      if (open.pop() !== c) return undefined;
      if (!open.length) return text.slice(i + 1).trim() ? "closed" : "";
    }
  }
  return inString ? undefined : open.reverse().join("");
}

/**
 * Requests followed by the model writing their results itself. A CLI model
 * sometimes asks for a tool and carries on as both sides of the conversation:
 * a `[tool_result]` or `[system]` heading, a result it made up, the next call,
 * and so on to the end. Nothing in that ran, so the requests up to the first
 * such heading are what it asked for, and everything from the heading on is
 * `dropped`: kept for the record, never acted on and never sent as an answer.
 *
 * Only for tools this agent has, on their own lines, with nothing between the
 * last of them and the heading. A reply that writes about a call in passing is
 * still an answer.
 */
function readAhead(whole: string, tools: ToolSpec[]): { said: string; call: ToolCall; calls: ToolCall[]; dropped: string } | undefined {
  if (!tools.length) return undefined;
  const lines = whole.split("\n");
  for (let at = 1; at < lines.length; at++) {
    if (!/^\[[\w ]+\]/.test(lines[at])) continue;
    const found = trailingCalls(lines.slice(0, at).join("\n"));
    if (!found.calls.length || !found.calls.every((c) => tools.some((t) => t.name === c.function.name))) continue;
    return { said: found.said, call: found.calls[0], calls: found.calls, dropped: lines.slice(at).join("\n").trim() };
  }
  return undefined;
}

/**
 * The requests at the end of a text, read from the bottom up: the lowest line
 * opening an object that parses to the end is the last request, then the same
 * again above it, until a line that is not part of one. An object may run over
 * several lines. What is left above them is what it said.
 */
function trailingCalls(text: string): { said: string; calls: ToolCall[] } {
  const lines = text.split("\n");
  const found: ToolCall[] = [];
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  for (;;) {
    let start = -1;
    let asked: { tool?: unknown; arguments?: unknown } | undefined;
    for (let i = end - 1; i >= 0; i--) {
      if (!lines[i].startsWith("{")) continue;
      try {
        asked = JSON.parse(lines.slice(i, end).join("\n").trim()) as typeof asked;
      } catch {
        continue;
      }
      if (typeof asked?.tool === "string" && asked.tool) {
        start = i;
        break;
      }
    }
    if (start < 0 || !asked) break;
    found.unshift({
      id: randomUUID(),
      type: "function",
      function: { name: asked.tool as string, arguments: JSON.stringify(asked.arguments ?? {}) },
    });
    end = start;
    while (end > 0 && !lines[end - 1].trim()) end--;
  }
  const seen = new Set<string>();
  const calls = found.filter((c) => {
    const key = `${c.function.name} ${c.function.arguments}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { said: lines.slice(0, end).join("\n").trim(), calls };
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
