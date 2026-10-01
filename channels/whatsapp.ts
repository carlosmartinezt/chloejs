// Talking to an agent from WhatsApp. It is one entry in the agent's channels:
//
//   // agents/<name>/agent.ts
//   import { whatsappChannel } from "@chloejs/core/channels";
//   channels: [whatsappChannel({ allowFrom: ["+447700900123"] })],
//
// WhatsApp has no bot account. This links to a WhatsApp account the way the
// browser does, as one of its linked devices, so the account it answers as is
// the number that scanned it in. That number can be your own: nothing new is
// registered, the phone keeps working, and the agent is reached in the chat
// you have with yourself ("Message yourself" at the top of your contacts),
// which is the one chat on WhatsApp nobody else can see.
//
// It needs Baileys, which is not installed with chloe and is imported by name
// at run time, so a box without WhatsApp carries none of it:
//
//   npm install baileys
//
// It goes where chloe's own package is, which on a project that depends on
// chloe by path is that clone rather than the project: Node reads an import
// from where the file asking for it really sits.
//
// Read this before linking a number you care about. Baileys is not WhatsApp's
// own library: it speaks the protocol a linked device speaks, which WhatsApp
// changes without notice and does not support. An account can be blocked for
// behaving like a robot, and a blocked number is a real loss when it is the
// one your family writes to. A second number through WhatsApp's own Cloud API
// is the arrangement WhatsApp sells. This is the one that needs no second
// number.
//
// Linking is a pairing code, so nothing has to render a QR code in a terminal:
// put the number in settings.local.json as `"whatsapp": { "number": "+447700900123" }`,
// start chloe, and read the code out of the log. On the phone: WhatsApp,
// Settings, Linked devices, Link a device, "Link with phone number instead",
// and type the code. The link is then kept in `whatsapp/` inside the state
// folder and used on every start. It is as good as the account: back it up
// like a password, and never put it in a repository. A code lasts about a
// minute, and a new one is written to the log while the link is unmade, so
// restarting is never needed to get a fresh one.
//
// allowFrom is who may talk to the agent, by number in full international
// form ("+447700900123"). Your own number belongs in it: in the chat with
// yourself, you are the sender. Leave it empty only the first time, as with
// the other channels: until it has an entry, a private message is answered
// with the sender's id, which is what goes here.
//
// Several agents, one number. Every agent whose agent.ts names this channel
// shares the one link, because the account is the number and there is only
// one of it. A message reaches exactly one of them, and the first of these
// that applies decides:
//
//   1. an agent with a job waiting on an answer in this chat gets it;
//   2. a chat named in that agent's `chats` is that agent's own;
//   3. a message whose first word is an agent's name, or `calledBy`, goes to
//      that agent, with the word taken off: "tempo, how did the deploy go";
//   4. anything left goes to the agent with `default: true`, or to the only
//      agent there is.
//
// So the plain way to have one chat per agent on one number is a group per
// agent with nobody else in it, named for the agent and listed in its `chats`.
// The way with no groups at all is to write the agent's name first in the chat
// with yourself.
//
// What happens to a message once an agent has it (allowFrom, a job waiting on
// an answer, /commands, jobs that answer plain messages, groups, the chat) is
// channels/shared.ts, the same for every channel. This file reads WhatsApp,
// sends to it, and routes between the agents sharing the one account.
//
// Two differences from the other channels, both on purpose:
//
//   Nothing is marked read and no read receipt is sent, so a message the agent
//   answered is still bold on the phone and the person it came from cannot
//   tell a linked device read it.
//
//   A message sent while chloe was down is not answered when it comes back.
//   WhatsApp hands a device everything it missed, and on a first link that is
//   months of other people's conversations; anything sent before this process
//   started is read as history and left alone.
//
// A question from a job goes out as words with the answers listed, not as
// buttons: a button on WhatsApp is a business feature a linked device cannot
// send.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Agent, type Channel, type ChatHistory, type Running } from "#chloe/load/load";
import { ownedBy, reachBy, unreach } from "#chloe/model/ask";
import type { Attachment } from "#chloe/model/model";
import { settings } from "#chloe/core/settings";
import { STATE } from "#chloe/core/paths";
import { waitingOn } from "#chloe/core/steps";
import { inPieces, receive, type Incoming, type Rules } from "./shared.ts";

