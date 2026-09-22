// Talking to an agent from Telegram. It is one entry in the agent's channels:
//
//   // agents/<name>/agent.ts
//   import { telegramChannel } from "@chloejs/core/channels";
//   channels: [telegramChannel({ allowFrom: [111111111] })],
//
// The bot's token is TELEGRAM_BOT_TOKEN, or `credentials: { botToken }`. To
// make a bot, message @BotFather in Telegram, send /newbot, and pick a name
// and a username. It replies with the token.
//
// allowFrom is who may talk to the agent, by Telegram user id, in any chat,
// including a group made later. Anyone can find a bot and message it, so
// leave it empty only the first time: until it has an entry, the bot answers a
// private message with the sender's user id, which is what goes here. The
// first id is also who the agent's jobs ask when they name nobody.
//
// Two ways for messages to arrive, and `mode` picks:
//
//   "polling"  chloe asks Telegram for them. Nothing is exposed, and a message
//              sent while chloe is down is picked up when it comes back. The
//              default.
//   "webhook"  Telegram sends each one to publicUrl + /chloe/v1/<agent>/telegram,
//              which has to be reachable past the login, and checks
//              TELEGRAM_WEBHOOK_SECRET_TOKEN (or credentials.webhookSecretToken)
//              on every call. chloe registers the address itself on start.
//
// What happens to a message once it is read (allowFrom, a job waiting on an
// answer, /commands, jobs that answer plain messages, groups, the chat) is
// channels/shared.ts, the same for every channel. This file reads Telegram,
// sends to it, and nothing else. With `inGroups: "always"`, remember that
// Telegram only hands a bot every group message when its privacy mode is off
// (BotFather, /setprivacy) or it is a group admin.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Agent, type Channel, type ChatHistory, type Running } from "#chloe/load/load.ts";
import { ownedBy, reachBy, unreach } from "#chloe/model/ask.ts";
import type { Attachment } from "#chloe/model/model.ts";
import { commands, receive, type Incoming, type Rules } from "./shared.ts";

const MAX_MESSAGE = 4000; // Telegram rejects anything over 4096.
const WAIT = 50; // Seconds Telegram holds a poll open when there is nothing new.

/**
 * How an agent is put on Telegram: who may reach it, and whether messages are
 * fetched or posted.
 */
export interface TelegramOptions {
  /**
   * "telegram" unless the agent has two bots. It is what the log shows a run
   * came in on, and the start of every address on this bot, like "telegram:123".
   */
  name?: string;
  /** For spotting a mention in a group. Asked of Telegram when left out. */
  botUsername?: string;
  /** Instead of TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN. */
  credentials?: { botToken?: string; webhookSecretToken?: string };
  /** Telegram user ids that may reach the agent. */
  allowFrom?: number[];
  /**
   * In a group, "when-addressed" (the default) answers only a command, a
   * mention or a reply to the bot. "always" answers every message from
   * someone in allowFrom.
   */
  inGroups?: "when-addressed" | "always";
  /** How much of a chat's conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Send what the model writes on its way to an answer as it writes it, not only the answer. Off unless true. */
  sendWhileWorking?: boolean;
  mode?: "polling" | "webhook";
  /** Where this server is reachable from outside, for mode "webhook", like "https://agents.example.com". */
  publicUrl?: string;
  /** Which files are taken, and how big. Anything else is named to the agent but not handed over. */
  uploadPolicy?: { allowedMediaTypes?: string[]; maxBytes?: number };
  /** Where Telegram is. Only the tests change it. */
  api?: string;
}

/** How far each bot has read. Outlives a reader, so one started after an edit is not handed the same messages again. */
const read = new Map<string, number>();

/** Which agent has each bot. Two readers of one bot would each get half the messages. */
const taken = new Map<string, string>();

interface User {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: User;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  caption_entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: { from?: User; text?: string; caption?: string };
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] };
}

interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: User; data?: string; message?: TgMessage };
}

/** An agent on Telegram, as a channel its own `agent.ts` names. */
export function telegramChannel(options: TelegramOptions = {}): Channel {
  return {
    name: options.name ?? "telegram",
    chatHistory: options.chatHistory,
    start(agent) {
      const name = agent()?.name ?? "";
      const token = options.credentials?.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
      if (!token) {
        console.error(
          `telegram: ${name} has a Telegram channel but no bot. Message @BotFather in Telegram, send /newbot, ` +
            "and put the token it gives you in .env as TELEGRAM_BOT_TOKEN. Then restart.",
        );
        return { stop: () => {} };
      }
      const holder = taken.get(token);
      if (holder && holder !== name) {
        console.error(`telegram: ${holder} already answers this bot, so ${name}'s channel does nothing. Give it its own bot.`);
        return { stop: () => {} };
      }
      taken.set(token, name);
      const running = listen({ ...options, name, channel: options.name, token, agent });
      return {
        routes: running.routes,
        stop() {
          running.stop();
          taken.delete(token);
        },
      };
    },
  };
}

