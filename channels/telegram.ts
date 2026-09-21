// Talking to an agent from Telegram. An agent's channel file is one call:
//
//   // agents/<name>/channels/telegram.ts
//   import { telegramChannel } from "chloejs/channels/telegram";
//   export default telegramChannel({ allowFrom: [111111111] });
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
// In a group, the agent answers a command (/ask), a message that mentions the
// bot, or a reply to one of the bot's own messages, and nothing else.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Agent, type Channel, type Running } from "#chloe/load/load.ts";
import { ownedBy, reachBy, unreach } from "#chloe/model/ask.ts";
import type { Attachment } from "#chloe/model/model.ts";
import { answer as answerRun, waitingOn, WrongInput } from "#chloe/core/steps.ts";
import { clock } from "#chloe/core/clock.ts";
import { turn } from "#chloe/core/turn.ts";

const MAX_MESSAGE = 4000; // Telegram rejects anything over 4096.
const WAIT = 50; // Seconds Telegram holds a poll open when there is nothing new.

/**
 * How an agent is put on Telegram: who may reach it, and whether messages are
 * fetched or posted.
 */
export interface TelegramOptions {
  /** For spotting a mention in a group. Asked of Telegram when left out. */
  botUsername?: string;
  /** Instead of TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN. */
  credentials?: { botToken?: string; webhookSecretToken?: string };
  /** Telegram user ids that may reach the agent. */
  allowFrom?: number[];
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
      const running = listen({ ...options, name, token, agent });
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
export function listen(options: TelegramOptions & { name: string; token: string; agent: () => Agent | undefined }): Running {
  const { name, token } = options;
  const api = options.api ?? "https://api.telegram.org";
  const allowFrom = new Set(options.allowFrom ?? []);
  const mode = options.mode ?? "polling";
  const path = `/chloe/v1/${name}/telegram`;
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
    "telegram",
    (to, text, choices) =>
      send(Number(to), text, {
        reply_markup: choices?.length
          ? { inline_keyboard: [choices.map((choice, i) => ({ text: choice, callback_data: `a:${i}` }))] }
          : { force_reply: true },
      }),
    name,
  );
  // A private chat's id is the person's user id, so the first allowed person is reachable at it.
  if (options.allowFrom?.[0]) ownedBy(name, `telegram:${options.allowFrom[0]}`);

  function allowed(from: User | undefined, chatId: number, isPrivate: boolean): boolean {
    if (!from) return false;
    if (allowFrom.size === 0) {
      console.log(`telegram: user ${from.id} wrote to ${name}. Add ${from.id} to allowFrom in ${name}'s telegram channel.`);
      if (isPrivate) {
        void send(chatId, `Your Telegram user id is ${from.id}. Add it to allowFrom in ${name}'s telegram channel.`).catch(() => {});
      }
      return false;
    }
    if (!allowFrom.has(from.id)) {
      console.warn(`telegram: ${name} is ignoring user ${from.id}${from.username ? ` (@${from.username})` : ""}, not in allowFrom`);
      return false;
    }
    return true;
  }

