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
// `connections: { resend: { api_key: process.env.CHLOE_RESEND_API_KEY } }`, so
// reading the config shows every secret there is and where each comes from.
// Anything else can be handed over the same way when somebody wants it out of
// the file. KEYS is the list of settings that are secrets. A setting the config says is undefined is
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
 * Every way chloe can reach a model, by the name `model.preferredRoute` gives
 * it. Each one also decides which account pays. A plugin with routes of its
 * own adds them, like `claude: true`.
 */
export interface Routes {
  /** The provider's own API, with your key in `model.keys`. Charged per call. */
  direct: true;
  /** The gateway at `model.gatewayUrl`, with the key in `model.key`. Any provider. Charged per call. */
  gateway: true;
}

/**
 * The program each route that runs one starts, under `model.program`. A plugin
 * whose routes run a program adds its own, like `claude: string`.
 */
export interface Programs {}

/** The providers you can give your own API key for, in `model.keys`. */
export const PROVIDERS = ["anthropic", "openai"] as const;
/** A provider you can give your own API key for: "anthropic" or "openai". */
export type Provider = (typeof PROVIDERS)[number];
/** One way to reach a model. See `model.preferredRoute` in `Settings`. */
export type Route = keyof Routes;
/** Every way chloe can reach a model: each plugin's, then "direct" and "gateway". */
export const ROUTES: Route[] = ["direct", "gateway"];

/**
 * Every service that can send mail, by the name `email.provider` gives it. A
 * plugin that sends mail adds its own, like `resend: true`.
 */
export interface EmailProviders {
  /** Sends nothing, and writes the subject and the receivers to the log. */
  none: true;
}
/** The service that sends mail, like "resend", "gmail" or "none". See `email.provider` in `Settings`. */
export type EmailProvider = keyof EmailProviders;
/** Every value `email.provider` can take: "none", and each plugin's that sends mail. */
export const EMAIL_PROVIDERS: string[] = ["none"];

/**
 * One agent's channel tokens, set in `agents` in settings under the agent's
 * `id`. A channel uses these when its own `credentials` option does not give
 * a token. They are secrets: put them in `.env`.
 */
export interface AgentSettings {
}

/**
 * The machine chloe runs in, when it runs in one of its own. Each field is the
 * machine plugin's, declared and given its default by it, so with that plugin
 * out this is empty and a config that sets one of them is refused, the way any
 * unknown setting is.
 */
export interface MachineSettings {
}

/**
 * The outside services that tools and channels work through, one section
 * each, under `connections` in settings. Each is added by the plugin that
 * reaches that service.
 */
export interface Connections {
}

/**
 * Every setting chloe has. In `chloe.config.ts`, write only the ones you want
 * to change, in `settings: { ... }`. The rest keep their defaults.
 *
 * Put secrets (keys, tokens, passwords) in `.env`, and pass each one in with
 * `process.env`, like
 * `connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }`.
 * chloe never reads a setting from the environment by itself.
 */
