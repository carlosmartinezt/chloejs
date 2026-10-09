// A chat box on a web page, for the people who visit it.
//
//   // agents/<id>/agent.ts
//   import { webChannel } from "@chloejs/core/channels";
//   channels: [webChannel({ origins: ["https://myshop.com"], tools: ["getOrders"] })],
//
// Nothing reaches it unless the site's own server lets it in. That server
// holds a token made for this one agent, gives each visitor an id of its own,
// and asks for a pass for them:
//
//   POST /api/agents/<id>/web/pass   {"visitor": "v-3f9a", "facts": {"plan": "pro"}}
//
// It hands the pass to its page, and the page talks to the agent with it,
// through an address the site's proxy sends on to this runtime, here
// agent.myshop.com:
//
//   <script src="https://agent.myshop.com/api/web/chat.js" data-agent="shop" data-pass="/api/chat-pass" async></script>
//
// Like apiChannel() it listens to nothing: the routes under
// /api/agents/<id>/web/ are answered by the server, in serve/web.ts, and this
// is the permission and the settings.
//
// A visitor is a stranger, so a web turn gets almost nothing: the tools named
// here and no others, no /command but /clear, no model picking, and never a
// sign-in. What visitors may spend is capped, per visitor and for everybody
// together, read off the run record. The model is told who it is talking to in
// `<web_context>`: when they first came, their country and browser, and the
// facts the site sent. Their address is kept, and never shown to the model.
//
// A job asks a visitor with `web:<visitor>`. The question is put in their
// conversation, and the box shows it the next time it loads it.
import type { Agent, Channel, ChatHistory } from "#chloe/load/load";
import { nameOf, type SdkModel } from "#chloe/model/key";
import { remember } from "#chloe/model/memory";
import { reachBy, unreach } from "#chloe/model/ask";
import type { ChloeTool } from "#chloe/model/tool";
import { bind, type Answering } from "./shared.ts";

/** The options for `webChannel()`: the sites that may show the chat box, the tools visitors get, and what they may spend. */
export interface WebOptions {
  /**
   * The websites that may show the chat box, each a scheme and a host with
   * no path, like "https://myshop.com". A page on any other site is refused.
   * Required.
   */
  origins: string[];
  /**
   * The only tools the agent may use when it replies to a visitor. Give each
   * one as the tool itself or as its name in the agent's `tools`. Default:
   * none.
   *
   * A visitor is a stranger, so unlike other channels the agent does not keep
   * its memory tools or skills here unless you name them. Naming a memory or
   * self tool stops the agent from loading. When the agent has
   * `memoryPerUser` on, a visitor's reply also gets `memoryWriteUserNotes`,
   * for the agent's note on that visitor.
   */
  tools?: (ChloeTool | string)[];
  /** A job that every visitor's message starts, in place of a normal reply. See `Answering`. */
  job?: Answering["job"];
  /** What the chat box shows before anybody has written. Default: nothing. */
  greeting?: string;
  /**
   * What visitors may spend. See `WebLimits`. Default: 30 messages and $0.50
   * for each visitor, and $5 for all visitors together, each over the last
   * 24 hours.
   */
  limits?: WebLimits;
  /**
   * How much of a visitor's conversation the agent sees with each new
   * message: `{ messages, days }`. Default: the last 10 messages.
   */
  chatHistory?: ChatHistory;
  /**
   * The model to use when the agent replies to a visitor, as a name or an AI
   * SDK model. If not set, the agent's own model.
   */
  model?: string | SdkModel;
  /** Lets a visitor send pictures, up to 2 in one message. Off by default. */
  pictures?: boolean;
}

/**
 * What visitors may spend, counted over the last 24 hours. Once a limit is
 * reached, new messages are refused with a polite note.
 *
 * The dollar limits use the cost recorded for each run. A model whose runs
 * record no cost is never stopped by a dollar limit.
 */
export interface WebLimits {
  /** For each visitor: the most messages, and the most dollars. Default: 30 messages and $0.50. */
  perVisitor?: { messages?: number; dollars?: number };
  /** For all visitors together: the most dollars. Default: $5. */
  perDay?: { dollars?: number };
}