/** Reads messages until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: Omit<TelegramOptions, "name"> & {
    /** The agent's name. */
    name: string;
    /** The channel's name, "telegram" when left out. */
    channel?: string;
    token: string;
    agent: () => Agent | undefined;
  },
): Running {
  const { name, token } = options;
  const channel = options.channel ?? "telegram";
  const api = options.api ?? "https://api.telegram.org";
  const rules: Rules = { allowFrom: options.allowFrom ?? [], inGroups: options.inGroups, chatHistory: options.chatHistory, sendWhileWorking: options.sendWhileWorking };
  const mode = options.mode ?? "polling";
  const path = `/chloe/v1/${name}/${channel}`;
  const secret = options.credentials?.webhookSecretToken || process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");
  const allowedTypes = options.uploadPolicy?.allowedMediaTypes ?? ["image/*", "application/pdf", "text/*"];
  const maxBytes = options.uploadPolicy?.maxBytes ?? 10 * 1024 * 1024;
  const stopping = new AbortController();
  let me: User | undefined;

  async function call<T>(method: string, body: object, seconds = 30, signal: AbortSignal | null = stopping.signal): Promise<T> {
    const timeout = AbortSignal.timeout(seconds * 1000);
    const response = await fetch(`${api}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const reply = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!reply.ok) throw new Error(`${method}: ${reply.description ?? response.status}`);
    return reply.result as T;
  }

  /** Sending is not stopped with the reading: a turn already under way still answers. */
  async function send(chatId: number, text: string, extra: object = {}): Promise<void> {
    for (let i = 0; i < text.length; i += MAX_MESSAGE) {
      const last = i + MAX_MESSAGE >= text.length;
      await call("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_MESSAGE), ...(last ? extra : {}) }, 30, null);
    }
  }

  // A job of this agent's that stops to ask somebody reaches them through this
  // bot. Answers that can be listed become buttons, and anything
  // else asks for a reply.
  reachBy(
    channel,
    (to, text, choices) =>
      send(Number(to), text, {
        reply_markup: choices?.length
          ? { inline_keyboard: [choices.map((choice, i) => ({ text: choice, callback_data: `a:${i}` }))] }
          : { force_reply: true },
      }),
    name,
  );
  // A private chat's id is the person's user id, so the first allowed person is reachable at it.
  if (options.allowFrom?.[0]) ownedBy(name, `${channel}:${options.allowFrom[0]}`);

  function wanted(mediaType: string): boolean {
    return allowedTypes.some((one) => (one.endsWith("/*") ? mediaType.startsWith(one.slice(0, -1)) : one === mediaType));
  }

  /** The photo or document on a message, fetched, or a line saying why it was not. */
  async function fileOn(message: TgMessage): Promise<{ attachment?: Attachment; text?: string; note?: string }> {
    const photo = message.photo?.at(-1); // The largest size.
    const doc = message.document;
    if (!photo && !doc) return {};
    const fileName = doc?.file_name ?? "photo.jpg";
    const mediaType = doc ? (doc.mime_type ?? "application/octet-stream") : "image/jpeg";
    const size = (photo ?? doc)!.file_size ?? 0;
    if (!wanted(mediaType)) return { note: `(They sent ${fileName}, a ${mediaType}, which this channel does not take.)` };
    if (size > maxBytes) return { note: `(They sent ${fileName}, which is over the ${Math.round(maxBytes / 1048576)}MB this channel takes.)` };
    const file = await call<{ file_path: string }>("getFile", { file_id: (photo ?? doc)!.file_id });
    const response = await fetch(`${api}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (mediaType.startsWith("text/")) return { text: `<file name="${fileName}">\n${bytes.toString("utf8")}\n</file>` };
    return { attachment: { mediaType, data: bytes.toString("base64"), name: fileName }, note: `(Attached: ${fileName})` };
  }

  /**
   * Shows "typing..." until the returned function is called. Telegram clears
   * it after about five seconds, so it is sent again every four.
   */
  function typing(chatId: number, topic?: number): () => void {
    const once = () =>
      call("sendChatAction", { chat_id: chatId, action: "typing", ...(topic ? { message_thread_id: topic } : {}) }).catch(() => {});
    void once();
    const timer = setInterval(once, 4000);
    return () => clearInterval(timer);
  }

  /** A Telegram message in the words every channel shares. The rest is receive()'s. */
  function incoming(message: TgMessage, from: User, text: string): Incoming {
    const chatId = message.chat.id;
    const username = options.botUsername ?? me?.username ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const mentioned =
      !!username &&
      entities.some((e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`);
    const replyToBot = !!me && message.reply_to_message?.from?.id === me.id;
    // A forum topic is its own conversation.
    const topic = message.is_topic_message ? message.message_thread_id : undefined;
    const quoted = message.reply_to_message;
    return {
      channel,
      chat: String(chatId),
      thread: `${name}/${channel}-${chatId}${topic ? `-${topic}` : ""}`,
      from: { id: String(from.id), name: from.username ? `@${from.username}` : (from.first_name ?? String(from.id)) },
      text,
      private: message.chat.type === "private",
      addressed: mentioned || replyToBot,
      chatTitle: message.chat.title ?? "",
      replyTo: quoted?.text ?? quoted?.caption ?? "",
      context: {
        chat_type: message.chat.type,
        ...(message.chat.title ? { chat_title: message.chat.title } : {}),
        bot_username: username,
        is_mentioned: String(mentioned),
      },
      files: async () => {
        const file = await fileOn(message);
        return { attachments: file.attachment ? [file.attachment] : [], text: file.text, notes: file.note ? [file.note] : [] };
      },
    };
  }

  async function onMessage(message: TgMessage): Promise<void> {
    const agent = options.agent();
    const text = message.text ?? message.caption ?? "";
    if (!agent || !message.from || (!text && !message.photo && !message.document)) return;
    const chatId = message.chat.id;
    const topic = message.is_topic_message ? message.message_thread_id : undefined;
    const extra = {
      ...(topic ? { message_thread_id: topic } : {}),
      ...(message.chat.type === "private" ? {} : { reply_parameters: { message_id: message.message_id } }),
    };
    const handled = await receive(agent, incoming(message, message.from, text), rules, {
      working: () => typing(chatId, topic),
      send: (words) => send(chatId, words, extra),
    });
    if (handled?.text) await send(chatId, handled.text, extra).catch((error) => console.error("telegram:", error.message));
  }

  /** A pressed button is its text, sent by whoever pressed it, which is how it answers a waiting job. */
  async function onButton(query: NonNullable<Update["callback_query"]>): Promise<void> {
    await call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
    const message = query.message;
    const agent = options.agent();
    if (!message || !agent) return;
    const index = Number(query.data?.replace(/^a:/, ""));
    const choice = message.reply_markup?.inline_keyboard?.flat()[index]?.text;
    if (!choice) return;
    const topic = message.message_thread_id;
    const handled = await receive(agent, { ...incoming(message, query.from, choice), addressed: true }, rules);
    if (!handled) return;
    // Take the buttons away so the question cannot be answered twice, and say what was chosen.
    await call("editMessageText", { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text ?? ""}\n\n→ ${choice}` }).catch(() => {});
    if (handled.text) await send(message.chat.id, handled.text, topic ? { message_thread_id: topic } : {}).catch(() => {});
  }

  /**
   * The menu Telegram shows when somebody types "/" is this agent's jobs, each
   * as its id with "_" for "-" (Telegram allows no hyphens) and its description.
   * It replaces whatever the menu held before, including anything set in
   * BotFather. Only sent when the list has changed, so an edited or new job is
   * in the menu within one poll and no call is spent on a list that has not.
   */
  let menu = "";
  async function syncMenu(): Promise<void> {
    const agent = options.agent();
    if (!agent) return;
    const listed = commands(agent);
    const now = JSON.stringify(listed);
    if (now === menu) return;
    await call("setMyCommands", { commands: listed });
    menu = now;
  }

  function handle(update: Update): void {
    if (update.message) void onMessage(update.message).catch((error) => console.error("telegram:", error));
    if (update.callback_query) void onButton(update.callback_query).catch((error) => console.error("telegram:", error));
  }

  void (async () => {
    me = await call<User>("getMe", {}).catch(() => undefined);
    if (mode === "webhook") {
      if (!options.publicUrl) {
        console.error(`telegram: ${name} is in webhook mode with no publicUrl, so Telegram has nowhere to send messages.`);
        return;
      }
      await call("setWebhook", {
        url: `${options.publicUrl.replace(/\/+$/, "")}${path}`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      }).catch((error) => console.error("telegram:", error.message));
      await syncMenu().catch((error) => console.error("telegram: setting the / menu failed:", error.message));
      return;
    }
    // Telegram will not hand out messages while a webhook is registered.
    await call("deleteWebhook", {}).catch((error) => console.error("telegram:", error.message));
    while (!stopping.signal.aborted) {
      await syncMenu().catch((error) => console.error("telegram: setting the / menu failed:", error.message));
      try {
        const offset = read.get(token) ?? 0;
        const updates = await call<Update[]>(
          "getUpdates",
          { offset, timeout: WAIT, allowed_updates: ["message", "callback_query"] },
          WAIT + 10,
        );
        // Asking with the next offset is what tells Telegram these arrived.
        for (const update of updates) {
          if (stopping.signal.aborted) break;
          read.set(token, update.update_id + 1);
          handle(update);
        }
      } catch (error) {
        if (stopping.signal.aborted) break;
        console.error(`telegram: ${name} could not read messages, trying again in 5s:`, (error as Error).message);
        await new Promise((done) => setTimeout(done, 5000));
      }
    }
  })();

  const webhook = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Nothing without the secret, and no hint about what was wrong.
    if (request.headers["x-telegram-bot-api-secret-token"] !== secret) {
      response.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    // Always 200 once the secret checks out: anything else makes Telegram send the same update again.
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    try {
      handle(JSON.parse(raw) as Update);
    } catch {
      // Not JSON: nothing to do, and Telegram has had its 200.
    }
  };

  return {
    routes: mode === "webhook" ? [{ path, handle: webhook }] : [],
    stop() {
      stopping.abort();
      unreach(channel, name);
    },
  };
}
