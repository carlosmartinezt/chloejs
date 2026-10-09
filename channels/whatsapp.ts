// Talking to an agent from WhatsApp, through WhatsApp's own API. It is one
// entry in the agent's channels:
//
//   // agents/<id>/agent.ts
//   import { whatsappChannel } from "@chloejs/core/channels";
//   channels: [whatsappChannel({ allowFrom: ["+447700900123"] })],
//
// It needs nothing installed, and nothing open on this box. The number it
// answers as is one registered with Meta, and it cannot be a number that is
// already in the WhatsApp app.
//
// Setting it up, at developers.facebook.com: make an app, add WhatsApp to it,
// and it gives you a test number and a token to try with. The three things
// this needs go in .env, and each is named in chloe.config.ts's settings, as
// `agents: { <id>: { whatsapp: { phone_number_id: process.env.CHLOE_AGENTS_<id>_WHATSAPP_PHONE_NUMBER_ID, ... } } }`:
//
//   phone_number_id   on the app's WhatsApp page
//   token             a permanent token from a system user
//   app_secret        signs every call in
//
// The token the app's page shows first lasts a day, which is fine for trying
// and no good for a box that runs: make a system user with the
// whatsapp_business_messaging permission and take a permanent token from that.
//
// Then point the app at an address. Meta posts each message once and has
// nothing to fetch one with, so that address has to be public, and this box is
// not: the runtime is never the public half of a connection.
//
// Two ways, and neither needs anything you did not choose:
//
// With no remote dashboard, the route this channel answers on the one port,
// `/chloe/v1/<id>/<channel name>`, is the address: reached through a web server
// of your own that passes that one path on, the way a web chat is.
//
// With a remote dashboard connected (`dashboard.remote.api_key`), or a
// `postBox` named, there is a **post box**. On start this asks `postBox` for one of its own,
// writes the address it was given to the log, and then collects from it with one
// request held open at a time, the way Telegram is polled. Paste that address
// into the app's WhatsApp page and nothing here is ever reached from outside.
// Each delivery is sealed to a key made here, so what holds it cannot read it,
// and Meta's signature travels with it and is checked below against the app
// secret, so what holds it cannot make one up either. `dashboard.remote.url` in settings is
// where a box is asked for when `postBox` does not say.
//
// `postBox: ""` turns the post box off even with a remote dashboard. The route
// sits outside the login, so:
//
//   Every POST is checked against app_secret before it is read, and one that
//   does not match is refused without a word about why. Without an app_secret
//   nothing is accepted at all, because an address anybody can post a message
//   to is an agent anybody can talk to.
//
//   Meta checks the address once with a GET carrying a word you chose. That
//   word is `verifyToken`, or one made on start and written to the log.
//
// allowFrom is who may talk to the agent, by number in full international form
// ("+447700900123"). Leave it empty only the first time: until it has an
// entry, a message is answered with the sender's number, which is what goes
// here.
//
// Two things about WhatsApp's rules, both worth knowing before a job sends
// anything:
//
//   A reply has to be inside 24 hours of the last message that person sent. A
//   job that stops to ask somebody who has not written today is refused by
//   WhatsApp, not by this, and the error says so. Answering a conversation
//   always works, which is what a channel is mostly for.
//
//   There are no groups. The API delivers one-to-one messages and nothing
//   else, so there is no `inGroups` here and every message is private.
//
// A question from a job goes out with its answers as buttons when there are
// three or fewer, and as words to type when there are more.
//
// What happens to a message once it is read (allowFrom, a job waiting on an
// answer, /commands, jobs that answer plain messages, the chat) is
// channels/shared.ts, the same for every channel. This file reads WhatsApp's
// API, sends to it, and nothing else.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Agent, Channel, ChannelRoute, ChatHistory, Running } from "#chloe/load/load";
import { ownedBy, reachBy, unreach } from "#chloe/model/ask";
import type { Attachment } from "#chloe/model/model";
import { nameInEnv, settings, whereKeyGoes } from "#chloe/core/settings";
import { boxFor, collectFrom, keptBox } from "./postbox.ts";
import { type Bound, type Button, defineChannel, type Incoming, inPieces, receive, rulesOf, type Shared } from "./shared.ts";

const MAX_MESSAGE = 4000; // WhatsApp refuses a text body over 4096.
const MAX_BUTTONS = 3; // What the API takes on one message.
const BUTTON_LABEL = 20; // Characters it takes on one button.
const MAX_BODY = 1024; // Characters it takes on a message that has buttons.
const TYPING = 20_000; // WhatsApp clears "typing..." after 25 seconds.