const MAX_MESSAGE = 4000; // WhatsApp takes far more, and a wall of text in a chat is unreadable.
const CODE_AGAIN = 55_000; // A pairing code lasts about a minute, so a new one is asked for after this.

/** How an agent is put on WhatsApp: who may reach it, and how it is picked out of the agents sharing the number. */
export interface WhatsAppOptions {
  /**
   * "whatsapp" unless the agent is on two accounts. It is what the log shows a
   * run came in on, and the start of every address on this account, like
   * "whatsapp:447700900123@s.whatsapp.net".
   */
  name?: string;
  /**
   * Which linked account, when this box links more than one number. It is the
   * folder the link is kept in, `whatsapp/<account>` inside the state folder,
   * and every agent naming the same one shares the one connection.
   */
  account?: string;
  /** The number to link, in full international form. Instead of the one in settings. */
  number?: string;
  /** Numbers that may reach the agent, in full international form. Your own belongs in it. */
  allowFrom?: string[];
  /**
   * The word that picks this agent out of the ones sharing the number, written
   * first in a message: "tempo, is the site up". The agent's own name unless
   * this says otherwise, and "@tempo" and "!tempo" count too.
   */
  calledBy?: string;
  /**
   * Chats that are this agent's alone, by group name or by the id a chat has
   * here ("447700900123@s.whatsapp.net", "1203...@g.us"). A group with nobody
   * else in it, named for the agent, is how one number holds a chat per agent.
   */
  chats?: string[];
  /** Takes the messages in a shared chat that name no agent. One agent per account can have it. */
  default?: boolean;
  /**
   * In a group, "when-addressed" (the default) answers only a message that
   * names the agent, mentions the linked number or replies to something it
   * said. "always" answers every message from someone in allowFrom.
   */
  inGroups?: "when-addressed" | "always";
  /** How much of a chat's conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Send what the model writes on its way to an answer as it writes it, not only the answer. Off unless true. */
  sendWhileWorking?: boolean;
  /** Which files are taken, and how big. Anything else is named to the agent but not handed over. */
  uploadPolicy?: { allowedMediaTypes?: string[]; maxBytes?: number };
  /** Where the link is kept. Empty means `whatsapp/<account>` inside the state folder. */
  session?: string;
  /** How the connection is made. Only the tests change it. */
  connect?: Connect;
}

/** The little of a WhatsApp connection this channel uses. Baileys' socket has all of it. */
export interface Socket {
  ev: { on(event: string, handler: (data: any) => void): void };
  user?: { id?: string | null } | null;
  sendMessage(to: string, content: { text: string }, options?: { quoted?: WaMessage; messageId?: string }): Promise<{ key?: { id?: string | null } } | undefined>;
  sendPresenceUpdate(state: "composing" | "paused" | "available" | "unavailable", to?: string): Promise<void>;
  requestPairingCode?(number: string): Promise<string>;
  groupMetadata?(chat: string): Promise<{ subject?: string | null }>;
  end?(error?: Error): void;
}

/** A connection, and how to fetch a file off a message that came in on it. */
export interface Link {
  socket: Socket;
  /** Whether this account has been linked already. False means a pairing code is wanted. */
  registered?: boolean;
  download?(message: WaMessage): Promise<Buffer>;
}

/** Opens a connection for one account. Baileys unless a test says otherwise. */
export type Connect = (account: { folder: string; number: string }) => Promise<Link | undefined>;

/** What this channel reads off a WhatsApp message. */
export interface WaKey {
  remoteJid?: string | null;
  /** The chat's id in its other form, when WhatsApp hides the number behind an alias. */
  remoteJidAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  /** In a group: who sent it. */
  participant?: string | null;
  participantAlt?: string | null;
}

interface Media {
  mimetype?: string | null;
  fileName?: string | null;
  caption?: string | null;
  fileLength?: number | { low?: number } | null;
}

