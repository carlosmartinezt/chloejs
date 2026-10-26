// What a plugin is: a feature chloe ships, kept whole in one folder under
// plugins/ and named once in plugins/index.ts. The runtime reads a plugin
// through this shape and never by its name, so taking one out is deleting its
// folder and its line in that list.
import type { ChannelKind } from "#chloe/channels/catalog";
import type { Connection } from "#chloe/connections/connection";
import type { Inbox } from "#chloe/core/mail";
import type { SettingsPart } from "#chloe/core/settings";
import type { ModelRoute } from "#chloe/model/model";
import type { Tools } from "#chloe/model/tool";
import type { Route } from "#chloe/serve/http";
import type { EmailProvider } from "#chloe/services/emailService";
import type { Ability } from "./abilities.ts";
import type { Agent } from "./load.ts";

/** One reply, as a plugin's words see it. */
export interface Reply {
  /** The tools this reply has, once its channel and who wrote it are counted. */
  tools: Tools;
  /** Whether a guest on a web channel wrote it. */
  guest: boolean;
  /** Who it is to, as `channel:id`, when it is a conversation with somebody. */
  user?: string;
}

/** One setting in a plugin's section of the Configuration page, shown the way the page's own are. */
export interface ConfigField {
  /** The setting, as a path with dots, like "connections.brave.api_key". */
  path: string;
  label: string;
  /** Words by default. A secret is pasted and goes into .env. A list is typed with commas between. */
  kind?: "words" | "secret" | "switch" | "choice" | "list" | "number";
  placeholder?: string;
  /** A line under it, saying what it does. */
  about?: string;
}

/** A feature chloe ships. Every field but `name` is optional. */
export interface Plugin {
  /** Its folder's name under plugins/, like `"self-improvement"`. */
  name: string;
  /**
   * Its settings: what each is when nobody says, which hold secrets, and the
   * words one may be. Their types are added to `Settings` (most often to
   * `Connections`) from the plugin's own folder.
   */
  settings?: SettingsPart;
  /**
   * The switches it adds to an agent's `abilities`, each with the tools it
   * makes. The name of each is added to `Abilities` from the plugin's own
   * folder, so it is typed in agent.ts only while the plugin is there.
   */
  abilities?: Ability[];
  /** The services it sends mail through, by the name `email.provider` gives each, like `{ resend: ... }`. */
  email?: Record<string, EmailProvider>;
  /**
   * The mailboxes an email channel can be on, by the name its `mailbox`
   * option gives each, like `{ gmail: ... }`, and the connection each works
   * through.
   */
  mailboxes?: Record<string, { inbox(): Inbox; needs?: Connection }>;
  /** The channels it ships, as the Channels page shows each: its name, the function that makes it, its plain options and its tokens. */
  channels?: ChannelKind[];
  /** Ways to reach a model it brings, each a program on this box on its own subscription. Their names go in its `settings.routes`. */
  modelRoutes?: ModelRoute[];
  /** Routes it answers on the one port, each the same entry as in `serve/http.ts`. */
  routes?: Route[];
  /** How it sends alerts: the first plugin in the list with this sends them all. */
  alerts?: {
    /** Whether alerts go out, in words for the startup log, like "on, to you@example.com". */
    say(): string;
    /** Sends one, or does nothing when it is not set up. */
    send(subject: string, body: string): Promise<void>;
  };
  /**
   * Its section of the Configuration page, under Connections: a title, a line
   * about it, and the settings it shows as a form. A panel of its own goes in
   * `site/plugins.ts`, under the plugin's name.
   */
  configuration?: { title: string; about?: string; fields: ConfigField[] };
  /** A section it adds to the purpose of every reply, or "" for none. */
  words?(agent: Agent, reply: Reply): string | Promise<string>;
  /** Where else a new agent made on the page can run, beside this computer. */
  places?: Place[];
}

/** Somewhere a new agent can run: a machine of its own that this copy makes, and shows through `serve.elsewhere`. */
export interface Place {
  /** What the page sends to pick it, like `"container"`. */
  name: string;
  /** How the page names it, like "A container". */
  label: string;
  /** One line on what the agent gets there. */
  about: string;
  /** Why it cannot be used here, in words, or "" when it can. */
  missing(): Promise<string>;
  /**
   * Makes the machine with the agent's files in it, and starts it. Hands back
   * how this copy reaches it, which becomes its `serve.elsewhere` entry. Leaves
   * nothing behind when it fails.
   */
  make(agent: { id: string; files: Record<string, string>; model: string }): Promise<{ address: string; key: string; start: string[] }>;
}
