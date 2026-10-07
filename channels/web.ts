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

/** What a web channel is made with: the sites that may show it, the tools a visitor's turn gets and what visitors may spend. */
export interface WebOptions {
  /** The sites that may show the chat box, each a scheme and a host: "https://myshop.com". A page anywhere else is refused. */
  origins: string[];
  /**
   * The only tools a web turn has, by the names the agent gives them. None when
   * unsaid. Its memory and self tools are refused, apart from
   * `memoryWriteUserNotes`, which a visitor's turn has without it being named
   * when the agent keeps `memoryPerUser`.
   */
  tools?: string[];
  /** What the box shows before anybody has written. */
  greeting?: string;
  limits?: WebLimits;
  /** How much of a visitor's conversation a turn is shown. */
  chatHistory?: ChatHistory;
  /** The model web turns use, when it is not the agent's own. */
  model?: string | SdkModel;
  /** Whether a visitor may send pictures. Off unless true. */
  pictures?: boolean;
}

/** What visitors may spend, each over the last 24 hours. A turn that would start past one is refused, politely. */
export interface WebLimits {
  /** For one visitor: 30 messages and $0.50 when unsaid. */
  perVisitor?: { messages?: number; dollars?: number };
  /** For every visitor together: $5 when unsaid. */
  perDay?: { dollars?: number };
}

/** A web channel's settings, with every default filled in. */
export interface Web {
  origins: string[];
  tools: string[];
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
 * The web channel. Throws as it is made when `origins` is empty or holds
 * something that is not a site, and as the agent loads when `tools` names one
 * of its memory or self tools. A tool the agent does not have is said in the
 * log and left out, the same as a connection that did not answer.
 */
export function webChannel(options: WebOptions): Channel & { web: Web } {
  const origins = (options.origins ?? []).map(originOf);
  if (!origins.length) throw new Error('webChannel needs origins: the sites that may show the chat box, like ["https://myshop.com"].');
  const web: Web = {
    origins,
    tools: options.tools ?? [],
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
    madeWith: JSON.stringify(web),
    web,
    check(agent) {
      for (const name of web.tools) {
        if (/^(memory|self)[A-Z]/.test(name)) {
          throw new Error(`its web channel cannot have ${name}. A visitor is a stranger, and what the agent remembers and its own files are not theirs.`);
        }
        if (name !== "skillRead" && !agent.tools?.[name]) {
          console.error(`${agent.id}: its web channel names ${name}, which it does not have, so a visitor's turn goes without it. It has: ${Object.keys(agent.tools ?? {}).join(", ") || "none"}.`);
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
