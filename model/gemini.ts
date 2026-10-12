// Asking the model through the Gemini CLI rather than over HTTP.
//
// Like claude.ts and codex.ts this exists for the credential: Google AI Pro
// (or a Google account's free Gemini Code Assist tier) authorises the CLI, and
// it is not an API key, so there is nothing to put in a bearer header. The
// route "gemini" in settings picks it, and it runs Google models only.
//
// The CLI's own tools and loop are switched off: see cli.ts for why. Its
// built-in tools are denied by a policy file, and a turn's tools are handed
// over as real ones through toolServer.ts, which runs nothing: chloe refuses
// every call, the CLI stops after the model's first answer (`maxSessionTurns`),
// and the calls in that answer are read from the CLI's stream as data. It runs
// in an empty folder that is removed afterwards, so nothing on the box is in
// reach and no GEMINI.md of this machine is read.
//
// The prompt goes on stdin rather than as an argument: Linux caps one argument
// at 128KB and a long conversation goes past that.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "#chloe/core/settings";

import { asText, invoke, TOOL_SERVER } from "./cli.ts";
import { type Answer, type Ask, type ToolCall, UsageLimit } from "./model.ts";

/** What the CLI calls a tool from the server it is handed, which is named "chloe" with no underscore for the policy parser. */
const PREFIX = "mcp_chloe_";

/** The folder the CLI reads its own settings from, under the working folder. */
const SETTINGS_DIR = ".gemini";

/**
 * "google/gemini-2.5-pro" is "gemini-2.5-pro" to the CLI. Another provider is
 * refused here rather than by the CLI.
 */
export function geminiModel(model: string): string {
  const at = model.indexOf("/");
  const provider = at < 0 ? "" : model.slice(0, at);
  if (provider !== "google") {
    throw new Error(
      `The gemini route can only run Google models, and this one asks for ${JSON.stringify(model)}. ` +
        `Either change the model or put a route that carries it ahead in model.preferredRoute.`,
    );
  }
  return model.slice(at + 1);
}

/** One event of the CLI's stream-json output. Only the fields read here are named. */
interface Event {
  type?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  message?: string;
  severity?: string;
  stats?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** What the model said, asked for and spent, read from the events of its answer. */
export interface Reading {
  said: string;
  calls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  /** What the CLI said went wrong, from its error or result line. Empty when it finished. */
  problem: string;
}

/** A tool name as the CLI lists it: anything but these is replaced with an underscore. */
function sanitized(name: string): string {
  return name.replace(/[^\w.:-]/g, "_");
}

/**
 * The words, the calls and the tokens in the CLI's stream-json lines. A call
 * counts only when it is to a tool the model was handed, by its listed name or
 * the short one chloe's instructions use, and the same call twice counts once.
 * A failed turn is the CLI's own reason.
 */
export function readGemini(out: string, handed: string[] = []): Reading {
  const said: string[] = [];
  const calls: ToolCall[] = [];
  const byName = new Map(handed.flatMap((one) => [[`${PREFIX}${sanitized(one)}`, one], [one, one]]));
  let tokensIn = 0;
  let tokensOut = 0;
  let problem = "";
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") said.push(event.content);
    if (event.type === "tool_use" && event.tool_name) {
      const name = event.tool_name.startsWith(PREFIX) ? byName.get(event.tool_name) ?? event.tool_name.slice(PREFIX.length) : byName.get(event.tool_name);
      const args = JSON.stringify(event.parameters ?? {});
      if (!name || calls.some((one) => one.function.name === name && one.function.arguments === args)) continue;
      calls.push({ id: randomUUID(), type: "function", function: { name, arguments: args } });
    }
    if (event.type === "error" && event.message) problem = event.message;
    if (event.type === "result") {
      tokensIn = event.stats?.input_tokens ?? tokensIn;
      tokensOut = event.stats?.output_tokens ?? tokensOut;
      if (event.status === "error") problem = event.error?.message ?? event.message ?? problem;
    }
  }
  return { said: said.join(""), calls, tokensIn, tokensOut, problem };
}

