// Every setting, and what it is when nobody says.
//
// Three files, read in this order, each one winning over the one before:
//
//   the schema below     the default, and the documentation
//   settings.json        in source control: true for everyone who clones this
//   settings.local.json  not in source control: true for this box only
//
// Both are optional. `settings.example.json` beside them is every section at a
// stand-in value, to copy to `settings.local.json` and fill in, and the suite
// checks it against this schema so a renamed setting cannot leave it stale.
//
// An environment variable beats all three, and .env beside chloe.config.ts is
// read into the environment before any of this. Every setting has one, named
// CHLOE_ and its path in capitals: CHLOE_CLOUD_URL, CHLOE_RESEND_API_KEY,
// CHLOE_AGENTS_<agent>_TELEGRAM. So anything that can be set in a file can be
// set in .env instead, and a box can be configured with no settings file at
// all. Which of the two a value goes in is a choice: .env is for what belongs
// to the box rather than to the project, and the workspace key for a Chloe
// Cloud is only ever there.
//
// A value that names a home directory, a machine, a person, or is a
// credential (a bot token, a chat id) belongs in settings.local.json or .env,
// so setting chloe up is filling in one file. Nothing in source control may
// hold any of them.
import { readFileSync } from "node:fs";
import { z } from "zod";

// First, so .env is in the environment before anything reads a setting.
import { loadEnv } from "./env.ts";
import { ROOT } from "./root.ts";

