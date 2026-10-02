// Asking the model through the opencode CLI rather than over HTTP.
//
// Like claude.ts and codex.ts this exists for the credential: opencode signs in
// to whatever accounts a person has given it, and those are not API keys. The
// route "opencode" in settings picks it.
//
// Unlike the other two it is not one provider's CLI. What it can run is whatever
// it is signed in to, which it will say, so `opencodeModels()` asks it rather
// than this file deciding.
//
// The CLI's own tools and loop are switched off: see cli.ts for why. It is done
// with a config file in an empty folder, naming an agent with every tool off and
// the request's own instructions, and that folder is removed afterwards.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setting } from "#chloe/core/settings";

import { asText, invoke, readReply } from "./cli.ts";
import type { Answer, Ask } from "./model.ts";

/** The CLI names a model provider first, the same way chloe does, so nothing is rewritten. */
export function opencodeModel(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}

/** The agent written into the config. Named in both places, so it is one word. */
const AGENT = "chloe";

/**
 * The config that switches everything off. No `$schema` line: opencode fetches
 * the URL in one, and a box with no way out then hangs instead of answering.
 */
function config(system: string): string {
  return JSON.stringify({
    mcp: {},
    agent: {
      [AGENT]: {
        description: "Answers in words. The tools are described in the prompt and run by chloe.",
        mode: "primary",
        prompt: system || "Answer the conversation below.",
        // Every tool off. The prompt describes the tools, and the tools run here.
        tools: { "*": false },
      },
    },
  });
}

/** One line of what the CLI prints with --format json. Only the shapes read here are named. */
interface Event {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    tokens?: { input?: number; output?: number };
    cost?: number;
  };
  error?: { name?: string; data?: { message?: string } };
}

/**
 * The reply in the CLI's lines: every bit of text it wrote, and what the turn
 * took. An error line is the error.
 *
 * A tool call in the output means the config did not reach it, because an
 * `--agent` the CLI does not know is passed over in silence rather than refused,
 * and the answer would then be from a model that had been reading this box. That
 * is an error and not something to work with.
 */
export function readOpencode(out: string): { text: string; cost: number; tokensIn: number; tokensOut: number } {
  const said: string[] = [];
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let answered = false;
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (event.type === "error") {
      const why = event.error?.data?.message ?? event.error?.name ?? "no reason given";
      throw new Error(`Model call refused: opencode: ${why.slice(0, 500)}`);
    }
    if (event.type === "tool") {
      throw new Error(
        `Model call refused: opencode ran a tool of its own, so the ${AGENT} agent with no tools was not in force. ` +
          "Its answer could have read this box, so it is not used.",
      );
    }
    if (event.type === "text" && typeof event.part?.text === "string") said.push(event.part.text);
    if (event.type === "step_finish") {
      answered = true;
      cost += event.part?.cost ?? 0;
      tokensIn += event.part?.tokens?.input ?? 0;
      tokensOut += event.part?.tokens?.output ?? 0;
    }
  }
  if (!answered) throw new Error(`Model call refused: opencode finished no step: ${out.slice(0, 500)}`);
  return { text: said.join(""), cost, tokensIn, tokensOut };
}

export async function viaOpencode({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools });
  const folder = await mkdtemp(join(tmpdir(), "chloe-opencode-"));
  try {
    await writeFile(join(folder, "opencode.json"), config(system));

    // A file goes beside the prompt with -f. Anything the CLI cannot take is
    // named in the prompt instead, so the model knows it was sent.
    const files: string[] = [];
    const notes: string[] = [];
    for (const [i, file] of messages.flatMap((m) => m.attachments ?? []).entries()) {
      const kind = file.mediaType.split("/")[1] ?? "bin";
      if (file.mediaType.startsWith("image/") || file.mediaType === "application/pdf") {
        const path = join(folder, `file-${i}.${kind === "pdf" ? "pdf" : kind}`);
        await writeFile(path, Buffer.from(file.data, "base64"));
        files.push(path);
      } else {
        notes.push(`(A file called ${file.name ?? "file"}, a ${file.mediaType}, was sent, and this route cannot read it.)`);
      }
    }

    const cli = setting("opencode", "OPENCODE_BIN");
    const { code, out, err } = await invoke(
      cli,
      [
        "run",
        "--format",
        "json",
        // Said as well as being the working folder, because the CLI reads PWD
        // rather than asking the system where it is, and a spawned process keeps
        // its parent's PWD however its working folder was set. Without this it
        // reads whatever project chloe itself was started in and the call fails
        // with "Unexpected server error".
        "--dir",
        folder,
        // No plugins of this box's, so the same prompt means the same thing anywhere.
        "--pure",
        "--agent",
        AGENT,
        "--model",
        opencodeModel(model),
        ...files.flatMap((path) => ["--file", path]),
        [transcript, ...notes].join("\n\n"),
      ],
      "",
      {
        signal,
        cwd: folder,
        missing: `The opencode route needs ${JSON.stringify(cli)} on the path. Install opencode, or put it on the path.`,
      },
    );
    if (code !== 0 && !out.includes('"type":"error"')) {
      throw new Error(`Model call refused: opencode exited ${code}: ${(err || out).slice(0, 500)}`);
    }
    const { text, cost, tokensIn, tokensOut } = readOpencode(out);
    const { said, call } = tools?.length ? readReply(text, tools) : { said: text, call: undefined };
    return { text: said, toolCalls: call ? [call] : [], cost, tokensIn, tokensOut };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

let known: string[] | undefined;

/**
 * The models opencode is signed in to, provider first, as it reports them. Asked
 * rather than written down, because what it can run is whoever a person has
 * given it credentials for.
 *
 * Read once and kept, because `routeFor()` needs it to decide and cannot wait:
 * asking takes about two seconds, so the first call pays that and a restart is
 * what picks up a credential added since. An empty list is a CLI that is not
 * there or has nobody signed in, and then nothing routes here.
 */
export function opencodeModels(): string[] {
  if (known) return known;
  const cli = setting("opencode", "OPENCODE_BIN");
  const done = spawnSync(cli, ["models"], { encoding: "utf8", timeout: 20_000 });
  known =
    done.status === 0
      ? done.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[\w.-]+\/[\w.:-]+$/.test(line))
      : [];
  return known;
}

/** Ask again, for a reload rather than a restart. */
export function forgetOpencodeModels(): void {
  known = undefined;
}