/** How an agent is put on WhatsApp's own API: who may reach it, and where its messages arrive. */
export interface WhatsAppOptions extends Shared {
  /**
   * "whatsapp" unless the agent is on two numbers. It is what the log shows
   * a run came in on, the end of the address Meta sends to, and the start of
   * every address on this number, like "whatsapp:+447700900123".
   */
  name?: string;
  /** Instead of the three in settings. `verifyToken` is the word Meta is told to check the address with. */
  credentials?: { phoneNumberId?: string; token?: string; appSecret?: string; verifyToken?: string };
  /** Numbers that may reach the agent, in full international form. */
  allowFrom?: string[];
  /**
   * The post box to collect messages from: a service that takes Meta's
   * delivery, because Meta pushes and never lets anything fetch, and holds it
   * sealed until this runtime asks. `dashboard.remote.url` in settings when a
   * remote dashboard is connected, and nowhere otherwise, which leaves only the
   * route below, reached through a web server of your own. "" collects from
   * nowhere even with a remote dashboard.
   */
  postBox?: string;
  /** Where this server is reachable from outside, like "https://agents.example.com". Only used to say the address to register. */
  publicUrl?: string;
  /** How much of a conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Send what the model writes on its way to an answer as it writes it, not only the answer. Off unless true. */
  sendWhileWorking?: boolean;
  /** Which files are taken, and how big. Anything else is named to the agent but not handed over. */
  uploadPolicy?: { allowedMediaTypes?: string[]; maxBytes?: number };
  /** Which version of the API to call. */
  version?: string;
  /** Where the API is. Only the tests change it. */
  api?: string;
}

/** What this channel reads off one message in what Meta posts. */
interface WhatsAppMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: Media;
  document?: Media;
  audio?: Media;
  video?: Media;
  sticker?: Media;
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  button?: { text?: string };
  context?: { id?: string; from?: string };
  errors?: { code?: number; title?: string }[];
}

interface Media {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
  sha256?: string;
}