export interface WaMessage {
  key: WaKey;
  messageTimestamp?: number | { low?: number } | null;
  pushName?: string | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null; contextInfo?: Context | null } | null;
    imageMessage?: (Media & { contextInfo?: Context | null }) | null;
    documentMessage?: (Media & { contextInfo?: Context | null }) | null;
    videoMessage?: Media | null;
    audioMessage?: Media | null;
  } | null;
}

interface Context {
  stanzaId?: string | null;
  participant?: string | null;
  mentionedJid?: string[] | null;
  quotedMessage?: WaMessage["message"] | null;
}

/** One agent on one account: how it is picked, and the rules it answers by. */
interface Bound {
  agentName: string;
  channel: string;
  agent: () => Agent | undefined;
  rules: Rules;
  calledBy: string;
  chats: string[];
  default: boolean;
  uploads: { allowedMediaTypes: string[]; maxBytes: number };
}

/** One linked number, shared by every agent that named it. */
interface Account {
  folder: string;
  number: string;
  connect: Connect;
  bound: Bound[];
  link?: Link;
  /** The linked number's own chat id, which is also the chat it has with itself. */
  me: string;
  /** Ids this process sent, so a reply coming back as an incoming message is not answered. */
  sent: Set<string>;
  /** The last few replies sent to each chat, in case a send went out under an id WhatsApp did not keep. */
  said: Map<string, string[]>;
  titles: Map<string, string>;
  /** The second this account was opened in. Anything older is history. */
  started: number;
  codeAsked: number;
  stopping: boolean;
  opening: boolean;
  tries: number;
}

const accounts = new Map<string, Account>();

/** An agent on WhatsApp, as a channel its own `agent.ts` names. */
export function whatsappChannel(options: WhatsAppOptions = {}): Channel {
  return {
    name: options.name ?? "whatsapp",
    chatHistory: options.chatHistory,
    madeWith: JSON.stringify(options),
    start(agent) {
      const name = agent()?.name ?? "";
      const channel = options.name ?? "whatsapp";
      const folder = options.session || join(STATE, "whatsapp", options.account ?? "default");
      const number = (options.number || settings.whatsapp.number || "").trim();
      if (!number && !linked(folder)) {
        console.error(
          `whatsapp: ${name} has a WhatsApp channel and there is no number to link. Put the number of the WhatsApp ` +
            `account it answers as in settings.local.json as "whatsapp": { "number": "+447700900123" }, and read the ` +
            `pairing code out of this log.`,
        );
        return { stop: () => {} };
      }
      const account = held(folder, number, options.connect);
      const bound: Bound = {
        agentName: name,
        channel,
        agent,
        rules: {
          allowFrom: options.allowFrom?.map(asNumber),
          inGroups: options.inGroups,
          chatHistory: options.chatHistory,
          sendWhileWorking: options.sendWhileWorking,
        },
        calledBy: (options.calledBy ?? name).toLowerCase(),
        chats: options.chats ?? [],
        default: options.default ?? false,
        uploads: {
          allowedMediaTypes: options.uploadPolicy?.allowedMediaTypes ?? ["image/*", "application/pdf", "text/*"],
          maxBytes: options.uploadPolicy?.maxBytes ?? 10 * 1024 * 1024,
        },
      };
      const clash = account.bound.find((one) => one.calledBy === bound.calledBy && one.agentName !== name);
      if (clash) {
        console.error(
          `whatsapp: ${clash.agentName} is already called ${bound.calledBy} on this number, so ${name} would never be ` +
            `picked. Give one of them calledBy.`,
        );
        return { stop: () => {} };
      }
      account.bound = [...account.bound.filter((one) => !(one.agentName === name && one.channel === channel)), bound];

      // A job of this agent's that stops to ask somebody reaches them in the
      // chat the address names. The answers are listed as words, because a
      // linked device cannot send buttons.
      reachBy(
        channel,
        (to, text, choices) => send(account, to, choices?.length ? `${text}\n\n${choices.map((one) => `• ${one}`).join("\n")}` : text),
        name,
      );
      // A private chat's id is the person's number, so the first allowed
      // person is reachable at it.
      const first = options.allowFrom?.[0];
      if (first) ownedBy(name, `${channel}:${chatOf(asNumber(first))}`);

      void start(account).catch((error) => console.error("whatsapp:", (error as Error).message));

      return {
        stop() {
          unreach(channel, name);
          account.bound = account.bound.filter((one) => !(one.agentName === name && one.channel === channel));
          // The last agent off the number closes it: a connection nobody
          // answers on would still be marked online on the account.
          if (account.bound.length === 0) {
            account.stopping = true;
            account.link?.socket.end?.();
            account.link = undefined;
            accounts.delete(account.folder);
          }
        },
      };
    },
  };
}