export interface Settings {
  /** Which models the agents use, and how chloe reaches them. */
  model: {
    /**
     * The model an agent uses when its `agent.ts` does not set one, like
     * "anthropic/claude-sonnet-5". Default: "" (none).
     *
     * With no default, every agent must set its own model, or it fails to
     * load. `npx chloe setup` writes this for you.
     */
    defaultModel: string;
    /**
     * The order in which chloe tries the ways to reach a model. For each call,
     * it uses the first one that can run the model's provider and is set up on
     * this machine (its program is installed, or its key is set). The others
     * are skipped.
     *
     * Default: each plugin's routes, then `["direct", "gateway"]`, so a
     * subscription (the claude, codex, antigravity and opencode routes) is
     * used before a key that charges per call. `Routes` says what each one is.
     *
     * A model given in `agent.ts` as an AI SDK model, like
     * `anthropic("claude-opus-5-5")`, always goes "direct", whatever this says.
     */
    preferredRoute: Route[];
    /**
     * The models you can pick from when you change the model of a chat, an
     * agent or a job (with `/models` in a chat, or on the dashboard). The
     * models the agents and jobs already use are always on the list too.
     *
     * Default: `[]`. Empty lists every model this machine can reach, which is
     * often hundreds. Either way, only models this machine can run are listed.
     */
    models: string[];
    /**
     * The address of the gateway for the "gateway" route. Any gateway that
     * takes OpenAI-style chat completions requests works. The address ends in
     * `/chat/completions`.
     * Default: "https://ai-gateway.vercel.sh/v1/chat/completions".
     *
     * chloe also asks this gateway for its list of models and their prices
     * (at `/models` in place of `/chat/completions`). It uses the prices to
     * work out what a call with `model.keys` cost.
     */
    gatewayUrl: string;
    /**
     * The key for the gateway at `model.gatewayUrl`. It is a secret: put it in
     * `.env`. Default: "" (none). With no key, the "gateway" route is skipped.
     */
    key: string;
    /**
     * Your own API key for each provider, `anthropic` and `openai`, from the
     * provider's console. With a key, chloe can send that provider's models
     * straight to its API (the "direct" route). Each call is charged.
     * Default: "" for both (none).
     *
     * They are secrets: put them in `.env`. The "claude" route never gets the
     * Anthropic key, so the Claude Code CLI stays on your subscription.
     */
    keys: Record<Provider, string>;
    /**
     * The longest one model call may take, in minutes, on any route: one
     * answer from Claude Code, Codex, opencode or a provider's API. A call
     * still going then is stopped (a program is killed) and fails with a
     * message that says so, so a stuck call fails its run instead of holding
     * its job for ever. Default: 10. 0 is no limit.
     *
     * An agent step makes one call per answer, so this is not a limit on the
     * whole step.
     */
    timeLimit: number;
    /**
     * The model that grades the agent's answers when you run
     * `npx chloe evals`. Default: "anthropic/claude-sonnet-5".
     */
    judgeModel: string;
    /**
     * The model that gives each new conversation in the dashboard chat a
     * short name, from its first message. A small, fast model is enough.
     * Default: "anthropic/claude-haiku-4.5".
     *
     * Set it to "" to turn naming off. The conversations are then listed by
     * the time of their last message.
     */
    namingModel: string;
    /**
     * The command each route that runs a program starts. Change one if the
     * program has another name, or is not on the PATH (then give its full
     * path). If chloe cannot find a program, it skips that route.
     */
    program: Programs;
  };
  /** How mail is sent. */
  email: {
    /**
     * The service that sends mail when a job calls `deliverEmail()` without
     * naming a service. Default: "resend" while the Resend plugin is
     * there, and "none" without it.
     *
     * - "none": sends nothing. It only writes the subject and the receivers
     *   to the log. Use it for tests, or on a machine with no mail account.
     * - A plugin's, like "resend" (with `connections.resend.api_key`) or
     *   "gmail" (from the Google account in `connections.google`).
     *   `EmailProviders` lists them.
     *
     * The `gmail.sendEmail` and `resend.sendEmail` tools always use their own
     * service. But with "none", nothing is sent at all, not even by them.
     */
    provider: EmailProvider;
  };
  /**
   * The outside services that tools and channels work through, one section
   * each. The Connections page on the dashboard shows what each one still
   * needs.
   */
  connections: Connections;
  /**
   * Each agent's channel tokens, under the agent's `id` from its `agent.ts`.
   * Default: `{}` (none).
   *
   * They are secrets: put them in `.env`, like
   * `agents: { shop: { telegram: process.env.CHLOE_AGENTS_SHOP_TELEGRAM } }`.
   *
   * If you rename an agent, rename its entry here too. chloe writes a warning
   * to its log when an entry matches no agent.
   */
  agents: Record<string, AgentSettings>;
  /**
   * Where chloe's web server listens. It serves the dashboard, the API, and
   * the addresses some channels need. A change needs a restart.
   */
  serve: {
    /**
     * The network address the server listens on. Default: "127.0.0.1", so
     * only this machine can reach it.
     *
     * "0.0.0.0" listens on every address the machine has. A container needs
     * this, so the machine around it can reach the server.
     *
     * Warning: use "0.0.0.0" only with a proxy in front and the port closed
     * to everything else. The login lockout trusts the visitor's address that
     * the proxy writes. It does not protect you if a stranger can reach the
     * port without going through the proxy.
     */
    host: string;
    /**
     * The port the server listens on. Default: 3067.
     *
     * If your host gives you the port in an environment variable, write
     * `port: Number(process.env.PORT)`.
     */
    port: number;
    /**
     * The address the dashboard is opened at from other machines, like
     * "https://chloe.example.com", when your own web server or private
     * network puts it there. Agents use it to send their owner a link to a
     * file in their memory. Read on each turn, so it needs no restart.
     * Default: "" (unknown, and an agent gives the path on the dashboard).
     */
    url: string;
    /**
     * A key that signs a request in as the owner, sent as
     * `Authorization: Bearer <key>`. It is for the copy of chloe that made
     * this one's machine, and shows this copy's agent on its page: that copy
     * writes it here. It reaches everything the owner's login does, so keep
     * it long and in `.env`. Default: "" (none: only the login signs anybody
     * in).
     */
    ownerKey: string;
    /**
     * Minutes with nothing to do before this copy stops itself: no request,
     * no run going or waiting, and no job due in the next few. For a machine
     * of its own, which the copy that made it starts again when it is asked
     * for, so it costs nothing while it sleeps. A copy
     * whose agents bind a channel other than api never stops, because that
     * channel listens. Default: 0 (never).
     */
    stopAfter: number;
  };
  /** The machine chloe runs in, when it runs in one of its own. The machine plugin fills in every field. */
  machine: MachineSettings;
  /**
   * The owner of every agent's runs, written as `channel:id`, like
   * "telegram:123456789". When a job stops to ask a question or to get a tool
   * call approved, it asks this person. A message from this person counts as
   * a message from the owner.
   *
   * Default: "" (none). Then each agent's owner is the first person in the
   * `allowFrom` list of its channel.
   */
  owner: string;
  /**
   * The folder that holds the `node` program the background service runs,
   * like "/usr/local/bin". Only `npx chloe install` reads it.
   * Default: "" (the folder of the `node` found on the PATH when you run
   * `npx chloe install`).
   */
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
    keys: { anthropic: "", openai: "" },
    timeLimit: 10,
    judgeModel: "anthropic/claude-sonnet-5",
    namingModel: "anthropic/claude-haiku-4.5",
    // Each plugin whose routes run a program adds its own.
    program: {} as Programs,
  },
  email: { provider: "none" },
  // Each plugin that reaches a service adds that service's section.
  connections: {
  } as Connections,
  agents: {},
  serve: { host: "127.0.0.1", port: 3067, url: "", ownerKey: "", stopAfter: 0 },
  machine: {} as MachineSettings,
  owner: "",
  node: "",
};