const schema = z.object({
  model: z
    .object({
      /**
       * The model an agent asks when its own `agent.ts` names none. Empty means
       * every agent names its own, and one that does not is refused as it loads.
       * Written by `npx chloe setup`, so a new project has the model it chose in
       * one place rather than in every agent.
       */
      default: z.string().default(""),
      /**
       * The route for a model whose provider has no entry in `routes`:
       * "gateway" over HTTP on a key, "claude" through the Claude Code CLI on
       * a subscription, "codex" through the Codex CLI on a ChatGPT plan. Empty
       * picks by what the machine has. A route that cannot carry a provider
       * (claude for an OpenAI model) is passed over for one that can.
       */
      via: z.enum(["gateway", "claude", "codex", ""]).default(""),
      /** The route for one provider's models, like `{ "openai": "codex" }`. */
      routes: z.record(z.string(), z.enum(["gateway", "claude", "codex"])).default({}),
      /**
       * The models somebody may pick for a chat, an agent or a job, on top of
       * the ones the agents already name. Only those this box can run are
       * offered.
       */
      models: z.array(z.string()).default([]),
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
      provider: z.enum(["resend", "gmail", "none"]).default("resend"),
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
      /** The account that gets signed in, and the one a mail tool reads from. */
      account: z.string().default(""),
      /**
       * What this copy signs in with: the path to the client file Google's
       * console downloads, or that file's contents pasted in here. One person
       * makes one once. There is no passphrase setting, because the runtime
       * makes that itself in the state folder: two copies of one passphrase is
       * how a sign-in that works comes to look like one that has expired.
       */
      client: z.string().default(""),
      /**
       * Where Google sends its answer. Empty and connected to a dashboard, the
       * dashboard catches it and the sign-in finishes on its own. Empty and not
       * connected, the answer goes to a port on this machine that the person's
       * browser cannot reach, so they paste the address back instead.
       */
      callback: z.string().default(""),
      /** The gog program to use. Empty means find one, or fetch one into the state folder. */
      gog: z.string().default(""),
      /** Which gog release to fetch when this machine has none new enough. */
      version: z.string().default(""),
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
  /**
   * Chloe Cloud: a dashboard somewhere else that this runtime connects out to
   * and is shown on. Nothing about how a job runs depends on it. The workspace
   * key is CHLOE_API_KEY in .env and is not a setting: without it there is no
   * connection, and taking it out leaves everything running as it was.
   */
  cloud: z
    .object({
      /** Where the cloud is. CHLOE_CLOUD_URL beats it. Point it at your own by setting this. */
      url: z.string().default("https://dashboard.chloejs.org"),
      /** What is sent up as it happens, so the dashboard can show it when this runtime is offline. */
      sync: z
        .object({
          /** Each run's row, as GET /api/runs shows it, when it starts and when it ends. */
          runs: z.boolean().default(true),
          /** Every agent's configuration, as GET /api/agents shows it, on connect and on each reload. */
          agents: z.boolean().default(true),
        })
        .prefault({}),
      /** What the dashboard may ask over the connection. Each is a switch, and a request that needs one that is off is refused. */
      remote: z
        .object({
          /** Read: the agents, the runs, the files, the conversations. */
          read: z.boolean().default(true),
          /** Talk to an agent. */
          chat: z.boolean().default(true),
          /** Run a job now. */
          run: z.boolean().default(true),
          /** Read a memory. Every file is still written to the audit log first, saying it came through the cloud. */
          memory: z.boolean().default(false),
          /** Write: a file, a memory file, an answer to a parked job, a model pick. */
          write: z.boolean().default(false),
          /**
           * Let the dashboard hand back the answer to a Google sign-in this
           * runtime started, so nobody has to paste a code. Nothing else about
           * Google comes through it, and a code that does not match the sign-in
           * this runtime is waiting for is refused.
           */
          google: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Everything the agents keep: their folders and the run history. Empty means data/ inside the repo. */
  state: z.string().default(""),
  /** Where the memories are, one folder per agent. Empty means memory/ inside the state folder. */
  memory: z.string().default(""),
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
 * Every setting can also be set in the environment, under `CHLOE_` and its
 * path in capitals: `CHLOE_CLOUD_URL` for `cloud.url`, `CHLOE_RESEND_API_KEY`
 * for `resend.api_key`, `CHLOE_AGENTS_CHLOE_TELEGRAM` for that agent's token.
 * The name is worked out from the schema, so a setting added below has one
 * without anybody writing it down.
 */
export function nameInEnv(path: string[]): string {
  return ["CHLOE", ...path].join("_").toUpperCase();
}

/**
 * The older name a setting is also read from, from before every setting had
 * one. The name above wins when both are set. Nothing new belongs here: one
 * setting, one name.
 */
const ALSO = new Map<string, string>([
  ["model.via", "MODEL_VIA"],
  ["model.gateway", "AI_GATEWAY_URL"],
  ["model.key", "AI_GATEWAY_API_KEY"],
  ["model.judge", "JUDGE_MODEL"],
  ["email.provider", "EMAIL_PROVIDER"],
  ["resend.api_key", "RESEND_API_KEY"],
  ["google.account", "GOG_ACCOUNT"],
  ["state", "AGENTS_STATE"],
  ["memory", "AGENTS_MEMORY"],
]);

/** The environment, as this file reads it: the real one, or a made-up one in a test. */
type Env = Record<string, string | undefined>;

/**
 * What the environment holds for one setting, under either of its names, or
 * nothing when it holds neither. `settings` already has this merged in, so
 * this is for the few places that care that it came from the environment
 * rather than from a file, like a route meant for one run.
 */
export function settingInEnv(env: Env, path: string[]): string | undefined {
  const here = env[nameInEnv(path)];
  if (here !== undefined) return here;
  const also = ALSO.get(path.join("."));
  return also ? env[also] : undefined;
}

const isGroup = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The text as the type the setting already has, because the environment only
 * ever holds text. A boolean that is neither true nor false is refused rather
 * than read as false, which is the reading that silently opens a switch.
 */
function asTyped(name: string, was: unknown, text: string): unknown {
  if (typeof was === "boolean") {
    if (["true", "yes", "on", "1"].includes(text.trim().toLowerCase())) return true;
    if (["false", "no", "off", "0"].includes(text.trim().toLowerCase())) return false;
    throw new Error(`${name} is ${JSON.stringify(text)}, and a switch is true or false.`);
  }
  if (typeof was === "number") {
    const found = Number(text.trim());
    if (Number.isNaN(found)) throw new Error(`${name} is ${JSON.stringify(text)}, and it has to be a number.`);
    return found;
  }
  if (Array.isArray(was)) {
    return text
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
  }
  return text;
}

/** A value written into an object by its path, making the groups above it as it goes. */
function setIn(into: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  let at = into;
  for (const key of path.slice(0, -1)) {
    if (!isGroup(at[key])) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[path[path.length - 1]] = value;
  return into;
}

/** Every leaf under a group, as paths. */
function leaves(group: Record<string, unknown>, path: string[] = []): string[][] {
  return Object.entries(group).flatMap(([key, value]) => (isGroup(value) ? leaves(value, [...path, key]) : [[...path, key]]));
}

/**
 * The fields one entry of a record has, like an agent's `telegram` and
 * `slack.bot_token`, found by asking the schema to fill an entry in. A record
 * whose entries are plain values, like `model.routes`, has none, and then
 * everything after the prefix is the key.
 */
function fieldsOf(path: string[]): string[][] {
  const found = schema.safeParse(setIn({}, [...path, "probe"], {}));
  if (!found.success) return [];
  let at: unknown = found.data;
  for (const key of [...path, "probe"]) at = (at as Record<string, unknown>)[key];
  return isGroup(at) ? leaves(at) : [];
}

/**
 * A record's entries out of the environment: `CHLOE_AGENTS_<name>_TELEGRAM`.
 * The field is matched off the end, longest first, so an agent whose name has
 * an underscore in it still reads as one name. The key is lower case, which is
 * what an agent folder and a provider are, unless a settings file already
 * spells it another way.
 */
function entries(env: Env, path: string[], already: Record<string, unknown>): [string[], unknown][] {
  const prefix = `${nameInEnv(path)}_`;
  const fields = fieldsOf(path)
    .map((field) => ({ field, tail: `_${field.join("_").toUpperCase()}` }))
    .sort((a, b) => b.tail.length - a.tail.length);
  const out: [string[], unknown][] = [];
  for (const [name, text] of Object.entries(env)) {
    if (!name.startsWith(prefix) || text === undefined) continue;
    const rest = name.slice(prefix.length);
    if (fields.length === 0) {
      out.push([[...path, named(rest, already)], text]);
      continue;
    }
    const one = fields.find(({ tail }) => rest.endsWith(tail) && rest.length > tail.length);
    if (!one) {
      throw new Error(`${name} names no setting. Under ${path.join(".")} a name ends in ${fields.map(({ tail }) => tail).join(", ")}.`);
    }
    out.push([[...path, named(rest.slice(0, -one.tail.length), already), ...one.field], text]);
  }
  return out;
}

/** The group at a path in the settings files, or nothing there. */
function groupIn(files: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let at: unknown = files;
  for (const key of path) {
    if (!isGroup(at)) return {};
    at = at[key];
  }
  return isGroup(at) ? at : {};
}

/**
 * The key as a settings file spells it when one does, matching on capitals and
 * treating a dash as an underscore, because a variable's name can hold neither.
 * Otherwise it is what was written, in lower case: an agent whose folder has a
 * dash in it and is in no settings file is named in the environment with an
 * underscore instead, and the server says the entry names no agent.
 */
function named(from: string, already: Record<string, unknown>): string {
  const same = (key: string) => key.toUpperCase().replace(/-/g, "_") === from;
  return Object.keys(already).find(same) ?? from.toLowerCase();
}

/**
 * Everything the environment says, as paths and values ready to write in. The
 * shape comes from the schema's own defaults, so every setting is here and the
 * text is read as the type that setting has.
 */
export function fromEnv(env: Env, files: Record<string, unknown>): [string[], unknown][] {
  const out: [string[], unknown][] = [];
  const walk = (group: Record<string, unknown>, path: string[]): void => {
    for (const [key, was] of Object.entries(group)) {
      const here = [...path, key];
      // A group the schema fills nothing into is a record: its keys are names
      // somebody chose, like an agent's, so they are read off the variables.
      if (isGroup(was) && Object.keys(was).length === 0) {
        out.push(...entries(env, here, groupIn(files, here)));
        continue;
      }
      if (isGroup(was)) {
        walk(was, here);
        continue;
      }
      const text = settingInEnv(env, here);
      if (text !== undefined) out.push([here, asTyped(nameInEnv(here), was, text)]);
    }
  };
  walk(schema.parse({}) as Record<string, unknown>, []);
  return out;
}

/**
 * The two files merged, the environment over the top, and the lot checked.
 * Separate from reading them so it can be tested without a disk, and so the
 * order that wins is one readable line.
 */
export function readSettings(tracked: unknown, local: unknown, env: Env = process.env): Settings {
  const merged = merge(tracked as Record<string, unknown>, local as Record<string, unknown>);
  // Last, so a variable beats both files, and one setting at a time: setting
  // cloud.url in the environment leaves the rest of cloud alone.
  for (const [path, value] of fromEnv(env, merged)) setIn(merged, path, value);
  // Said rather than passed over, because a key that silently stops being read
  // is a runtime that silently leaves its dashboard.
  if ((merged.cloud as Record<string, unknown> | undefined)?.key !== undefined) {
    throw new Error("settings: cloud.key is now CHLOE_API_KEY in .env, beside chloe.config.ts. Move it and take it out of the settings file.");
  }
  const found = schema.safeParse(merged);
  if (!found.success) throw new Error(`settings are not valid:\n${z.prettifyError(found.error)}`);
  return found.data;
}

/**
 * The settings in force: the schema's defaults, then `settings.json`, then
 * `settings.local.json`. One value can still be beaten by an environment
 * variable, through `setting()`. The server calls `reloadSettings` when either
 * file changes, so read a value when it is needed rather than keeping a copy.
 * `state` and `memory` are the exceptions: where things are kept needs a restart.
 */
export const settings: Settings = readSettings(read("settings.json"), read("settings.local.json"));

/**
 * Read both files again, into the same `settings` everything already holds.
 * Throws, and changes nothing, when the files are not valid.
 */
export function reloadSettings(): void {
  loadEnv();
  Object.assign(settings, readSettings(read("settings.json"), read("settings.local.json")));
}

/** The entries in `agents` that name none of these agents: usually one that was renamed. */
export function unclaimed(names: string[]): string[] {
  return Object.keys(settings.agents).filter((name) => !names.includes(name));
}

/**
 * A value an environment variable may replace, for the few that are not
 * settings: which program a CLI route runs, who a run is for. A setting does
 * not come through here, because the environment is already merged into
 * `settings` under the name `nameInEnv` gives it.
 */
export function setting(value: string, fromEnv: string): string {
  return process.env[fromEnv] || value;
}