/** Whether this account has been linked: the files Baileys writes are there. */
function linked(folder: string): boolean {
  return existsSync(join(folder, "creds.json"));
}

function held(folder: string, number: string, connect?: Connect): Account {
  const have = accounts.get(folder);
  if (have) {
    if (number && have.number && asNumber(number) !== asNumber(have.number)) {
      console.error(`whatsapp: ${folder} is already linking ${have.number}, so ${number} is ignored. One number per account.`);
    }
    have.number ||= number;
    return have;
  }
  const account: Account = {
    folder,
    number,
    connect: connect ?? baileys,
    bound: [],
    me: "",
    sent: new Set(),
    said: new Map(),
    titles: new Map(),
    // Rounded down to the second, because that is all WhatsApp says about when
    // a message was sent: to the millisecond, a message written in the same
    // second as this line looks older than it.
    started: Math.floor(Date.now() / 1000) * 1000,
    codeAsked: 0,
    stopping: false,
    opening: false,
    tries: 0,
  };
  accounts.set(folder, account);
  return account;
}

/** Opens the connection, unless it is open or opening already. */
async function start(account: Account): Promise<void> {
  if (account.link || account.opening || account.stopping) return;
  account.opening = true;
  mkdirSync(account.folder, { recursive: true, mode: 0o700 });
  try {
    const link = await account.connect({ folder: account.folder, number: account.number });
    if (!link || account.stopping) return;
    account.link = link;
    watch(account, link);
  } finally {
    account.opening = false;
  }
}

/** Everything that comes up the connection: the link being made, it closing, and messages. */
function watch(account: Account, link: Link): void {
  const { socket } = link;
  socket.ev.on("connection.update", (update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
    if (update.qr && !link.registered) void code(account, link).catch((error) => console.error("whatsapp:", (error as Error).message));
    if (update.connection === "open") {
      account.tries = 0;
      account.me = asNumber(socket.user?.id ?? "");
      console.log(`whatsapp: linked as ${account.me || "a number it did not say"}, answering for ${account.bound.map((one) => one.agentName).join(", ")}.`);
    }
    if (update.connection === "close") void closed(account, update.lastDisconnect?.error);
  });
  socket.ev.on("messages.upsert", (upsert: { type?: string; messages?: WaMessage[] }) => {
    // "notify" is a message arriving. The other kinds are WhatsApp filling in
    // history, which is not something to answer.
    if (upsert.type !== "notify") return;
    for (const message of upsert.messages ?? []) {
      void onMessage(account, link, message).catch((error) => console.error("whatsapp:", (error as Error).message));
    }
  });
}

/** Asks WhatsApp for a pairing code and writes it to the log, at most one a minute. */
async function code(account: Account, link: Link): Promise<void> {
  if (!account.number || !link.socket.requestPairingCode) return;
  if (Date.now() - account.codeAsked < CODE_AGAIN) return;
  account.codeAsked = Date.now();
  const asked = await link.socket.requestPairingCode(asNumber(account.number).replace("+", ""));
  const shown = asked.length === 8 ? `${asked.slice(0, 4)}-${asked.slice(4)}` : asked;
  console.log(
    `whatsapp: to link ${account.number}, open WhatsApp on that phone, go to Settings, Linked devices, Link a device, ` +
      `"Link with phone number instead", and type ${shown}. It lasts about a minute, and another is written here while this is unlinked.`,
  );
}

