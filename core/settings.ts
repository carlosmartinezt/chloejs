// Every setting, and what it is when nobody says.
//
// Two places, read in this order, each one winning over the one before:
//
//   the types below    the default, and the documentation
//   chloe.config.ts    `settings: { ... }` in defineConfig, in source control
//   the environment    .env beside chloe.config.ts, and the real environment
//
// A choice about how the runtime behaves goes in the config, where it is typed
// and committed. A secret goes in .env, mode 600: every password, key and
// token, and nothing else. Nothing in source control may hold one.
//
// Every setting also has a name in the environment, CHLOE_ and its path in
// capitals: CHLOE_CLOUD_URL, CHLOE_RESEND_API_KEY, CHLOE_AGENTS_<agent>_TELEGRAM.
// So anything the config can say, .env can say instead, and a box can run with
// nothing declared at all. Every variable the runtime reads is one of these
// settings, and there is no other name it looks for, so a config may hand a
// setting the variable itself: `cloud: { api_key: process.env.CHLOE_CLOUD_API_KEY }`. A setting
// the config says is undefined is one it did not say.
//
// `state`, `memory`, `db` and `node` are read before any config is loaded, at
// the top of core/paths.ts and core/db.ts, so those four are read from the
// environment and declaring them does nothing. Where things are kept needs a
// restart either way.
//
// The config reaches this file and not the other way round: `loadAll()` calls
// `declareSettings` before it resolves an agent, so nothing in core/ has to
// know what an agent or a config is.
// First, so .env is in the environment before anything reads a setting.
import { loadEnv } from "./env.ts";

/**
 * How a model is reached, and so which account pays for it. "claude" is the
 * Claude Code CLI on a Claude subscription, "codex" the Codex CLI on a ChatGPT
 * plan, "opencode" the opencode CLI on whatever it is signed in to, and
 * "gateway" is HTTP on a key, charged per call. The list is also what a value
 * out of the environment is checked against, so the words and the type cannot
 * disagree.
 */
export const ROUTES = ["claude", "codex", "opencode", "gateway"] as const;
export type Route = (typeof ROUTES)[number];

/** Which page the one port serves: whichever is installed, or the runtime's own. */
export const PAGES = ["", "builtin"] as const;
export type Page = (typeof PAGES)[number];