interface Posted {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

/**
 * Where this agent's messages are collected from, for a page to show: the post
 * box address it was given, or "" before it has asked for one or when it is
 * collecting from nowhere. The address is not a secret: posting to it is the
 * point, and collecting from it needs the key kept beside it.
 */
export function collectsAt(agent: string, channel = "whatsapp"): string {
  return keptBox("whatsapp", agent, channel)?.at ?? "";
}

/** An agent on WhatsApp's own API, as a channel its own `agent.ts` names. */
export function whatsappChannel(options: WhatsAppOptions = {}): Channel {
  return defineChannel("whatsapp", options, ({ agent, agentId, name, bound }) => {
    const held = settings.agents[agentId]?.whatsapp;
    const phoneNumberId = options.credentials?.phoneNumberId || held?.phone_number_id || "";
    const token = options.credentials?.token || held?.token || "";
    const appSecret = options.credentials?.appSecret || held?.app_secret || "";
    if (!phoneNumberId || !token) {
      console.error(
        `whatsapp: ${agentId} is on WhatsApp's API and has no ${phoneNumberId ? "token" : "number"}. Add an app at ` +
          `developers.facebook.com, add WhatsApp to it, and put the number's id ` +
          `${whereKeyGoes(["agents", agentId, "whatsapp", "phone_number_id"])}, and its token and app secret beside it.`,
      );
      return { stop: () => {} };
    }
    return listen({ ...options, agentId, channel: name, bound, phoneNumberId, token, appSecret, verifyToken: options.credentials?.verifyToken, agent });
  });
}

/** Answers one number until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: Omit<WhatsAppOptions, "name" | "credentials"> & {
    /** The agent's id. */
    agentId: string;
    /** The channel's name, "whatsapp" when left out. */
    channel?: string;
    phoneNumberId: string;
    token: string;
    appSecret: string;
    verifyToken?: string;
    agent: () => Agent | undefined;
    /** Its `tools` and `job`, read against the agent as it loaded. */
    bound?: Bound;
  },
): Running {
  const { agentId, phoneNumberId, token, appSecret } = options;
  const channel = options.channel ?? "whatsapp";
  const api = options.api ?? "https://graph.facebook.com";
  const version = options.version ?? "v23.0";
  const path = `/chloe/v1/${agentId}/${channel}`;
  // The dashboard's post box only when one is connected: nothing is sent through
  // a service the owner did not choose.
  const postBox = (options.postBox ?? (settings.dashboard.remote.api_key ? settings.dashboard.remote.url : "")).replace(/\/+$/, "");
  const verify = options.verifyToken || randomBytes(12).toString("hex");
  const allowedTypes = options.uploadPolicy?.allowedMediaTypes ?? ["image/*", "application/pdf", "text/*"];
  const maxBytes = options.uploadPolicy?.maxBytes ?? 10 * 1024 * 1024;
  const rules = rulesOf(options, options.allowFrom?.map(asNumber));

  if (!appSecret) {
    console.error(
      `whatsapp: ${agentId} has no app_secret, so every message posted to ${path} is refused. It is the only thing ` +
        `telling a message from WhatsApp apart from a message from anybody who found the address. It is on the app's ` +
        `settings page at developers.facebook.com.`,
    );
  }
  // Only worth saying when nothing is being collected: otherwise the post box's
  // address is the one to register, and it is said once the box is known.
  if (!postBox) {
    console.log(
      `whatsapp: ${agentId} answers ${options.publicUrl ? `${options.publicUrl.replace(/\/+$/, "")}${path}` : path}. ` +
        `Register that address on the app's WhatsApp page, subscribed to messages, with ${verify} as the word it checks.`,
    );
  }

  /** One call to the API. `where` is what it is for, so a failure says which call failed. */
  async function call<T>(to: string, body: object, where: string): Promise<T> {
    const response = await fetch(`${api}/${version}/${to}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    // WhatsApp's own refusals are the ones worth reading out loud: 131047 is
    // the 24 hour rule, and it reads as "message failed to send" otherwise.
    if (!response.ok || answer.error) {
      throw new Error(`${where}: ${answer.error?.message ?? response.status}${answer.error?.code ? ` (${answer.error.code})` : ""}`);
    }
    return answer as T;
  }

  /** A number as WhatsApp names one: the digits, which is the form it hands out. */
  const digits = (who: string) => who.replace(/[^\d]/g, "");

  /** Sends words to a number, in pieces, as WhatsApp's own formatting. */
  async function send(to: string, text: string): Promise<void> {
    for (const piece of inPieces(whatsappText(text), MAX_MESSAGE)) {
      await call(
        `${phoneNumberId}/messages`,
        { messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), type: "text", text: { body: piece, preview_url: false } },
        "sending",
      );
    }
  }

  /**
   * Sends words with up to three buttons under them. A button carries what it
   * sends as its id, so pressing one is the same as writing it.
   */
  async function sendButtons(to: string, text: string, buttons: Button[]): Promise<void> {
    await call(
      `${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: digits(to),
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: whatsappText(text).slice(0, MAX_BODY) },
          action: { buttons: buttons.map((one, i) => ({ type: "reply", reply: { id: `b${i}:${one.sends}`.slice(0, 256), title: one.label.slice(0, BUTTON_LABEL) } })) },
        },
      },
      "sending buttons",
    );
  }

  /**
   * Buttons when they fit, words when they do not. A long answer cannot carry
   * them: the API takes 1024 characters on a message that has buttons, and
   * losing the end of what the agent said is worse than typing a word back.
   */
  async function reply(to: string, text: string, buttons: Button[] = []): Promise<void> {
    const fits =
      buttons.length > 0 &&
      buttons.length <= MAX_BUTTONS &&
      buttons.every((one) => one.label.length <= BUTTON_LABEL) &&
      whatsappText(text).length <= MAX_BODY;
    if (fits) return await sendButtons(to, text, buttons);
    const listed = buttons.length ? `${text}\n\n${buttons.map((one) => `• ${one.sends}`).join("\n")}` : text;
    await send(to, listed);
  }

  // A job of this agent's that stops to ask somebody reaches them at their
  // number. An answer that can be listed is a button.
  reachBy(channel, (to, text, choices) => reply(to, text, (choices ?? []).map((one) => ({ label: one, sends: one }))), agentId);
  if (options.allowFrom?.[0]) ownedBy(agentId, `${channel}:${asNumber(options.allowFrom[0])}`);

  /** Marks the message read and shows "typing...", until the returned function is called. */
  function typing(id: string): () => void {
    const once = () =>
      call(`${phoneNumberId}/messages`, { messaging_product: "whatsapp", status: "read", message_id: id, typing_indicator: { type: "text" } }, "typing").catch(() => {});
    void once();
    const timer = setInterval(once, TYPING);
    return () => clearInterval(timer);
  }

  function wanted(mediaType: string): boolean {
    return allowedTypes.some((one) => (one.endsWith("/*") ? mediaType.startsWith(one.slice(0, -1)) : one === mediaType));
  }

  /** The file on a message, fetched in two calls, or a line saying why it was not. */
  async function fileOn(message: WhatsAppMessage): Promise<{ attachment?: Attachment; text?: string; note?: string }> {
    const media = message.image ?? message.document ?? message.video ?? message.audio ?? message.sticker;
    if (!media?.id) return {};
    const mediaType = (media.mime_type ?? "application/octet-stream").split(";")[0];
    const fileName = media.filename ?? `${message.type ?? "file"}.${mediaType.split("/")[1] || "bin"}`;
    if (!wanted(mediaType)) return { note: `(They sent ${fileName}, a ${mediaType}, which this channel does not take.)` };
    const where = await fetch(`${api}/${version}/${media.id}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const found = (await where.json().catch(() => ({}))) as { url?: string; file_size?: number };
    if (!found.url) return { note: `(They sent ${fileName}, and it could not be fetched.)` };
    if ((found.file_size ?? 0) > maxBytes) return { note: `(They sent ${fileName}, which is over the ${Math.round(maxBytes / 1048576)}MB this channel takes.)` };
    // The address the API hands back needs the token too, and it is good for a few minutes.
    const file = await fetch(found.url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (mediaType.startsWith("text/")) return { text: `<file name="${fileName}">\n${bytes.toString("utf8")}\n</file>` };
    return { attachment: { mediaType, data: bytes.toString("base64"), filename: fileName }, note: `(Attached: ${fileName})` };
  }

  /** The words on a message, whichever kind it is. A pressed button sends what it carried. */
  function textOf(message: WhatsAppMessage): string {
    const pressed = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (pressed?.id) return pressed.id.replace(/^b\d+:/, "");
    if (pressed?.title) return pressed.title;
    return message.text?.body ?? message.button?.text ?? message.image?.caption ?? message.document?.caption ?? message.video?.caption ?? "";
  }

  /** One message in the words every channel shares. The rest is receive()'s. */
  function incoming(message: WhatsAppMessage, who: string, said: string): Incoming {
    const from = asNumber(message.from ?? "");
    return {
      channel,
      chat: from,
      thread: `${agentId}/${channel}-${from}`,
      from: { id: from, name: who || from },
      text: said,
      // The API carries one-to-one messages and nothing else.
      private: true,
      addressed: true,
      replyTo: "",
      context: { chat_type: "private" },
      files: async () => {
        const file = await fileOn(message);
        return { attachments: file.attachment ? [file.attachment] : [], text: file.text, notes: file.note ? [file.note] : [] };
      },
    };
  }

  async function onMessage(message: WhatsAppMessage, who: string): Promise<void> {
    const agent = options.agent();
    const from = message.from;
    if (!agent || !from) return;
    // A message WhatsApp could not read for us, which is usually an
    // unsupported kind rather than anything this can fix.
    if (message.errors?.length) {
      console.warn(`whatsapp: ${from} sent something that did not arrive whole: ${message.errors[0].title ?? message.errors[0].code}`);
    }
    const said = textOf(message);
    const has = message.image ?? message.document ?? message.video ?? message.audio ?? message.sticker;
    if (!said && !has) return;
    const handled = await receive(agent, incoming(message, who, said), rules, {
      working: () => (message.id ? typing(message.id) : () => {}),
      send: (words) => send(from, words),
    });
    if (handled?.text) await reply(from, handled.text, handled.buttons).catch((error) => console.error("whatsapp:", (error as Error).message));
  }

  /**
   * Meta checking the address before it sends anything to it: the word it was
   * given comes back, and nothing else does.
   */
  function checked(response: ServerResponse, url: URL): void {
    const asked = url.searchParams;
    if (asked.get("hub.mode") !== "subscribe" || asked.get("hub.verify_token") !== verify) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end(asked.get("hub.challenge") ?? "");
  }

  /** Whether a body really came from the app it says it did. */
  function signed(raw: string, header: string | string[] | undefined): boolean {
    if (!appSecret) return false;
    const sent = String(header ?? "").replace(/^sha256=/, "");
    const mine = createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
    const a = Buffer.from(sent, "hex");
    const b = Buffer.from(mine, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Message ids already dealt with, so one handed over twice is answered once. */
  const seen = new Set<string>();

  /**
   * One delivery from Meta, however it got here: the body exactly as Meta wrote
   * it and the signature that came with it. The signature is checked against
   * the app secret, so a post box in the middle is not trusted with anything.
   *
   * Returns false when the signature did not match, which is the only thing a
   * caller needs to know.
   */
  async function delivered(raw: string, signature: string | string[] | undefined): Promise<boolean> {
    if (!signed(raw, signature)) return false;
    let posted: Posted;
    try {
      posted = JSON.parse(raw) as Posted;
    } catch {
      return true;
    }
    for (const entry of posted.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages?.length) continue; // A delivery or read receipt, which is not a message.
        // One app can hold several numbers and posts them all to one address,
        // so a message for another agent's number is not this one's.
        const to = value.metadata?.phone_number_id;
        if (to && to !== phoneNumberId) continue;
        const names = new Map((value.contacts ?? []).map((one) => [one.wa_id ?? "", one.profile?.name ?? ""]));
        for (const message of value.messages) {
          if (message.id) {
            if (seen.has(message.id)) continue;
            seen.add(message.id);
            if (seen.size > 500) for (const oldest of seen) if (seen.delete(oldest)) break;
          }
          await onMessage(message, names.get(message.from ?? "") ?? "").catch((error) => console.error("whatsapp:", error));
        }
      }
    }
    return true;
  }

  const webhook = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET") return void checked(response, url);

    let raw = "";
    for await (const chunk of request) raw += chunk;
    // Always 200 once it is signed: anything else makes WhatsApp send the same
    // message again, and again, for a day.
    const ours = signed(raw, request.headers["x-hub-signature-256"]);
    response.writeHead(ours ? 200 : 401).end();
    if (ours) await delivered(raw, request.headers["x-hub-signature-256"]);
  };

  const route: ChannelRoute = { path, methods: ["GET", "POST"], handle: webhook };
  const stopping = new AbortController();
  if (postBox) void collect().catch((error) => console.error("whatsapp:", (error as Error).message));

  return {
    routes: [route],
    stop() {
      stopping.abort();
      unreach(channel, agentId);
    },
  };

  /** Collects from this number's post box until stopped. Where it is goes to the log, to be pasted into the app. */
  async function collect(): Promise<void> {
    const box = await boxFor("whatsapp", agentId, channel, postBox);
    console.log(
      `whatsapp: ${agentId} collects from ${box.at}. Register that address on the app's WhatsApp page at ` +
        `developers.facebook.com, subscribed to messages.`,
    );
    await collectFrom(box, {
      label: `whatsapp: ${agentId}`,
      signal: stopping.signal,
      open: async (body, signature) => {
        if (!(await delivered(body, signature))) console.warn(`whatsapp: a message from the post box was not signed by the app, and was dropped.`);
      },
    });
  }
}