/** The connection going down: linked again after a wait, unless the link itself is gone. */
async function closed(account: Account, error: unknown): Promise<void> {
  account.link = undefined;
  if (account.stopping || account.bound.length === 0) return;
  const status = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
  // 401 is the account saying this device is no longer linked, which no amount
  // of reconnecting fixes: somebody has to link it again.
  if (status === 401) {
    console.error(
      `whatsapp: ${account.number || account.folder} is not linked any more, so nothing will arrive. Delete ${account.folder} and ` +
        `start again to link it.`,
    );
    return;
  }
  const wait = Math.min(30_000, 2000 * 2 ** account.tries++);
  console.warn(`whatsapp: the connection closed${status ? ` (${status})` : ""}, opening it again in ${Math.round(wait / 1000)}s.`);
  await new Promise((done) => setTimeout(done, wait));
  await start(account);
}

/**
 * One message: whose it is, which agent it is for, and the reply.
 *
 * The guards at the top are what keeps a linked personal account from talking
 * to itself. In the chat with yourself every message is one you sent, the
 * agent's answers included, so an answer that came back as an incoming message
 * would be answered in turn, forever.
 */
async function onMessage(account: Account, link: Link, message: WaMessage): Promise<void> {
  const chat = message.key.remoteJid ?? "";
  if (!chat || chat === "status@broadcast" || chat.endsWith("@newsletter")) return;
  if (message.key.id && account.sent.has(message.key.id)) return;
  const group = chat.endsWith("@g.us");
  const mine = message.key.fromMe === true;
  const self = !group && asNumber(chat) === account.me && !!account.me;
  // My own message to somebody else, seen because a linked device sees
  // everything the phone sends. Not a message to the agent.
  if (mine && !group && !self) return;
  const when = Number(numberIn(message.messageTimestamp) ?? 0) * 1000;
  if (when && when < account.started) return;
  const text = textOf(message);
  const media = mediaOn(message);
  if (!text && !media) return;
  if (mine && (account.said.get(chat) ?? []).includes(text)) return;

  const sender = mine ? account.me : asNumber((group ? message.key.participantAlt || message.key.participant : message.key.remoteJidAlt || chat) ?? "");
  const title = group ? await titleOf(account, link, chat) : "";
  const picked = pick(account, { chat, title, text, group });
  if (!picked) {
    if (!group && account.bound.length > 1) {
      await send(account, chat, `Say which of us you mean first: ${account.bound.map((one) => one.calledBy).join(", ")}.`);
    }
    return;
  }
  const { bound, named } = picked;
  const agent = bound.agent();
  if (!agent) return;

  const context = message.message?.extendedTextMessage?.contextInfo ?? message.message?.imageMessage?.contextInfo ?? message.message?.documentMessage?.contextInfo;
  const quoted = context?.quotedMessage ? textOf({ key: {}, message: context.quotedMessage }) : "";
  const mentioned = (context?.mentionedJid ?? []).some((one) => asNumber(one) === account.me);
  const repliedToUs = !!context?.stanzaId && account.sent.has(context.stanzaId);

  const incoming: Incoming = {
    channel: bound.channel,
    chat,
    thread: `${bound.agentName}/${bound.channel}-${chat}`,
    from: { id: sender, name: (mine ? "" : message.pushName) || sender },
    text: picked.text,
    private: !group,
    addressed: named || mentioned || repliedToUs,
    chatTitle: title,
    replyTo: quoted,
    context: {
      chat_type: group ? "group" : self ? "self" : "private",
      ...(title ? { chat_title: title } : {}),
      ...(self ? { note: "This is the chat the linked number has with itself, so nobody else can see it." } : {}),
      is_mentioned: String(named || mentioned || repliedToUs),
    },
    files: async () => {
      const file = await fileOn(link, bound, message, media);
      return { attachments: file.attachment ? [file.attachment] : [], text: file.text, notes: file.note ? [file.note] : [] };
    },
  };

  const quote = group ? { quoted: message } : {};
  const handled = await receive(agent, incoming, bound.rules, {
    working: () => typing(account, chat),
    send: (words) => send(account, chat, words, quote),
  });
  if (handled?.text) {
    const buttons = handled.buttons?.length ? `\n\n${handled.buttons.map((one) => `• ${one.sends}`).join("\n")}` : "";
    await send(account, chat, handled.text + buttons, quote).catch((error) => console.error("whatsapp:", (error as Error).message));
  }
}

/**
 * Which agent a message is for, out of the ones sharing the number, and the
 * text it is handed. `named` is whether it was picked rather than handed what
 * was left, which is what makes it addressed in a group.
 */