/** Who carries an agent's mail. */
export const EMAIL_PROVIDERS = ["resend", "gmail", "none"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/** One agent's own settings: its channels' tokens, and nothing else. */
export interface AgentSettings {
  /** Its Telegram bot's token, from @BotFather. */
  telegram: string;
  /** Its Slack app's two tokens: the bot token (xoxb-...) and the app token (xapp-...). */
  slack: { bot_token: string; app_token: string };
  /**
   * Its WhatsApp number: the number's id, a permanent token, and the app secret
   * that signs what Meta posts in. All three are on the app's pages at
   * developers.facebook.com.
   */
  whatsapp: { phone_number_id: string; token: string; app_secret: string };
}

/** Every setting there is, with every one of them answered. */
export interface Settings {
  /** Which model is asked, and how this box reaches it. */
  model: {
    /**
     * The model an agent asks when its own `agent.ts` names none. Empty means
     * every agent names its own, and one that does not is refused as it loads.
     * Written by `npx chloe setup`, so a new project has the model it chose in
     * one place rather than in every agent.
     */
    default: string;
    /**
     * Which way of reaching a model to try first, then next. The first one that
     * can carry the model's provider and is set up here is the one it goes by,
     * so a Claude subscription is used before a key that charges per call. A
     * route this box has no credential for is skipped.
     */
    prefer: Route[];
    /**
     * The route one provider's models always go by, like `{ openai: "codex" }`,
     * whatever `prefer` says. For the rare case where the order is wrong for
     * one provider only.
     */
    routes: Record<string, Route>;
    /**
     * The shortlist somebody may pick from for a chat, an agent or a job, on top
     * of the ones the agents already name. Empty asks each route what it has
     * instead, which is every model this box can reach and usually hundreds, so
     * this is for cutting that down to the few worth offering. Only models this
     * box can actually run are offered either way.
     */
    models: string[];
    /** Any gateway that speaks the OpenAI chat-completions shape. */
    gateway: string;
    /** The gateway's key. Empty means no gateway, so via "" picks the CLI. */
    key: string;
    /** Who marks an eval. Cheaper than the agent being marked, on purpose. */
    judge: string;
    /**
     * The program each CLI route runs, for one installed under another name or
     * somewhere off the path. A route whose program is not there is skipped.
     */
    program: { claude: string; codex: string; opencode: string };
  };
  /** How an agent's mail goes out. */
  email: {
    /**
     * Who carries an agent's mail. Its key is in that provider's own
     * section. "none" writes the message to the log and sends nothing, which
     * is what a test run and a box with no mail account use. EMAIL_PROVIDER
     * overrides it for one run.
     */
    provider: EmailProvider;
  };
  /** Sending mail through Resend. */
  resend: {
    /** The key an agent's mail is sent with. Without one, nothing is sent. */
    api_key: string;
  };
  /** Signing in to Google, for the tools that read mail, a calendar or a sheet. */
  google: {
    /** The account that gets signed in, and the one a mail tool reads from. */
    account: string;
    /**
     * What this copy signs in with, in whichever of the three forms is in
     * front of you: the client Google's console downloads, pasted in here as
     * it is, the path to that file, or its contents as one string.
     *
     * It keeps the console's own shape, a `web` or an `installed` section,
     * because which of the two it is decides where Google will agree to send
     * its answer and nothing else says which it is.
     *
     * There is no passphrase setting beside it: the runtime makes that
     * itself, in the state folder. Two copies of one passphrase is how a
     * sign-in that works comes to look like one that has expired.
     */
    client: string | Record<string, unknown>;
    /**
     * Where Google sends its answer. Empty and connected to a dashboard, the
     * dashboard catches it and the sign-in finishes on its own. Empty and not
     * connected, the answer goes to a port on this machine that the person's
     * browser cannot reach, so they paste the address back instead.
     */
    callback: string;
    /** The gog program to use. Empty means find one, or fetch one into the state folder. */
    gog: string;
    /** Which gog release to fetch when this machine has none new enough. */
    version: string;
    /** The Analytics service account's key, handed to scripts as GA_KEY_FILE. */
    GA_KEY_FILE: string;
  };
  /** Mail sent when somebody signs in from an address this copy has not seen. */
  alerts: {
    /** Where it goes. Empty means nothing is sent, and the sign-in is still recorded. */
    email_to: string;
    /** The From line, e.g. "Chloe <info@example.com>". */
    email_from: string;
  };
  /**
   * Each agent's own settings, under the name in its `agent.ts`. Read by that
   * name when the channel starts, so renaming an agent means renaming its entry
   * here, and the server says so when an entry names no agent.
   */
  agents: Record<string, AgentSettings>;
  /**
   * Chloe Cloud: a dashboard somewhere else that this runtime connects out to
   * and is shown on. Nothing about how a job runs depends on it.
   */
  cloud: {
    /**
     * This workspace's key, from the dashboard. Without one there is no
     * connection, and taking it out leaves everything running as it was. It is
     * a credential, so the key itself goes in .env as CHLOE_CLOUD_API_KEY, and a
     * config that says where it comes from names that variable, not the key.
     */
    api_key: string;
    /** Where the cloud is. CHLOE_CLOUD_URL beats it. Point it at your own by setting this. */
    url: string;
    /** What is sent up as it happens, so the dashboard can show it when this runtime is offline. */
    sync: {
      /** Each run's row, as GET /api/runs shows it, when it starts and when it ends. */
      runs: boolean;
      /** Every agent's configuration, as GET /api/agents shows it, on connect and on each reload. */
      agents: boolean;
    };
    /** What the dashboard may ask over the connection. Each is a switch, and a request that needs one that is off is refused. */
    remote: {
      /** Read: the agents, the runs, the files, the conversations. */
      read: boolean;
      /** Talk to an agent. */
      chat: boolean;
      /** Run a job now. */
      run: boolean;
      /** Read a memory. Every file is still written to the audit log first, saying it came through the cloud. */
      memory: boolean;
      /** Write: a file, a memory file, an answer to a parked job, a model pick. */
      write: boolean;
      /**
       * Let the dashboard hand back the answer to a Google sign-in this
       * runtime started, so nobody has to paste a code. Nothing else about
       * Google comes through it, and a code that does not match the sign-in
       * this runtime is waiting for is refused.
       * Requires a callback set to: https://dashboard.chloejs.org/oauth/google/callback/<workspace>
       */
      google: boolean;
    };
  };
  /** Who a run belongs to when no channel has said, as `channel:who`. */
  owner: string;
  /**
   * Which page the one port serves. Empty is whichever page package is
   * installed, and "builtin" is the runtime's own whatever is installed, which
   * is how a broken dashboard is told from a broken runtime.
   */
  page: Page;
  /** Everything the agents keep: their folders and the run history. Empty means data/ inside the repo. */
  state: string;
  /** The run history and the conversations. Empty means agents.db inside the state folder. */
  db: string;
  /** Where the memories are, one folder per agent. Empty means memory/ inside the state folder. */
  memory: string;
  /** Which node the unit runs. Empty means whichever is on the path at install. */
  node: string;
}

/**
 * What every setting is when nobody says. Typed as `Settings`, so a setting
 * added above without one here does not compile, which is what keeps the two
 * from drifting.
 */
export const DEFAULTS: Settings = {
  model: {
    default: "",
    // A subscription before a key that charges per call, and the gateway last
    // because it is the only one that can carry any provider.
    prefer: [...ROUTES],
    routes: {},
    models: [],
    gateway: "https://ai-gateway.vercel.sh/v1/chat/completions",
    key: "",
    judge: "anthropic/claude-sonnet-5",
    program: { claude: "claude", codex: "codex", opencode: "opencode" },
  },
  email: { provider: "resend" },
  resend: { api_key: "" },
  google: { account: "", client: "", callback: "", gog: "", version: "", GA_KEY_FILE: "" },
  alerts: { email_to: "", email_from: "" },
  agents: {},
  cloud: {
    api_key: "",
    url: "https://dashboard.chloejs.org",
    sync: { runs: true, agents: true },
    remote: { read: true, chat: true, run: true, memory: false, write: false, google: false },
  },
  owner: "",
  page: "",
  state: "",
  db: "",
  memory: "",
  node: "",
};

/** One entry of an agent's own settings, when nobody says. */
const AGENT_DEFAULTS: AgentSettings = {
  telegram: "",
  slack: { bot_token: "", app_token: "" },
  whatsapp: { phone_number_id: "", token: "", app_secret: "" },
};

/**
 * A setting holding entries whose names somebody chose, and what one entry is
 * when nobody says. A variable's name is split on these fields, and an entry is
 * filled in from this, so `CHLOE_AGENTS_TEMPO_TELEGRAM` leaves tempo's Slack
 * tokens empty rather than missing. `*` means an entry is one plain value.
 */
const RECORDS: Record<string, unknown> = {
  agents: AGENT_DEFAULTS,
  "model.routes": "*",
};

/**
 * The values a setting is allowed to take, where it is not any string. Read off
 * the same lists the types come from. `*` stands for a record's entries.
 */
const ONE_OF: Record<string, readonly string[]> = {
  "model.prefer.*": ROUTES,
  "model.routes.*": ROUTES,
  "email.provider": EMAIL_PROVIDERS,
  page: PAGES,
};

/** A value, or the same shape with every part of it optional. */
type Deep<T> = T extends string | number | boolean | unknown[] ? T | undefined : { [K in keyof T]?: Deep<T[K]> };

/**
 * What `chloe.config.ts` may declare: any part of the shape above, as deep as
 * it goes. What it leaves out is the default, and the environment beats
 * whatever it says.
 */
export type Declared = { [K in keyof Settings]?: Deep<Settings[K]> };

/**
 * Every setting can also be set in the environment, under `CHLOE_` and its
 * path in capitals: `CHLOE_CLOUD_URL` for `cloud.url`, `CHLOE_RESEND_API_KEY`
 * for `resend.api_key`, `CHLOE_AGENTS_CHLOE_TELEGRAM` for that agent's token.
 * The name is worked out from the shape above, so a setting added there has one
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
  ["model.prefer", "MODEL_VIA"],
  ["model.gateway", "AI_GATEWAY_URL"],
  ["model.key", "AI_GATEWAY_API_KEY"],
  ["model.judge", "JUDGE_MODEL"],
  ["email.provider", "EMAIL_PROVIDER"],
  ["resend.api_key", "RESEND_API_KEY"],
  ["google.account", "GOG_ACCOUNT"],
  ["cloud.api_key", "CHLOE_API_KEY"],
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

/** Whether a path holds entries somebody named, like `agents` or `model.routes`. */
function recordAt(path: string[]): unknown {
  return RECORDS[path.join(".")];
}

/**
 * The defaults with what was said written over them, one setting at a time, so
 * declaring `model.prefer` leaves `model.gateway` alone. A record's entry is filled
 * in from the shape of one entry, so what an entry does not say is empty rather
 * than missing.
 */
function fill(defaults: unknown, said: unknown, path: string[] = []): unknown {
  const entry = recordAt(path);
  if (entry !== undefined) {
    if (!isGroup(said)) return isGroup(defaults) ? { ...defaults } : {};
    const out: Record<string, unknown> = { ...(isGroup(defaults) ? defaults : {}) };
    for (const [name, value] of Object.entries(said)) {
      out[name] = entry === "*" ? value : fill(entry, value, [...path, "*"]);
    }
    return out;
  }
  if (!isGroup(defaults)) return said === undefined ? defaults : said;
  const out: Record<string, unknown> = {};
  for (const [key, was] of Object.entries(defaults)) {
    out[key] = fill(was, isGroup(said) ? said[key] : undefined, [...path, key]);
  }
  return out;
}

/**
 * What is wrong with a value, or "" when nothing is. Checks three things: a key
 * that names no setting, a value of the wrong kind, and one outside the list of
 * what that setting may be. `chloe.config.ts` is type checked, so this is for a
 * value out of the environment and for a config that is not TypeScript.
 */
function wrong(defaults: unknown, said: unknown, path: string[] = []): string {
  // A setting handed `process.env.SOMETHING` that nothing set is one the config
  // did not say, so it is the default rather than a value of the wrong kind.
  if (said === undefined) return "";
  const where = path.join(".") || "settings";
  const allowed = ONE_OF[path.join(".")];
  if (allowed && !(typeof said === "string" && allowed.includes(said))) {
    return `${where} is ${JSON.stringify(said)}, and it is one of ${allowed.map((one) => JSON.stringify(one)).join(", ")}.`;
  }
  const entry = recordAt(path);
  if (entry !== undefined) {
    if (!isGroup(said)) return `${where} holds an entry per name, so it is an object.`;
    for (const [name, value] of Object.entries(said)) {
      const found = entry === "*" ? wrong("", value, [...path, "*"]) : wrong(entry, value, [...path, "*"]);
      // Every mention of it, because the message names the entry twice: what is
      // wrong, and what there was to set.
      if (found) return found.split(`${path.join(".")}.*`).join(`${path.join(".")}.${name}`);
    }
    return "";
  }
  if (isGroup(defaults)) {
    if (!isGroup(said)) return `${where} holds more settings, so it is an object.`;
    for (const [key, value] of Object.entries(said)) {
      if (!(key in defaults)) {
        return `${where}.${key} is not a setting. Under ${where} there is ${Object.keys(defaults).join(", ")}.`;
      }
      const found = wrong(defaults[key], value, [...path, key]);
      if (found) return found;
    }
    return "";
  }
  if (said === undefined) return "";
  // google.client is the one setting that is a string or the file's own shape.
  if (path.join(".") === "google.client") {
    return typeof said === "string" || isGroup(said) ? "" : `${where} is the client file, its path, or its contents as one string.`;
  }
  if (Array.isArray(defaults)) {
    if (!Array.isArray(said) || !said.every((one) => typeof one === "string")) return `${where} is a list of words.`;
    const each = ONE_OF[`${path.join(".")}.*`];
    const odd = each && said.find((one) => !each.includes(one as string));
    return odd === undefined || !each
      ? ""
      : `${where} has ${JSON.stringify(odd)} in it, and each one is ${each.map((one) => JSON.stringify(one)).join(", ")}.`;
  }
  return typeof said === typeof defaults ? "" : `${where} is ${typeof defaults === "boolean" ? "true or false" : `a ${typeof defaults}`}.`;
}

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
 * `slack.bot_token`, read off the shape of one entry in RECORDS. A record whose
 * entries are plain values, like `model.routes`, has none, and then everything
 * after the prefix is the key.
 */
function fieldsOf(path: string[]): string[][] {
  const entry = recordAt(path);
  return isGroup(entry) ? leaves(entry) : [];
}

/**
 * A record's entries out of the environment: `CHLOE_AGENTS_<name>_TELEGRAM`.
 * The field is matched off the end, longest first, so an agent whose name has
 * an underscore in it still reads as one name. The key is lower case, which is
 * what an agent folder and a provider are, unless something already spells it
 * another way.
 */
function entries(env: Env, path: string[], already: Record<string, unknown>, spellings: string[]): [string[], unknown][] {
  const prefix = `${nameInEnv(path)}_`;
  const fields = fieldsOf(path)
    .map((field) => ({ field, tail: `_${field.join("_").toUpperCase()}` }))
    .sort((a, b) => b.tail.length - a.tail.length);
  const out: [string[], unknown][] = [];
  for (const [name, text] of Object.entries(env)) {
    if (!name.startsWith(prefix) || text === undefined) continue;
    const rest = name.slice(prefix.length);
    if (fields.length === 0) {
      out.push([[...path, named(rest, already, spellings)], text]);
      continue;
    }
    const one = fields.find(({ tail }) => rest.endsWith(tail) && rest.length > tail.length);
    if (!one) {
      throw new Error(`${name} names no setting. Under ${path.join(".")} a name ends in ${fields.map(({ tail }) => tail).join(", ")}.`);
    }
    out.push([[...path, named(rest.slice(0, -one.tail.length), already, spellings), ...one.field], text]);
  }
  return out;
}

/** The group at a path in what was declared, or nothing there. */
function groupIn(declared: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let at: unknown = declared;
  for (const key of path) {
    if (!isGroup(at)) return {};
    at = at[key];
  }
  return isGroup(at) ? at : {};
}

/**
 * The key as something that already knows it spells it, matching on capitals and
 * treating a dash as an underscore, because a variable's name can hold neither.
 * Two places know: the config, where the key may already be written out, and the
 * `spellings` handed in, which is how an agent called `test-agent` is found by
 * CHLOE_AGENTS_TEST_AGENT_TELEGRAM. Otherwise it is what was written, in lower
 * case, and the server says the entry names no agent.
 */
function named(from: string, already: Record<string, unknown>, spellings: string[]): string {
  const same = (key: string) => key.toUpperCase().replace(/-/g, "_") === from;
  return Object.keys(already).find(same) ?? spellings.find(same) ?? from.toLowerCase();
}

/**
 * Everything the environment says, as paths and values ready to write in. The
 * shape comes from the schema's own defaults, so every setting is here and the
 * text is read as the type that setting has.
 */
export function fromEnv(env: Env, declared: Record<string, unknown>, spellings: string[] = []): [string[], unknown][] {
  const out: [string[], unknown][] = [];
  const walk = (group: Record<string, unknown>, path: string[]): void => {
    for (const [key, was] of Object.entries(group)) {
      const here = [...path, key];
      // A group the schema fills nothing into is a record: its keys are names
      // somebody chose, like an agent's, so they are read off the variables.
      if (isGroup(was) && Object.keys(was).length === 0) {
        out.push(...entries(env, here, groupIn(declared, here), spellings));
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
  walk(DEFAULTS as unknown as Record<string, unknown>, []);
  return out;
}

/**
 * What was declared, the environment over the top, and the lot checked. Takes
 * the declaration rather than reading it, so it can be tested without a disk
 * and so the order that wins is one readable line.
 */
export function readSettings(declared: unknown, env: Env = process.env, spellings: string[] = []): Settings {
  // Cloned, because the declaration belongs to whoever wrote chloe.config.ts
  // and the environment is written in on top of it.
  const merged = structuredClone(declared ?? {}) as Record<string, unknown>;
  // Last, so a variable beats the config, and one setting at a time: setting
  // cloud.url in the environment leaves the rest of cloud alone.
  for (const [path, value] of fromEnv(env, merged, spellings)) setIn(merged, path, value);
  // Said rather than passed over, because a key that silently stops being read
  // is a runtime that silently leaves its dashboard.
  if ((merged.cloud as Record<string, unknown> | undefined)?.key !== undefined) {
    throw new Error("settings: the workspace key is cloud.api_key, not cloud.key. The key itself belongs in .env, as CHLOE_CLOUD_API_KEY.");
  }
  const problem = wrong(DEFAULTS, merged);
  if (problem) throw new Error(`settings are not valid:\n${problem}`);
  return fill(DEFAULTS, merged) as Settings;
}

/** What `chloe.config.ts` declared, kept so the environment can be read again over it. */
let declared: Declared = {};

/** The agent names of the last declaration, so a variable can find one with a dash in it. */
let spellings: string[] = [];

/**
 * The settings in force: the schema's defaults, then what `chloe.config.ts`
 * declares, then the environment. Read a value when it is needed rather than
 * keeping a copy, because `declareSettings` and `reloadSettings` both write
 * into this same object.
 *
 * Until the first `declareSettings`, which is the first `loadAll()`, this is the
 * defaults and the environment. `state`, `memory` and `node` are read in that
 * window, which is why those three are environment only.
 */
export const settings: Settings = readSettings({});

/**
 * The settings `chloe.config.ts` declares, read with the environment over them
 * into the same `settings` everything already holds. Called by `loadAll()`
 * before any agent is resolved. `agents` is their names, so a variable can find
 * one with a dash in it, which a variable's name cannot hold. Throws, and
 * changes nothing, when what it is given is not valid.
 */
export function declareSettings(said: Declared | undefined, agents: string[] = []): void {
  const found = readSettings(said ?? {}, process.env, agents);
  declared = said ?? {};
  spellings = agents;
  Object.assign(settings, found);
}

/**
 * Read .env again, and the declared settings with it, into the same `settings`.
 * The server calls this when .env changes. Throws, and changes nothing, when
 * what comes out is not valid.
 */
export function reloadSettings(): void {
  loadEnv();
  Object.assign(settings, readSettings(declared, process.env, spellings));
}

/** The entries in `agents` that name none of these agents: usually one that was renamed. */
export function unclaimed(names: string[]): string[] {
  return Object.keys(settings.agents).filter((name) => !names.includes(name));
}

