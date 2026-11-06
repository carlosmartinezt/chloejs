// Asking the model through the Codex CLI rather than over HTTP.
//
// Like claude.ts, this exists for the credential: a ChatGPT plan signs the CLI
// in and is not an API key. The route "codex" in settings picks it, and it
// runs OpenAI models only, because that is what the plan covers.
//
// The CLI's own tools and loop are switched off: see cli.ts for why. Its
// instructions are replaced with the request's, from a file, and it runs in an
// empty folder that is removed afterwards, so nothing on the box is in reach.
// A turn's tools are handed over as real ones, through `toolServer.ts`, which
// runs nothing: the calls are read from the CLI's lines as data, and it is
// stopped once it has asked. A model told about tools in words here said it had
// none, and wrote the answer from what it remembered.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "#chloe/core/settings";

import { asText, copiedTranscript, invoke, TOOL_SERVER } from "./cli.ts";
import { TryAgain, type Answer, type Ask, type ToolCall } from "#chloe/model/model";

/** How long the CLI goes without asking for another tool before it is stopped, in ms. It asks for several one straight after another. */
const NO_MORE_CALLS = 1000;

/** "openai/gpt-6-luna" is "gpt-6-luna" to the CLI. Another provider is refused here rather than by the CLI. */
export function codexModel(model: string): string {
  const at = model.indexOf("/");
  const provider = at < 0 ? "" : model.slice(0, at);
  if (provider !== "openai") {
    throw new Error(
      `The codex route can only run OpenAI models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or put a route that carries it ahead in model.preferredRoute.`,
    );
  }
  return model.slice(at + 1);
}

/** One line of what the CLI prints with --json. Only the shapes read here are named. */
interface Event {
  type?: string;
  item?: { id?: string; type?: string; text?: string; message?: string; server?: string; tool?: string; arguments?: unknown };
  error?: { message?: string } | string;
  message?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The reply in the CLI's lines: the last message the agent wrote before it
 * asked for a tool, the tools it asked for, once each, and the tokens the turn
 * took. What it wrote after asking is about a result nobody ran, so it is not
 * read. A line saying the turn failed is the error, and an output with neither
 * a message nor a call is one too.
 */
export function readCodex(out: string): { text: string; calls: ToolCall[]; tokensIn: number; tokensOut: number } {
  let text: string | undefined;
  let usage: Event["usage"];
  const calls = new Map<string, ToolCall>();
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && !calls.size) text = event.item.text ?? "";
    if (event.type === "item.started" && event.item?.type === "mcp_tool_call" && event.item.server === "chloe") {
      const { id = randomUUID(), tool = "", arguments: asked } = event.item;
      calls.set(id, { id: randomUUID(), type: "function", function: { name: tool, arguments: JSON.stringify(asked ?? {}) } });
    }
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "turn.failed" || event.type === "error") {
      const why = typeof event.error === "string" ? event.error : (event.error?.message ?? event.message ?? "no reason given");
      throw new Error(`Model call refused: codex: ${why.slice(0, 500)}`);
    }
  }
  if (text === undefined && !calls.size) throw new TryAgain(`Model call refused: codex wrote no message: ${out.slice(0, 500)}`);
  return { text: text ?? "", calls: [...calls.values()], tokensIn: usage?.input_tokens ?? 0, tokensOut: usage?.output_tokens ?? 0 };
}

/**
 * The models the CLI lists for this plan, "openai/gpt-6-luna" and so on, from
 * its own catalogue, leaving out the ones it hides from its own picker. Empty
 * when the CLI is missing or fails.
 */
export async function codexModels(): Promise<string[]> {
  const cli = settings.model.program.codex;
  try {
    const { code, out } = await invoke(cli, ["debug", "models"], "", { signal: AbortSignal.timeout(20_000), missing: "" });
    if (code !== 0) return [];
    const { models = [] } = JSON.parse(out) as { models?: { slug?: string; visibility?: string }[] };
    return models.flatMap((one) => (one.slug && one.visibility === "list" ? [`openai/${one.slug}`] : []));
  } catch {
    return [];
  }
}

/** The --config lines that hand the CLI a turn's tools as a server it starts, or that give it no server when there are none. */
async function toolServer(folder: string, tools: Ask["tools"]): Promise<string[]> {
  if (!tools?.length) return ["--config", "mcp_servers={}"];
  const specs = join(folder, "tools.json");
  await writeFile(specs, JSON.stringify(tools));
  return [
    `mcp_servers.chloe.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.chloe.args=${JSON.stringify([TOOL_SERVER, specs])}`,
    "mcp_servers.chloe.required=true",
    'mcp_servers.chloe.default_tools_approval_mode="approve"',
  ].flatMap((line) => ["--config", line]);
}

export async function viaCodex({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools, native: "" });
  const folder = await mkdtemp(join(tmpdir(), "chloe-codex-"));
  try {
    const instructions = join(folder, "instructions.md");
    await writeFile(instructions, system || "Answer the conversation below.");

    // A photo goes as a file beside the prompt. Anything else the CLI cannot
    // take is named in the prompt instead, so the model knows it was sent.
    const images: string[] = [];
    const notes: string[] = [];
    for (const [i, file] of messages.flatMap((m) => m.attachments ?? []).entries()) {
      if (file.mediaType.startsWith("image/")) {
        const path = join(folder, `image-${i}.${file.mediaType.split("/")[1] ?? "bin"}`);
        await writeFile(path, Buffer.from(file.data, "base64"));
        images.push(path);
      } else {
        notes.push(`(A file called ${file.filename ?? "file"}, a ${file.mediaType}, was sent, and this route cannot read it.)`);
      }
    }

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      codexModel(model),
      // Everything it could do on its own, off: the shell, its skills, the
      // browser, the desktop, its pictures, its web search, its background
      // process, any MCP server but the tools', and reading an AGENTS.md. The tools run here.
      ...["shell_tool", "unified_exec", "apps", "browser_use", "computer_use", "image_generation", "skill_search", "tool_suggest", "sleep_tool", "daemon_auto_start"].flatMap(
        (feature) => ["--disable", feature],
      ),
      "--config",
      'web_search="disabled"',
      ...(await toolServer(folder, tools)),
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      `model_instructions_file=${JSON.stringify(instructions)}`,
      ...images.flatMap((path) => ["--image", path]),
      "-",
    ];

    const cli = settings.model.program.codex;
    let asked: NodeJS.Timeout | undefined;
    const { code, out, err } = await invoke(cli, args, [transcript, ...notes].join("\n\n"), {
      signal,
      cwd: folder,
      missing: `The codex route needs ${JSON.stringify(cli)} on the path. Install Codex, or put it on the path.`,
      // Left alone it asks the model again, with a result nobody ran.
      watch: (text, stop) => {
        if (!text.includes('"mcp_tool_call"')) return;
        clearTimeout(asked);
        asked = setTimeout(stop, NO_MORE_CALLS);
      },
    }).finally(() => clearTimeout(asked));
    // A turn that failed says why in its own lines, which readCodex reads out.
    if (code !== 0 && !/"type":"(error|turn\.failed)"/.test(out)) {
      throw new Error(`Model call refused: codex exited ${code}: ${(err || out).slice(0, 500)}`);
    }
    const { text, calls, tokensIn, tokensOut } = readCodex(out);
    if (tools?.length && copiedTranscript(text)) throw new TryAgain("Model call refused: codex wrote tool calls as text instead of making them.");
    // A plan is not billed per call and the CLI names no price, so what a run
    // on this route cost is unknown.
    return { text, toolCalls: calls, tokensIn, tokensOut };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