/** One entry of an agent's own settings, when nobody says. Each channel's plugin adds its own. */
const AGENT_DEFAULTS = {
} as AgentSettings;

/**
 * A setting holding entries whose names somebody chose, and what one entry is
 * when nobody says. An entry is filled in from this, so an agent that says only
 * `telegram` has empty Slack tokens rather than missing ones.
 */
const RECORDS: Record<string, object> = {
  agents: AGENT_DEFAULTS,
};

/**
 * The values a setting is allowed to take, where it is not any string. Read off
 * the same lists the types come from. `*` stands for each item of a list.
 */
const ONE_OF: Record<string, readonly string[]> = {
  "model.preferredRoute.*": ROUTES,
  "email.provider": EMAIL_PROVIDERS,
};

/** A value, or the same shape with every part of it optional. */
type Deep<T> = T extends string | number | boolean | unknown[] ? T | undefined : { [K in keyof T]?: Deep<T[K]> };

/**
 * The type of `settings` in `chloe.config.ts`. It has the same shape as
 * `Settings`, but every part is optional, at every level. Anything you leave
 * out keeps its default.
 */
export type DeclaredSettings = { [K in keyof Settings]?: Deep<Settings[K]> };

/**
 * Returns the name to give a secret in `.env`: `CHLOE_`, then each part of
 * the setting's path in capitals, joined with `_`. For example,
 * `["connections", "resend", "api_key"]` gives
 * `CHLOE_CONNECTIONS_RESEND_API_KEY`.
 *
 * A capital letter inside a word starts a new part (`defaultModel` gives
 * `DEFAULT_MODEL`), and any character that is not a letter or a digit becomes
 * `_`.
 *
 * This is only a suggested name. chloe never reads it by itself: your config
 * reads it, with `process.env`.
 */
export function nameInEnv(path: string[]): string {
  return ["CHLOE", ...path.map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))].join("_").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/**
 * The settings that hold secrets, as paths with dots, like
 * "connections.resend.api_key". Put each of these in `.env`, and pass it in
 * from your config with `process.env`. "agents" means the channel tokens of
 * every agent.
 */
export const KEYS: string[] = ["model.key", "model.keys", "agents", "serve.ownerKey"];

/** A setting whose kind is not its default's, and what is wrong with a value given for it, or "". */
const CHECKS: Record<string, (said: unknown) => string> = {};

/**
 * A plugin's settings: what each is when nobody says, which hold secrets, the
 * words one may be, and a check of its own for one whose kind is not its
 * default's. `plugins/index.ts` adds each plugin's as it loads.
 */