  /** In a group, a message is for the bot when it is a command, mentions it, or replies to it. */
  function addressed(message: TgMessage, text: string): { yes: boolean; mentioned: boolean } {
    if (message.chat.type === "private") return { yes: true, mentioned: false };
    const username = options.botUsername ?? me?.username ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const mentioned =
      !!username &&
      entities.some((e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`);
    const command = text.startsWith("/");
    const replyToBot = !!me && message.reply_to_message?.from?.id === me.id;
    return { yes: mentioned || command || replyToBot, mentioned };
  }

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

  /** An answer to a job that is waiting on this chat. Understood by the job, never by a model. */
  async function answerParked(chatId: number, text: string, extra: object): Promise<boolean> {
    const waiting = waitingOn(`telegram:${chatId}`, name);
    if (!waiting) return false;
    try {
      const found = options.agent();
      const result = await answerRun(waiting.id, text, new Map(found ? [[name, found]] : []));
      // Still parked means the answer did not fit, and the job has already asked again.
      if (!result.parked) await send(chatId, result.text || "Done.", extra);
    } catch (error) {
      console.error("telegram: answering a parked run failed", error);
      await send(chatId, "I could not carry that job on. It is in the logs on the box.", extra).catch(() => {});
    }
    return true;
  }

  /**
   * A message beginning with `/<job id>` runs that job, and nothing asks a
   * model what was meant. "If the message starts with /x, run x" is a rule
   * somebody can write down, so it is code.
   *
   * What the job is started with is the same envelope from every channel, so a
   * job written against it works from all of them: `text` is the message with
   * the command taken off, and `from`, `chat`, `chatTitle`, `user`, `thread`
   * and `replyTo` say where it came from. The job's own `input` shape decides
   * which of those it wants and what is required.
   *
   * Telegram's own command list allows no hyphens, so `/reading_companion`
   * reaches `reading-companion` too and can be registered with BotFather.
   * `/cmd@thebot` is how a group addresses one bot of several.
   */
  async function commanded(message: TgMessage, text: string, extra: object, topic?: number): Promise<boolean> {
    if (!text.startsWith("/")) return false;
    const agent = options.agent();
    if (!agent) return false;

    const [word, ...rest] = text.trim().split(/\s+/);
    const asked = word.slice(1).split("@")[0].toLowerCase();
    const job = agent.jobs.find((one) => one.id === asked || one.id === asked.replace(/_/g, "-"));
    // Not one of this agent's jobs, so it is just a message that starts with a
    // slash, and the model can make of it what it likes.
    if (!job) return false;

    const started = clock();
    if (!started) return false;

    const chatId = message.chat.id;
    const from = message.from!;
    const quoted = message.reply_to_message;
    const input = {
      text: text.slice(word.length).trim() || rest.join(" "),
      from: "telegram",
      chat: String(chatId),
      chatTitle: message.chat.title ?? "",
      user: from.username ? `@${from.username}` : (from.first_name ?? String(from.id)),
      thread: `${name}/telegram-${chatId}${topic ? `-${topic}` : ""}`,
      replyTo: quoted?.text ?? quoted?.caption ?? "",
    };

    const stopTyping = typing(chatId, topic);
    try {
      const result = await started.fire(agent, job, input);
      stopTyping();
      if (!result) {
        await send(chatId, `${job.id} is already running. I will not start a second one.`, extra);
        return true;
      }
      await send(chatId, result.text || `${job.id}: done.`, extra);
    } catch (error) {
      stopTyping();
      // What the caller sent did not fit the job, which is worth saying in the
      // chat: it is their message that has to change.
      const why = error instanceof WrongInput ? (error as Error).message : "It is in the logs on the box.";
      await send(chatId, `I could not run ${job.id}. ${why}`, extra).catch(() => {});
    } finally {
      stopTyping();
    }
    return true;
  }

  async function onMessage(message: TgMessage): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text ?? message.caption ?? "";
    if (!text && !message.photo && !message.document) return;
    if (!allowed(message.from, chatId, message.chat.type === "private")) return;
    const { yes, mentioned } = addressed(message, text);
    if (!yes) return;

    // A forum topic is its own conversation.
    const topic = message.is_topic_message ? message.message_thread_id : undefined;
    const extra = {
      ...(topic ? { message_thread_id: topic } : {}),
      ...(message.chat.type === "private" ? {} : { reply_parameters: { message_id: message.message_id } }),
    };

    if (text && (await answerParked(chatId, text, extra))) return;
    if (text && (await commanded(message, text, extra, topic))) return;

    const agent = options.agent();
    if (!agent) return;
    const stopTyping = typing(chatId, topic);
    try {
      const file = await fileOn(message);
      const from = message.from!;
      const context = [
        "<telegram_context>",
        `chat_type: ${message.chat.type}`,
        ...(message.chat.title ? [`chat_title: ${message.chat.title}`] : []),
        `from: ${from.first_name ?? ""}${from.username ? ` (@${from.username})` : ""}`,
        `bot_username: ${options.botUsername ?? me?.username ?? ""}`,
        `is_mentioned: ${mentioned}`,
        "</telegram_context>",
      ].join("\n");
      const result = await turn({
        agent,
        prompt: [context, text, file.text, file.note].filter(Boolean).join("\n\n"),
        attachments: file.attachment ? [file.attachment] : undefined,
        // One thread per chat, and per topic in a forum.
        thread: `${name}/telegram-${chatId}${topic ? `-${topic}` : ""}`,
        source: "telegram",
        owner: `telegram:${from.id}`,
      });
      stopTyping();
      await send(chatId, result.text || "(no reply)", extra);
    } catch (error) {
      console.error("telegram: turn failed", error);
      stopTyping();
      await send(chatId, "Something went wrong on my end. It is in the logs on the box.", extra).catch(() => {});
    } finally {
      stopTyping();
    }
  }

  /** A button under a job's question. Its label is the answer, read back off the message it was on. */
  async function onButton(query: NonNullable<Update["callback_query"]>): Promise<void> {
    await call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
    const message = query.message;
    if (!message || !allowed(query.from, message.chat.id, message.chat.type === "private")) return;
    const index = Number(query.data?.replace(/^a:/, ""));
    const choice = message.reply_markup?.inline_keyboard?.flat()[index]?.text;
    if (!choice) return;
    // Take the buttons away so the question cannot be answered twice, and say what was chosen.
    await call("editMessageText", { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text ?? ""}\n\n→ ${choice}` }).catch(() => {});
    await answerParked(message.chat.id, choice, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});
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
      return;
    }
    // Telegram will not hand out messages while a webhook is registered.
    await call("deleteWebhook", {}).catch((error) => console.error("telegram:", error.message));
    while (!stopping.signal.aborted) {
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
      unreach("telegram", name);
    },
  };
}