/** A plan that has run out or a quota the account has hit is said as one. */
function isLimit(problem: string): boolean {
  return /RESOURCE_EXHAUSTED|quota|usage limit|rate limit|429/i.test(problem);
}

/**
 * The folder the CLI runs in: its own settings, so none of this machine's are
 * read, its own tools denied by a policy file but chloe's allowed, and one
 * answer per call.
 */
async function settingsIn(folder: string, specs: string | undefined, tools: string[]): Promise<{ policy: string }> {
  const policy = join(folder, "chloe-policy.toml");
  await writeFile(
    policy,
    [
      "# Every tool of the CLI's own is denied, and chloe's tool server allowed.",
      "[[rule]]",
      'toolName = "*"',
      'decision = "deny"',
      "priority = 100",
      "",
      "[[rule]]",
      `toolName = "${PREFIX}*"`,
      'decision = "allow"',
      "priority = 200",
      "",
    ].join("\n"),
  );
  await mkdir(join(folder, SETTINGS_DIR), { recursive: true });
  await writeFile(
    join(folder, SETTINGS_DIR, "settings.json"),
    JSON.stringify(
      {
        // One turn: the CLI stops after the model's first answer, which is the
        // one chloe reads the calls from, exactly as claude --max-turns 1 does.
        model: { maxSessionTurns: 1 },
        // Nothing about a run leaves the machine but the prompt and its answer.
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        // No GEMINI.md and no folder of this machine in the context.
        context: { fileName: [], includeDirectories: [] },
        ...(specs && {
          mcpServers: {
            chloe: { command: process.execPath, args: [TOOL_SERVER, specs], cwd: folder, trust: true, includeTools: tools },
          },
        }),
      },
      null,
      2,
    ),
  );
  return { policy };
}

export async function viaGemini({ model, messages, tools, signal }: Ask): Promise<Answer> {
  // The instructions, then the conversation, as the CLI reads a prompt. Its own
  // tools are denied by policy, so tools are never described in the prompt: they
  // are handed over as a real MCP server instead.
  const { system, transcript } = asText({ messages, native: PREFIX });
  const folder = await mkdtemp(join(tmpdir(), "chloe-gemini-"));
  try {
    const names = (tools ?? []).map((one) => one.name);
    const specs = tools?.length ? join(folder, "tools.json") : undefined;
    if (specs) await writeFile(specs, JSON.stringify(tools));
    const { policy } = await settingsIn(folder, specs, names);

    const args = [
      "--output-format",
      "stream-json",
      "--model",
      geminiModel(model),
      // The folder is chloe's own and made for this call, so it is trusted for
      // the session rather than added to this machine's trusted list.
      "--skip-trust",
      "--policy",
      policy,
      // No extensions of this machine's: the same prompt has to mean the same
      // thing on anyone's box.
      "-e",
      "none",
    ];

    const cli = settings.model.program.gemini;
    const prompt = system ? `${system}\n\n${transcript}` : transcript;
    const { code, out, err } = await invoke(cli, args, prompt, {
      signal,
      cwd: folder,
      missing: `The gemini route needs ${JSON.stringify(cli)} on the path. Install the Gemini CLI, or put it on the path.`,
      // The CLI would bill an API key ahead of the subscription, the way the
      // claude command does, so a key in .env never pays for a run on the plan.
      env: { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined },
    });

    const read = readGemini(out, names);
    // 53 is the CLI's own turn limit: it stopped because one answer was all it
    // was allowed before it asked the model again, which is chloe's design and
    // not a failure. A plain answer needs no such stop.
    if (code !== 0 && code !== 53) {
      const why = read.problem || err || out;
      if (isLimit(why)) {
        throw new UsageLimit(`I have hit a usage limit on the Google account the gemini route reaches the model through, so I cannot answer until it resets. It says: ${why.slice(0, 300)}`);
      }
      throw new Error(`Model call refused: gemini exited ${code}: ${why.slice(0, 500)}`);
    }
    const { said, calls, tokensIn, tokensOut } = read;
    // A plan is not billed per call and the CLI names no price, so what a run on
    // this route cost is unknown, the same as codex.
    return { text: said, toolCalls: calls, tokensIn, tokensOut };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