export interface SettingsPart {
  /** What its settings are when nobody says, at their places in `Settings`, like `{ connections: { brave: { api_key: "" } } }`. */
  defaults?: DeclaredSettings;
  /** What each agent's own settings it adds are when nobody says, like `{ telegram: "" }`. */
  agent?: Partial<AgentSettings>;
  /** The paths of its settings that hold secrets, like `"connections.brave.api_key"`. */
  keys?: string[];
  /** Words a setting may be, added to what it may already be, like `{ "email.provider": ["resend"] }`. */
  oneOf?: Record<string, readonly string[]>;
  /** A check for a setting whose kind is not its default's: what is wrong with the value, or "". */
  checks?: Record<string, (said: unknown) => string>;
  /** Ways to reach a model it adds, put before "direct" in `ROUTES` and in `model.preferredRoute`'s default. */
  routes?: Route[];
}

/**
 * Adds a plugin's settings to the defaults, the secrets, the words a setting
 * may be and the checks, and reads the config's settings over them again.
 */
export function addSettings(part: SettingsPart): void {
  if (part.defaults) Object.assign(DEFAULTS, over(DEFAULTS, part.defaults));
  if (part.agent) Object.assign(AGENT_DEFAULTS, part.agent);
  for (const key of part.keys ?? []) if (!KEYS.includes(key)) KEYS.push(key);
  for (const [path, words] of Object.entries(part.oneOf ?? {})) {
    const list = (ONE_OF[path] ??= []) as string[];
    for (const word of words) if (!list.includes(word)) list.push(word);
  }
  Object.assign(CHECKS, part.checks);
  for (const route of part.routes ?? []) {
    if (ROUTES.includes(route)) continue;
    ROUTES.splice(ROUTES.indexOf("direct"), 0, route);
    DEFAULTS.model.preferredRoute.splice(DEFAULTS.model.preferredRoute.indexOf("direct"), 0, route);
  }
  declareSettings(declared);
}


/**
 * Returns a sentence that tells a person where to put a secret: its name in
 * `.env`, and the line to write in `chloe.config.ts`. Use it in an error
 * message about a missing key.
 *
 * @example
 * whereKeyGoes(["connections", "resend", "api_key"]);
 * // in .env as CHLOE_CONNECTIONS_RESEND_API_KEY, and in chloe.config.ts's settings as
 * // `connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }`
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
function recordAt(path: string[]): object | undefined {
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
  const check = CHECKS[path.join(".")];
  if (check) return check(said) && `${where} ${check(said)}`;
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
 * Returns the full settings: the defaults, with the values in `declared`
 * written over them, one value at a time. It does not change `settings`.
 *
 * It checks `declared` first, and throws an error that says what is wrong:
 * a name that is not a setting, a value of the wrong type, or a word that is
 * not one of the allowed values. It also refuses `cloud`, `page` and
 * `dashboard`, which are gone, and says so.
 */
export function readSettings(declared: unknown): Settings {
  const merged = (declared ?? {}) as Record<string, unknown>;
  // Named rather than left to "is not a setting", so a config written for the
  // old shape says where each part went.
  if (merged.cloud !== undefined || merged.page !== undefined || merged.dashboard !== undefined) {
    throw new Error(
      "settings: dashboard is gone. The runtime serves one page, the dashboard, on its own port, and sends nothing to any other. " +
        "To reach it from another machine, use an SSH tunnel or your own web server in front of it: see https://chloejs.org/docs/the-page.",
    );
  }
  const problem = wrong(DEFAULTS, merged);
  if (problem) throw new Error(`settings are not valid:\n${problem}`);
  return fill(DEFAULTS, merged) as Settings;
}

/**
 * The settings in use right now. They start as the defaults. When chloe reads
 * `chloe.config.ts` (in `loadAll()` or `loadSettings()`), it writes the
 * config's `settings` into this same object.
 *
 * So read a value at the moment you need it. Do not keep a copy: a copy does
 * not change when the config changes.
 */
export const settings: Settings = readSettings({});

/** What the config declared last, kept so `holdSettings` can go over it again. */
let declared: DeclaredSettings = {};

/**
 * The settings the config says, as it said them, without the defaults: what
 * a machine this copy makes is given of this copy's settings.
 */
export function declaredSettings(): DeclaredSettings {
  return declared;
}

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
 * Puts the `settings` from `chloe.config.ts` into `settings`, over the
 * defaults. `loadAll()` and `loadSettings()` call it for you, before any agent
 * loads. If a value is not valid, it throws and changes nothing.
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

/**
 * Returns the names in the `agents` setting that match none of `names` (the
 * ids of the agents that loaded). Such an entry usually belongs to an agent
 * that was renamed.
 */
export function unclaimed(names: string[]): string[] {
  return Object.keys(settings.agents).filter((name) => !names.includes(name));
}