function pick(
  account: Pick<Account, "bound">,
  message: { chat: string; title: string; text: string; group: boolean },
): { bound: Bound; text: string; named: boolean } | undefined {
  const { chat, title, text } = message;
  const waiting = account.bound.find((one) => waitingOn(`${one.channel}:${chat}`, one.agentName));
  if (waiting) return { bound: waiting, text, named: true };

  const word = text.trim().match(/^[@!]?([\p{L}\p{N}_-]+)[\s,:]*/u);
  const called = word && account.bound.find((one) => one.calledBy === word[1].toLowerCase());
  if (called) return { bound: called, text: text.trim().slice(word![0].length), named: true };

  const owns = account.bound.find((one) => one.chats.some((named) => same(named, chat) || (!!title && same(named, title))));
  if (owns) return { bound: owns, text, named: true };

  const rest = account.bound.find((one) => one.default) ?? (account.bound.length === 1 ? account.bound[0] : undefined);
  return rest && { bound: rest, text, named: false };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Sends a reply, in pieces, as WhatsApp's own formatting. */
async function send(account: Account, to: string, text: string, options: { quoted?: WaMessage } = {}): Promise<void> {
  const socket = account.link?.socket;
  if (!socket) throw new Error(`nothing is linked, so ${to} cannot be written to.`);
  for (const piece of inPieces(whatsappText(text), MAX_MESSAGE)) {
    // The id is made here and sent with the message, because the reply comes
    // back as an incoming message and knowing its id beforehand is what tells
    // the two apart. The words are kept as well, in case a version of the
    // library sends an id of its own.
    const id = randomBytes(12).toString("hex").toUpperCase();
    remember(account, to, id, piece);
    const sent = await socket.sendMessage(to, { text: piece }, { ...options, messageId: id });
    const theirs = sent?.key?.id;
    if (theirs && theirs !== id) remember(account, to, theirs, piece);
  }
}

/** What was sent, so it is not answered when it arrives back. The last few of each is enough. */
function remember(account: Account, to: string, id: string, text: string): void {
  account.sent.add(id);
  if (account.sent.size > 500) for (const oldest of account.sent) if (account.sent.delete(oldest)) break;
  const said = [...(account.said.get(to) ?? []), text].slice(-5);
  account.said.set(to, said);
}

/** Shows "typing..." until the returned function is called. */
function typing(account: Account, chat: string): () => void {
  const socket = account.link?.socket;
  const once = () => socket?.sendPresenceUpdate("composing", chat).catch(() => {});
  void once();
  const timer = setInterval(once, 8000);
  return () => {
    clearInterval(timer);
    void socket?.sendPresenceUpdate("paused", chat).catch(() => {});
  };
}

/** A group's name, asked for once and kept. */
async function titleOf(account: Account, link: Link, chat: string): Promise<string> {
  const have = account.titles.get(chat);
  if (have !== undefined) return have;
  const asked = await link.socket.groupMetadata?.(chat).catch(() => undefined);
  const title = asked?.subject ?? "";
  account.titles.set(chat, title);
  return title;
}

/** The words on a message, whichever kind it is. */
export function textOf(message: WaMessage): string {
  const body = message.message;
  return (
    body?.conversation ||
    body?.extendedTextMessage?.text ||
    body?.imageMessage?.caption ||
    body?.documentMessage?.caption ||
    body?.videoMessage?.caption ||
    ""
  );
}

/** The file on a message, as what it is called and what it is. */
function mediaOn(message: WaMessage): { kind: "image" | "document" | "video" | "audio"; media: Media } | undefined {
  const body = message.message;
  if (body?.imageMessage) return { kind: "image", media: body.imageMessage };
  if (body?.documentMessage) return { kind: "document", media: body.documentMessage };
  if (body?.videoMessage) return { kind: "video", media: body.videoMessage };
  if (body?.audioMessage) return { kind: "audio", media: body.audioMessage };
  return undefined;
}

/** The file on a message, fetched, or a line saying why it was not. */
async function fileOn(
  link: Link,
  bound: Bound,
  message: WaMessage,
  found: { kind: string; media: Media } | undefined,
): Promise<{ attachment?: Attachment; text?: string; note?: string }> {
  if (!found) return {};
  const { media } = found;
  const name = media.fileName || `${found.kind}.${(media.mimetype ?? "").split("/")[1]?.split(";")[0] || "bin"}`;
  const mediaType = (media.mimetype ?? "application/octet-stream").split(";")[0];
  const size = numberIn(media.fileLength) ?? 0;
  const wanted = bound.uploads.allowedMediaTypes.some((one) => (one.endsWith("/*") ? mediaType.startsWith(one.slice(0, -1)) : one === mediaType));
  if (!wanted) return { note: `(They sent ${name}, a ${mediaType}, which this channel does not take.)` };
  if (size > bound.uploads.maxBytes) return { note: `(They sent ${name}, which is over the ${Math.round(bound.uploads.maxBytes / 1048576)}MB this channel takes.)` };
  if (!link.download) return { note: `(They sent ${name}, and this connection cannot fetch files.)` };
  const bytes = await link.download(message);
  if (mediaType.startsWith("text/")) return { text: `<file name="${name}">\n${bytes.toString("utf8")}\n</file>` };
  return { attachment: { mediaType, data: bytes.toString("base64"), name }, note: `(Attached: ${name})` };
}

/** A number WhatsApp wrote as a count or as a long. */
function numberIn(value: number | { low?: number } | null | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value.low === "number") return value.low;
  return undefined;
}