/** A web channel's settings, with every default filled in. */
export interface Web {
  origins: string[];
  /** By name, read against the agent as it loads. */
  tools: string[];
  /** The id of the job every message starts, when there is one. */
  job?: string;
  greeting: string;
  limits: { perVisitor: { messages: number; dollars: number }; perDay: { dollars: number } };
  chatHistory?: ChatHistory;
  model?: string;
  pictures: boolean;
}

/** The thread a visitor's conversation is kept under. Not `web-`, which is what the dashboard's own chats were called. */
export function visitorThread(agent: string, visitor: string): string {
  return `${agent}/visitor-${visitor}`;
}

/**
 * Puts a chat box for visitors on your website. Add it to the `channels` list
 * in the agent's `agent.ts`:
 *
 * ```ts
 * channels: [webChannel({ origins: ["https://myshop.com"], tools: ["getOrders"] })],
 * ```
 *
 * Nothing reaches it unless your site's own server lets the visitor in. Your
 * server holds a token made for this agent, asks
 * `POST /api/agents/<id>/web/pass` for a pass for each visitor, and gives the
 * pass to its page. The page loads the chat box from `/api/web/chat.js`.
 *
 * A visitor is a stranger. Their messages get only the tools named in
 * `tools`, no `/commands` apart from `/clear`, no model picking, and never a
 * sign-in. What they may spend is limited by `limits`.
 *
 * Throws when `origins` is empty or holds something that is not a site. The
 * agent does not load when `tools` names a memory or self tool. A tool name
 * the agent does not have is skipped, with a line in the log.
 */
export function webChannel(options: WebOptions): Channel & { web: Web } {
  const origins = (options.origins ?? []).map(originOf);
  if (!origins.length) throw new Error('webChannel needs origins: the sites that may show the chat box, like ["https://myshop.com"].');
  const web: Web = {
    origins,
    tools: (options.tools ?? []).map((one) => (typeof one === "string" ? one : "(a tool)")),
    job: options.job?.id,
    greeting: options.greeting ?? "",
    limits: {
      perVisitor: { messages: 30, dollars: 0.5, ...options.limits?.perVisitor },
      perDay: { dollars: 5, ...options.limits?.perDay },
    },
    chatHistory: options.chatHistory,
    model: options.model === undefined ? undefined : nameOf(options.model),
    pictures: options.pictures === true,
  };
  return {
    name: "web",
    chatHistory: web.chatHistory,
    get madeWith() {
      return JSON.stringify(web);
    },
    job: options.job,
    web,
    check(agent) {
      web.tools = bind(agent, "web", { tools: options.tools ?? [] }).tools ?? [];
      for (const name of web.tools) {
        if (/^(memory|self)[A-Z]/.test(name)) {
          throw new Error(`its web channel cannot have ${name}. A visitor is a stranger, and what the agent remembers and its own files are not theirs.`);
        }
      }
    },
    start(agent) {
      const id = agent()?.id;
      if (!id) return { stop: () => {} };
      // A question from a job waits in the visitor's conversation, where the
      // box finds it, because a page cannot be reached until it asks.
      reachBy(
        "web",
        async (to, text, choices) => remember(visitorThread(id, to), "assistant", choices?.length ? `${text}\n\n${choices.map((one) => `- ${one}`).join("\n")}` : text),
        id,
      );
      return { stop: () => unreach("web", id) };
    },
  };
}

/** An agent's web channel's settings, or undefined when it has none. */
export function webOf(agent: Pick<Agent, "channels">): Web | undefined {
  return (agent.channels.find((one) => one.name === "web") as (Channel & { web?: Web }) | undefined)?.web;
}

/** A site as a browser names it in Origin, or a throw saying what was wrong. */
function originOf(said: string): string {
  let url: URL;
  try {
    url = new URL(said);
  } catch {
    throw new Error(`webChannel: ${JSON.stringify(said)} is not a site. Write it as "https://myshop.com".`);
  }
  if (!/^https?:$/.test(url.protocol) || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`webChannel: ${JSON.stringify(said)} is not a site. Write it as "https://myshop.com", with no path.`);
  }
  return url.origin;
}
