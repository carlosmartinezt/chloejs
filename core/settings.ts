// Every setting, and what it is when nobody says.
//
// Two places, read in this order, the second winning over the first:
//
//   the types below    the default, and the documentation
//   chloe.config.ts    `settings: { ... }` in defineConfig, in source control
//
// The runtime reads no setting from the environment. A choice about how it
// behaves goes in the config, where it is typed and committed. A secret goes in
// .env, mode 600, and the config hands it over by name, as
// `cloud: { api_key: process.env.CHLOE_CLOUD_API_KEY }`, so reading the config
// shows every secret there is and where each comes from. Anything else can be
// handed over the same way when somebody wants it out of the file. KEYS is the
// list of settings that are secrets. A setting the config says is undefined is
// one it did not say.
//
// Where things are kept (CHLOE_STATE, CHLOE_MEMORY, CHLOE_DB) is not a setting:
// core/paths.ts and core/db.ts read it before any config is loaded.
//
// The config reaches this file and not the other way round: `loadAll()` calls
// `declareSettings` before it resolves an agent, so nothing in core/ has to
// know what an agent or a config is.
// First, so .env is in the environment before the config is read.
import "./env.ts";

/**
 * How a model is reached, and so which account pays for it. "claude" is the
 * Claude Code CLI on a Claude subscription, "codex" the Codex CLI on a ChatGPT
 * plan, "opencode" the opencode CLI on whatever it is signed in to, and
 * "gateway" is HTTP on a key, charged per call. The list is also what a value
 * handed over from .env is checked against, so the words and the type cannot
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
    defaultModel: string;
    /**
     * Which way of reaching a model to try first, then next. The first one that
     * can carry the model's provider and is set up here is the one it goes by,
     * so a Claude subscription is used before a key that charges per call. A
     * route this box has no credential for is skipped.
     */
    preferredRoute: Route[];
    /**
     * The shortlist somebody may pick from for a chat, an agent or a job, on top
     * of the ones the agents already name. Empty asks each route what it has
     * instead, which is every model this box can reach and usually hundreds, so
     * this is for cutting that down to the few worth offering. Only models this
     * box can actually run are offered either way.
     */
    models: string[];
    /** Any gateway that speaks the OpenAI chat-completions shape. */
    gatewayUrl: string;
    /** The gateway's key. Empty means no gateway, so via "" picks the CLI. */
    key: string;
    /** Who marks an eval. Cheaper than the agent being marked, on purpose. */
    judgeModel: string;
    /**
     * Who names a conversation started on the page, from the first thing said
     * in it, while the agent answers. Small and quick on purpose. Empty leaves
     * them unnamed, and the list calls each by when it last moved.
     */
    namingModel: string;
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
     * is what a test run and a box with no mail account use.
     */
    provider: EmailProvider;
  };
  /**
   * The outside accounts a tool works through, one section each. A tool names
   * the one it needs, and the setup page lists what each is missing.
   */
  connections: {
    /** Sending mail through Resend. */
    resend: {
      /** The key an agent's mail is sent with. Without one, nothing is sent. */
      api_key: string;
      /**
       * Mail when somebody signs in from an address this copy has not seen,
       * and when one is locked out for guessing. Always sent through Resend,
       * whatever email.provider says, so it needs api_key. Off, the sign-in is
       * still recorded.
       */
      alerts: boolean;
      /** Where an alert goes, one address or several split by commas. */
      email_to: string;
      /** An alert's From line, e.g. "Chloe <info@example.com>", on a domain Resend sends for. */
      email_from: string;
    };
    /** Signing in to Google, for the tools that reach mail, a calendar or files. */
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
      /** The Analytics service account's key, handed to scripts as GA_KEY_FILE. */
      GA_KEY_FILE: string;
    };
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
     * a key, so it goes in .env, and the config names it:
     * `cloud: { api_key: process.env.CHLOE_CLOUD_API_KEY }`.
     */
    api_key: string;
    /** Where the cloud is. Point it at your own by setting this. */
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
       * Let the dashboard start and finish a connection's sign-in, and hand
       * back the answer to a Google sign-in this runtime started, so nobody
       * has to paste a code. Nothing else about Google comes through it, and
       * a code that does not match the sign-in this runtime is waiting for is
       * refused.
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
    defaultModel: "",
    // A subscription before a key that charges per call, and the gateway last
    // because it is the only one that can carry any provider.
    preferredRoute: [...ROUTES],
    models: [],
    gatewayUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
    key: "",
    judgeModel: "anthropic/claude-sonnet-5",
    namingModel: "anthropic/claude-haiku-4.5",
    program: { claude: "claude", codex: "codex", opencode: "opencode" },
  },
  email: { provider: "resend" },
  connections: {
    resend: { api_key: "", alerts: true, email_to: "", email_from: "" },
    google: { account: "", client: "", callback: "", GA_KEY_FILE: "" },
  },
  agents: {},
  cloud: {
    api_key: "",
    url: "https://dashboard.chloejs.org",
    sync: { runs: true, agents: true },
    remote: { read: true, chat: true, run: true, memory: false, write: false, google: false },
  },
  owner: "",
  page: "",
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
 * when nobody says. An entry is filled in from this, so an agent that says only
 * `telegram` has empty Slack tokens rather than missing ones.
 */
const RECORDS: Record<string, AgentSettings> = {
  agents: AGENT_DEFAULTS,
};

/**
 * The values a setting is allowed to take, where it is not any string. Read off
 * the same lists the types come from. `*` stands for each item of a list.
 */
