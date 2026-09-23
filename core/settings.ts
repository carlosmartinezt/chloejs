// Every setting, and what it is when nobody says.
//
// Three files, read in this order, each one winning over the one before:
//
//   the schema below     the default, and the documentation
//   settings.json        in source control: true for everyone who clones this
//   settings.local.json  not in source control: true for this box only
//
// An environment variable beats all three. That is for a one-off run
// (MODEL_VIA=gateway npm run evals) and for the tests, not for keeping
// settings in.
//
// A value that names a home directory, a machine, a person, or is a
// credential (a bot token, a chat id) belongs in settings.local.json, so
// setting chloe up is filling in that one file. Nothing in source control may
// hold any of them.
import { readFileSync } from "node:fs";
import { z } from "zod";

import { ROOT } from "./root.ts";

const schema = z.object({
  model: z
    .object({
      /** "gateway" for HTTP, "claude" for the CLI. Empty picks by what the machine has. */
      via: z.enum(["gateway", "claude", ""]).default(""),
      /** Any gateway that speaks the OpenAI chat-completions shape. */
      gateway: z.string().default("https://ai-gateway.vercel.sh/v1/chat/completions"),
      /** The gateway's key. Empty means no gateway, so via "" picks the CLI. */
      key: z.string().default(""),
      /** Who marks an eval. Cheaper than the agent being marked, on purpose. */
      judge: z.string().default("anthropic/claude-sonnet-5"),
    })
    .prefault({}),
  email: z
    .object({
      /**
       * Who carries an agent's mail. Its key is in that provider's own
       * section. "none" writes the message to the log and sends nothing, which
       * is what a test run and a box with no mail account use. EMAIL_PROVIDER
       * overrides it for one run.
       */
      provider: z.enum(["resend", "none"]).default("resend"),
    })
    .prefault({}),
  /** Sending mail through Resend. */
  resend: z
    .object({
      /** The key an agent's mail is sent with. Without one, nothing is sent. */
      api_key: z.string().default(""),
    })
    .prefault({}),
  google: z
    .object({
      /** The account a mail tool reads from. */
      account: z.string().default(""),
      /** Opens the saved login, from when a person signed in to that account. */
      password: z.string().default(""),
      /** The Analytics service account's key, handed to scripts as GA_KEY_FILE. */
      GA_KEY_FILE: z.string().default(""),
    })
    .prefault({}),
  /** Mail sent when somebody signs in from an address this copy has not seen. */
  alerts: z
    .object({
      /** Where it goes. Empty means nothing is sent, and the sign-in is still recorded. */
      email_to: z.string().default(""),
      /** The From line, e.g. "Chloe <info@example.com>". */
      email_from: z.string().default(""),
    })
    .prefault({}),
  /**
   * Each agent's own settings, under the name in its `agent.ts`: its channels'
   * tokens. Read by that name when the channel starts, so renaming an agent
   * means renaming its entry here, and the server says so when an entry names
   * no agent.
   */
  agents: z
    .record(
      z.string(),
      z
        .object({
          /** Its Telegram bot's token, from @BotFather. */
          telegram: z.string().default(""),
          /** Its Slack app's two tokens: the bot token (xoxb-...) and the app token (xapp-...). */
          slack: z.object({ bot_token: z.string().default(""), app_token: z.string().default("") }).strict().prefault({}),
        })
        .strict(),
    )
    .default({}),
  /** Everything the agents keep: their folders and the run history. Empty means data/ inside the repo. */
  state: z.string().default(""),
  /** Which node the unit runs. Empty means whichever is on the path at install. */
  node: z.string().default(""),
});

/** Every setting there is, as the schema defines it. */
export type Settings = z.infer<typeof schema>;

function read(name: string): unknown {
  try {
    return JSON.parse(readFileSync(`${ROOT}/${name}`, "utf8"));
  } catch (error) {
    // Missing is normal: the whole file is optional. Malformed is not, because
    // silently falling back to the defaults is how a box runs for a week on
    // settings nobody chose.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One level down, so a file can set model.via without restating model.gateway. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const mine = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && mine && typeof mine === "object" && !Array.isArray(mine)
        ? { ...(mine as object), ...(value as object) }
        : value;
  }
  return out;
}

/**
 * The two files merged and checked. Separate from reading them so it can be
 * tested without a disk, and so the order that wins is one readable line.
 */
export function readSettings(tracked: unknown, local: unknown): Settings {
  const found = schema.safeParse(merge(tracked as Record<string, unknown>, local as Record<string, unknown>));
  if (!found.success) throw new Error(`settings are not valid:\n${z.prettifyError(found.error)}`);
  return found.data;
}

/**
 * The settings in force: the schema's defaults, then `settings.json`, then
 * `settings.local.json`. One value can still be beaten by an environment
 * variable, through `setting()`. The server calls `reloadSettings` when either
 * file changes, so read a value when it is needed rather than keeping a copy.
 * `state` is the exception: where the agents keep things needs a restart.
 */
export const settings: Settings = readSettings(read("settings.json"), read("settings.local.json"));

/**
 * Read both files again, into the same `settings` everything already holds.
 * Throws, and changes nothing, when the files are not valid.
 */
export function reloadSettings(): void {
  Object.assign(settings, readSettings(read("settings.json"), read("settings.local.json")));
}

/** The entries in `agents` that name none of these agents: usually one that was renamed. */
export function unclaimed(names: string[]): string[] {
  return Object.keys(settings.agents).filter((name) => !names.includes(name));
}

/**
 * A setting, with an environment variable winning if there is one. Reading it
 * here rather than at import time is what lets a test set one.
 */
export function setting(value: string, fromEnv: string): string {
  return process.env[fromEnv] || value;
}