/**
 * A chat id or a number as one way of writing it: "+447700900123". A chat id
 * that is an alias rather than a number (WhatsApp hides the number of somebody
 * who has asked it to) is handed back as it is, so it can still be allowed and
 * written to.
 */
export function asNumber(id: string): string {
  const user = id.split("@")[0].split(":")[0].trim();
  if (!id.includes("@")) return `+${user.replace(/[^\d]/g, "")}`;
  if (!id.endsWith("@s.whatsapp.net") && !id.endsWith("@c.us")) return id;
  return `+${user.replace(/[^\d]/g, "")}`;
}

/** The chat a number is written to. */
export function chatOf(number: string): string {
  return number.includes("@") ? number : `${number.replace(/[^\d]/g, "")}@s.whatsapp.net`;
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

/** The pieces of Baileys this channel uses. It is imported by name at run time, so it is installed only if it is wanted. */
interface Baileys {
  default: (config: Record<string, unknown>) => Socket;
  useMultiFileAuthState: (folder: string) => Promise<{ state: { creds?: { registered?: boolean } }; saveCreds: () => Promise<void> }>;
  downloadMediaMessage: (message: WaMessage, kind: "buffer", options: Record<string, unknown>) => Promise<Buffer>;
}

/**
 * A connection through Baileys, which is not a dependency of chloe: a box that
 * wants WhatsApp installs it, and one that does not is told what to install
 * rather than failing on an import nobody asked for.
 */
const baileys: Connect = async ({ folder }) => {
  // By a name rather than a literal, because this is the one import that is
  // allowed to be missing and tsc must not look for its types.
  const library = "baileys";
  const whatsapp = (await import(library).catch(() => undefined)) as Baileys | undefined;
  if (!whatsapp) {
    console.error("whatsapp: Baileys is not installed, so nothing can connect. Run `npm install baileys` where chloe runs.");
    return undefined;
  }
  const { state, saveCreds } = await whatsapp.useMultiFileAuthState(folder);
  const socket = whatsapp.default({
    auth: state,
    // The phone keeps the notifications: a linked device that marks itself
    // online stops them, which on somebody's own number is the whole account
    // behaving differently because an agent is listening.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
    browser: ["chloe", "Chrome", "1.0.0"],
    logger: quiet(),
  });
  socket.ev.on("creds.update", () => void saveCreds());
  return {
    socket,
    registered: state.creds?.registered === true,
    download: (message) => whatsapp.downloadMediaMessage(message, "buffer", {}),
  };
};

/** Baileys wants a logger. Its own writes every frame to the console. */
function quiet(): unknown {
  const nothing = () => {};
  const logger: Record<string, unknown> = { level: "silent", trace: nothing, debug: nothing, info: nothing, warn: nothing, error: nothing, fatal: nothing };
  logger.child = () => logger;
  return logger;
}
