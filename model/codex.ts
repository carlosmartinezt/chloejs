// Asking the model through the Codex CLI rather than over HTTP.
//
// Like claude.ts, this exists for the credential: a ChatGPT plan signs the CLI
// in and is not an API key. The route "codex" in settings picks it, and it
// runs OpenAI models only, because that is what the plan covers.
//
// The CLI's own tools and loop are switched off: see cli.ts for why. Its
// instructions are replaced with the request's, from a file, and it runs in an
// empty folder that is removed afterwards, so nothing on the box is in reach.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "#chloe/core/settings";

import { asText, invoke, readReply } from "./cli.ts";
import type { Answer, Ask } from "./model.ts";

/** "openai/gpt-6-luna" is "gpt-6-luna" to the CLI. Another provider is refused here rather than by the CLI. */
export function codexModel(model: string): string {
  const at = model.indexOf("/");
  const provider = at < 0 ? "" : model.slice(0, at);
  if (provider !== "openai") {
    throw new Error(
      `The codex route can only run OpenAI models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or route its provider elsewhere in model.routes.`,
    );
  }
  return model.slice(at + 1);
}

/** One line of what the CLI prints with --json. Only the shapes read here are named. */
interface Event {
  type?: string;
  item?: { type?: string; text?: string; message?: string };
  error?: { message?: string } | string;
  message?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The reply in the CLI's lines: the last message the agent wrote, and the
 * tokens the turn took. A line saying the turn failed is the error, and an
 * output with no message at all is one too.
 */
export function readCodex(out: string): { text: string; tokensIn: number; tokensOut: number } {
  let text: string | undefined;
  let usage: Event["usage"];
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? "";
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "turn.failed" || event.type === "error") {
      const why = typeof event.error === "string" ? event.error : (event.error?.message ?? event.message ?? "no reason given");
      throw new Error(`Model call refused: codex: ${why.slice(0, 500)}`);
    }
  }
  if (text === undefined) throw new Error(`Model call refused: codex wrote no message: ${out.slice(0, 500)}`);
  return { text, tokensIn: usage?.input_tokens ?? 0, tokensOut: usage?.output_tokens ?? 0 };
}

export async function viaCodex({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools });
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
        notes.push(`(A file called ${file.name ?? "file"}, a ${file.mediaType}, was sent, and this route cannot read it.)`);
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
      // browser, the desktop, its background process, any MCP server, and
      // reading an AGENTS.md. The prompt describes the tools, and the tools run here.
      ...["shell_tool", "unified_exec", "apps", "browser_use", "computer_use", "skill_search", "tool_suggest", "sleep_tool", "daemon_auto_start"].flatMap(
        (feature) => ["--disable", feature],
      ),
      "--config",
      "mcp_servers={}",
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      `model_instructions_file=${JSON.stringify(instructions)}`,
      ...images.flatMap((path) => ["--image", path]),
      "-",
    ];

    const cli = settings.model.program.codex;
    const { code, out, err } = await invoke(cli, args, [transcript, ...notes].join("\n\n"), {
      signal,
      cwd: folder,
      missing: `The codex route needs ${JSON.stringify(cli)} on the path. Install Codex, or put it on the path.`,
    });
    if (code !== 0) {
      throw new Error(`Model call refused: codex exited ${code}: ${(err || out).slice(0, 500)}`);
    }
    const { text, tokensIn, tokensOut } = readCodex(out);
    const { said, call } = tools?.length ? readReply(text, tools) : { said: text, call: undefined };
    // A plan is not billed per call and the CLI names no price, so a run on
    // this route costs 0 in the record.
    return { text: said, toolCalls: call ? [call] : [], cost: 0, tokensIn, tokensOut };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