/** A number as one way of writing it: "+447700900123", however it was typed. */
export function asNumber(number: string): string {
  return `+${number.replace(/[^\d]/g, "")}`;
}

/**
 * Markdown as WhatsApp's own formatting, which is *bold*, _italics_, ~struck~,
 * `code` and ```a code block```. A heading becomes a bold line, a list item
 * starts with a bullet, and a link becomes its words with the address after
 * them, since WhatsApp shows an address as a link by itself.
 */
export function whatsappText(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(lines[i]);
      out.push(`\`\`\`\n${code.join("\n")}\n\`\`\``);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`*${inline(line.replace(/^#+\s*/, "").replace(/\*\*/g, ""))}*`);
    } else {
      out.push(inline(line.replace(/^(\s*)[-*]\s/, "$1• ")));
    }
  }
  return out.join("\n");
}

/** One line's formatting. Code and links are put aside first so nothing inside them is read as bold. */
function inline(line: string): string {
  const kept: string[] = [];
  const keep = (text: string) => `\u0000${kept.push(text) - 1}\u0000`;
  return line
    .replace(/`([^`]+)`/g, (_, code: string) => keep(`\`${code}\``))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, words: string, to: string) => keep(`${words} (${to})`))
    .replace(/\*\*(.+?)\*\*/g, (_, words: string) => keep(`*${words}*`))
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}