const ONE_OF: Record<string, readonly string[]> = {
  "model.preferredRoute.*": ROUTES,
  "email.provider": EMAIL_PROVIDERS,
  page: PAGES,
};

/** A value, or the same shape with every part of it optional. */
type Deep<T> = T extends string | number | boolean | unknown[] ? T | undefined : { [K in keyof T]?: Deep<T[K]> };

/**
 * What `chloe.config.ts` may declare: any part of the shape above, as deep as
 * it goes. What it leaves out is the default.
 */
export type DeclaredSettings = { [K in keyof Settings]?: Deep<Settings[K]> };

/**
 * The name to give a secret in .env: `CHLOE_` and its path in capitals,
 * `CHLOE_CONNECTIONS_RESEND_API_KEY` for `connections.resend.api_key`, with a dash as an underscore and
 * a capital inside a word split off. Only a name to suggest: the runtime never
 * reads it, the config does.
 */
export function nameInEnv(path: string[]): string {
  return ["CHLOE", ...path.map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))].join("_").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/**
 * The settings that are secrets: a config hands each one over as
 * `process.env.SOME_NAME`, from .env. `agents` is every agent's channel tokens.
 */
export const KEYS = ["model.key", "connections.resend.api_key", "connections.google.client", "cloud.api_key", "agents"];


/**
 * Where a key goes, in words for whoever has to put it there: `in .env as
 * CHLOE_CONNECTIONS_RESEND_API_KEY, and in chloe.config.ts's settings as
 * \`connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }\``.
 */
export function whereKeyGoes(path: string[]): string {
  const name = nameInEnv(path);
  const said = (key: string) => (/^[a-z_][a-z0-9_]*$/i.test(key) ? key : JSON.stringify(key));
  const literal = path
    .slice(0, -1)
    .reduceRight((inside, key) => `${said(key)}: { ${inside} }`, `${said(path[path.length - 1])}: process.env.${name}`);
  return `in .env as ${name}, and in chloe.config.ts's settings as \`${literal}\``;
}

const isGroup = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Whether a path holds entries somebody named, like `agents`. */
function recordAt(path: string[]): AgentSettings | undefined {
  return RECORDS[path.join(".")];
}

/**
 * The defaults with what was said written over them, one setting at a time, so
 * declaring `model.preferredRoute` leaves `model.gatewayUrl` alone. A record's entry is filled
 * in from the shape of one entry, so what an entry does not say is empty rather
 * than missing.
 */
function fill(defaults: unknown, said: unknown, path: string[] = []): unknown {
  const entry = recordAt(path);
  if (entry !== undefined) {
    if (!isGroup(said)) return isGroup(defaults) ? { ...defaults } : {};
    const out: Record<string, unknown> = { ...(isGroup(defaults) ? defaults : {}) };
    for (const [name, value] of Object.entries(said)) {
      out[name] = fill(entry, value, [...path, "*"]);
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
 * value handed over from .env and for a config that is not TypeScript.
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
      const found = wrong(entry, value, [...path, "*"]);
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
  // connections.google.client is the one setting that is a string or the file's own shape.
  if (path.join(".") === "connections.google.client") {
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

/**
 * What was declared, filled in from the defaults and checked. Takes the
 * declaration rather than reading it, so it can be tested without a disk.
 */
export function readSettings(declared: unknown): Settings {
  const merged = (declared ?? {}) as Record<string, unknown>;
  // Said rather than passed over, because a key that silently stops being read
  // is a runtime that silently leaves its dashboard.
  if ((merged.cloud as Record<string, unknown> | undefined)?.key !== undefined) {
    throw new Error("settings: the workspace key is cloud.api_key, not cloud.key: `cloud: { api_key: process.env.CHLOE_CLOUD_API_KEY }`, with the key in .env.");
  }
  const problem = wrong(DEFAULTS, merged);
  if (problem) throw new Error(`settings are not valid:\n${problem}`);
  return fill(DEFAULTS, merged) as Settings;
}

/**
 * The settings in force: the schema's defaults, then what `chloe.config.ts`
 * declares. Read a value when it is needed rather than keeping a copy, because
 * `declareSettings` writes into this same object. Until the first
 * `declareSettings`, which is the first `loadAll()`, this is the defaults.
 */
export const settings: Settings = readSettings({});

/** What the config declared last, kept so `holdSettings` can go over it again. */
let declared: DeclaredSettings = {};

/** What the test suite holds over the config, so a run never reaches a real account. Empty outside it. */
let held: DeclaredSettings = {};

/** `over` written onto `under`, one setting at a time, neither of them changed. */
function over(under: unknown, top: unknown): unknown {
  if (!isGroup(under) || !isGroup(top)) return top === undefined ? under : top;
  const out: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(top)) out[key] = over(under[key], value);
  return out;
}

/**
 * The settings `chloe.config.ts` declares, into the same `settings` everything
 * already holds. Called by `loadAll()` before any agent is resolved. Throws, and
 * changes nothing, when what it is given is not valid.
 */
export function declareSettings(said: DeclaredSettings | undefined): void {
  Object.assign(settings, readSettings(over(said ?? {}, held)));
  declared = said ?? {};
}

/**
 * Settings the test suite keeps over whatever the config says, every time it is
 * declared. The suite runs inside the project that installed the runtime, so
 * without this it would run on that project's subscription and send its mail.
 */
export function holdSettings(these: DeclaredSettings): void {
  held = these;
  declareSettings(declared);
}

/** The entries in `agents` that name none of these agents: usually one that was renamed. */
export function unclaimed(names: string[]): string[] {
  return Object.keys(settings.agents).filter((name) => !names.includes(name));
}

