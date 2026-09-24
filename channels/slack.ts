// Talking to an agent from Slack. It is one entry in the agent's channels:
//
//   // agents/<name>/agent.ts
//   import { slackChannel } from "@chloejs/core/channels";
//   channels: [slackChannel({ allowFrom: ["U0123ABCD"] })],
//
// It needs a Slack app with Socket Mode on, which is chloe opening a
// connection out to Slack rather than Slack sending to chloe, so nothing is
// exposed past the login and nothing needs a public address. At
// api.slack.com/apps: create an app, turn on Socket Mode (it makes the app
// token, "xapp-..."), and under OAuth & Permissions add the bot scopes
// chat:write, im:history, channels:history, groups:history, mpim:history,
// users:read and files:read, plus reactions:write for the "working" mark.
// Under Event Subscriptions subscribe the bot to message.im, message.channels,
// message.groups and message.mpim, and under App Home allow messages from the
// Messages tab. Install it to the workspace, which makes the bot token
// ("xoxb-..."). The two tokens are in settings.local.json under the agent's
// name, as `"agents": { "<name>": { "slack": { "bot_token", "app_token" } } }`,
// or `credentials: { botToken, appToken }` here. In a channel, invite the bot
// (/invite @name) before it can read anything there.
//
// allowFrom is who may talk to the agent, by Slack member id ("U0123ABCD", in
// a person's profile under "Copy member ID"). Leave it empty only the first
// time: until it has an entry, the bot answers a direct message with the
// sender's id. The first id is also who the agent's jobs ask when they name
// nobody, in a direct message.
//
// Slack answers "/something" itself unless the app declares it, so a job is
// run by a slash command only once it is added under Slash Commands in the
// app's settings, named like the job with "_" for "-" (commands() in
// shared.ts lists them). A job that `answers` plain messages needs nothing.
//
// A message in a Slack thread is answered in that thread, and each thread is
// its own conversation. Buttons for a job's question need Interactivity on,
// which Socket Mode covers with no address to fill in.
//
// What happens to a message once it is read is channels/shared.ts, the same
// for every channel. This file reads Slack, sends to it, and nothing else.
import { ownedBy, reachBy, unreach } from "#chloe/model/ask.ts";
import type { Agent, Channel, ChatHistory, Running } from "#chloe/load/load.ts";
import type { Attachment } from "#chloe/model/model.ts";
import { settings } from "#chloe/core/settings.ts";
import { receive, type Incoming, type Rules } from "./shared.ts";

const MAX_MESSAGE = 4000; // Slack cuts a message's text at 40000, and advises under 4000.
const READS = new Set(["auth.test", "apps.connections.open", "users.info", "conversations.info"]);

/** How an agent is put on Slack: who may reach it, and how it behaves in a channel. */
export interface SlackOptions {
  /**
   * "slack" unless the agent is in two workspaces. It is what the log shows a
   * run came in on, and the start of every address on this app, like "slack:U0123ABCD".
   */
  name?: string;
  /** Instead of the tokens in settings. */
  credentials?: { botToken?: string; appToken?: string };
  /** Slack member ids that may reach the agent. */
  allowFrom?: string[];
  /**
   * In a channel, "when-addressed" (the default) answers only a slash
   * command, a mention, or a reply in a thread the bot started. "always"
   * answers every message from someone in allowFrom.
   */
  inGroups?: "when-addressed" | "always";
  /** How much of a conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Send what the model writes on its way to an answer as it writes it, not only the answer. Off unless true. */
  sendWhileWorking?: boolean;
  /** Which files are taken, and how big. Anything else is named to the agent but not handed over. */
  uploadPolicy?: { allowedMediaTypes?: string[]; maxBytes?: number };
  /** Where Slack is. Only the tests change it. */
  api?: string;
}

/** Which agent has each app. Two readers of one app would each get some of the messages. */
const taken = new Map<string, string>();

interface SlackFile {
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

interface SlackMessage {
  type: "message" | "app_mention";
  subtype?: string;
  channel: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  files?: SlackFile[];
}

interface Envelope {
  envelope_id?: string;
  type: "hello" | "disconnect" | "events_api" | "interactive" | "slash_commands";
  payload?: any;
}

/** An agent on Slack, as a channel its own `agent.ts` names. */
export function slackChannel(options: SlackOptions = {}): Channel {
  return {
    name: options.name ?? "slack",
    chatHistory: options.chatHistory,
    madeWith: JSON.stringify(options),
    start(agent) {
      const name = agent()?.name ?? "";
      const token = options.credentials?.botToken || settings.agents[name]?.slack.bot_token || "";
      const appToken = options.credentials?.appToken || settings.agents[name]?.slack.app_token || "";
      if (!token || !appToken) {
        console.error(
          `slack: ${name} has a Slack channel but no ${token ? "app token" : "bot token"}. Make an app at api.slack.com/apps ` +
            `with Socket Mode on, and put its tokens in settings.local.json as "agents": { "${name}": { "slack": { "bot_token": "xoxb-...", "app_token": "xapp-..." } } }.`,
        );
        return { stop: () => {} };
      }
      const holder = taken.get(appToken);
      if (holder && holder !== name) {
        console.error(`slack: ${holder} already answers this app, so ${name}'s channel does nothing. Give it its own app.`);
        return { stop: () => {} };
      }
      taken.set(appToken, name);
      const running = listen({ ...options, name, channel: options.name, token, appToken, agent });
      return {
        stop() {
          running.stop();
          taken.delete(appToken);
        },
      };
    },
  };
}

/** Reads messages until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: Omit<SlackOptions, "name"> & {
    /** The agent's name. */
    name: string;
    /** The channel's name, "slack" when left out. */
    channel?: string;
    token: string;
    appToken: string;
    agent: () => Agent | undefined;
  },
): Running {
  const { name, token } = options;
  const channel = options.channel ?? "slack";
  const api = options.api ?? "https://slack.com/api";
  const rules: Rules = { allowFrom: options.allowFrom ?? [], inGroups: options.inGroups, chatHistory: options.chatHistory, sendWhileWorking: options.sendWhileWorking };
  const allowedTypes = options.uploadPolicy?.allowedMediaTypes ?? ["image/*", "application/pdf", "text/*"];
  const maxBytes = options.uploadPolicy?.maxBytes ?? 10 * 1024 * 1024;
  let stopped = false;
  let socket: WebSocket | undefined;
  let me = "";

  async function call<T = any>(method: string, body: object, as = token): Promise<T> {
    // Slack reads JSON only on the methods that write, so the others are sent as a form.
    const form = READS.has(method);
    const response = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8", Authorization: `Bearer ${as}` },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const reply = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!reply.ok) throw new Error(`${method}: ${reply.error ?? response.status}`);
    return reply;
  }

  /** Sending is not stopped with the reading: a turn already under way still answers. */
  async function send(chat: string, text: string, thread?: string, extra: object = {}): Promise<void> {
    for (let i = 0; i < text.length; i += MAX_MESSAGE) {
      const last = i + MAX_MESSAGE >= text.length;
      await call("chat.postMessage", { channel: chat, text: text.slice(i, i + MAX_MESSAGE), ...(thread ? { thread_ts: thread } : {}), ...(last ? extra : {}) });
    }
  }

  // A job of this agent's that stops to ask somebody reaches them through this
  // app. A member id as the channel is that person's direct message with the
  // bot. Answers that can be listed become buttons, and anything else is
  // answered by the next message in that chat.
  reachBy(
    channel,
    (to, text, choices) =>
      send(
        to,
        text,
        undefined,
        choices?.length
          ? {
              blocks: [
                { type: "section", text: { type: "plain_text", text } },
                { type: "actions", elements: choices.map((choice, i) => ({ type: "button", action_id: `a:${i}`, text: { type: "plain_text", text: choice }, value: choice })) },
              ],
            }
          : {},
      ),
    name,
  );
  if (options.allowFrom?.[0]) ownedBy(name, `${channel}:${options.allowFrom[0]}`);

  /** Names by id, asked of Slack once each. An id stands in when Slack will not say. */
  const names = new Map<string, Promise<string>>();
  function named(kind: "user" | "channel", id: string): Promise<string> {
    const key = `${kind}:${id}`;
    if (!names.has(key)) {
      names.set(
        key,
        kind === "user"
          ? call("users.info", { user: id }).then((r) => r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id, () => id)
          : call("conversations.info", { channel: id }).then((r) => (r.channel?.name ? `#${r.channel.name}` : ""), () => ""),
      );
    }
    return names.get(key)!;
  }

  function wanted(mediaType: string): boolean {
    return allowedTypes.some((one) => (one.endsWith("/*") ? mediaType.startsWith(one.slice(0, -1)) : one === mediaType));
  }

  /** The files on a message, fetched, and a line for each one that was not. */
  async function filesOn(message: SlackMessage): Promise<{ attachments: Attachment[]; text?: string; notes: string[] }> {
    const attachments: Attachment[] = [];
    const texts: string[] = [];
    const notes: string[] = [];
    for (const file of message.files ?? []) {
      const fileName = file.name ?? "file";
      const mediaType = file.mimetype ?? "application/octet-stream";
      if (!wanted(mediaType)) notes.push(`(They sent ${fileName}, a ${mediaType}, which this channel does not take.)`);
      else if ((file.size ?? 0) > maxBytes) notes.push(`(They sent ${fileName}, which is over the ${Math.round(maxBytes / 1048576)}MB this channel takes.)`);
      else if (file.url_private_download) {
        const response = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (mediaType.startsWith("text/")) texts.push(`<file name="${fileName}">\n${bytes.toString("utf8")}\n</file>`);
        else {
          attachments.push({ mediaType, data: bytes.toString("base64"), name: fileName });
          notes.push(`(Attached: ${fileName})`);
        }
      }
    }
    return { attachments, text: texts.join("\n\n") || undefined, notes };
  }

  /** Slack shows no "typing..." for a bot, so an eyes mark on the message stands in, taken off when the work is over. */
  function working(chat: string, ts: string): () => void {
    const mark = { channel: chat, timestamp: ts, name: "eyes" };
    void call("reactions.add", mark).catch(() => {});
    return () => void call("reactions.remove", mark).catch(() => {});
  }

  /**
   * A Slack message in the words every channel shares. In a direct message
   * the chat is the person's member id, which is also where a job asks them
   * something, so their answer comes back from the same address.
   */
  async function incoming(message: SlackMessage, user: string, text: string): Promise<Incoming> {
    const direct = message.channel_type === "im";
    const chat = direct ? user : message.channel;
    const mention = me ? `<@${me}>` : "";
    const mentioned = !!mention && text.includes(mention);
    const title = direct ? "" : await named("channel", message.channel);
    return {
      channel,
      chat,
      thread: `${name}/${channel}-${chat}${message.thread_ts ? `-${message.thread_ts}` : ""}`,
      from: { id: user, name: await named("user", user) },
      // The mention is how it was addressed, not part of what was said, and would hide a leading "/".
      text: mentioned ? text.replaceAll(mention, "").trim() : text,
      private: direct,
      addressed: mentioned || (!!me && message.parent_user_id === me),
      chatTitle: title,
      context: {
        chat_type: message.channel_type ?? "channel",
        ...(title ? { chat_title: title } : {}),
        is_mentioned: String(mentioned),
      },
      files: () => filesOn(message),
    };
  }

  /** Each message once: Slack sends a mention both as a message and as an app_mention, and sends again what was not acknowledged in time. */
  const seen = new Set<string>();
  function firstTime(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    return true;
  }

  async function onMessage(message: SlackMessage): Promise<void> {
    const agent = options.agent();
    // Edits, deletions, joins and the like have a subtype; a message with a file is the one kept.
    if (!agent || !message.user || message.bot_id || message.user === me) return;
    if (message.subtype && message.subtype !== "file_share" && message.subtype !== "thread_broadcast") return;
    if (!message.text && !message.files?.length) return;
    if (!firstTime(`${message.channel}/${message.ts}`)) return;
    const handled = await receive(agent, await incoming(message, message.user, message.text ?? ""), rules, {
      working: () => working(message.channel, message.ts),
      send: (words) => send(message.channel, words, message.thread_ts),
    });
    if (handled?.text) await send(message.channel, handled.text, message.thread_ts).catch((error) => console.error("slack:", error.message));
  }

  /** A slash command is its command and text, sent by whoever typed it, and always addressed to the agent. */
  async function onCommand(command: { command: string; text?: string; user_id: string; channel_id: string; response_url?: string }): Promise<void> {
    const agent = options.agent();
    if (!agent) return;
    const direct = command.channel_id.startsWith("D");
    const message: SlackMessage = { type: "message", channel: command.channel_id, channel_type: direct ? "im" : "channel", user: command.user_id, ts: "" };
    const text = `${command.command} ${command.text ?? ""}`.trim();
    // The response address works in a channel the bot was never invited to, where posting does not.
    const reply = (words: string) =>
      command.response_url
        ? fetch(command.response_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "in_channel", text: words }) }).then(() => {})
        : send(command.channel_id, words);
    const handled = await receive(agent, { ...(await incoming(message, command.user_id, text)), addressed: true }, rules, { send: reply });
    if (handled?.text) await reply(handled.text).catch((error) => console.error("slack:", error.message));
  }

  /** A pressed button is its text, sent by whoever pressed it, which is how it answers a waiting job. */
  async function onButton(payload: any): Promise<void> {
    const agent = options.agent();
    const choice: string | undefined = payload.actions?.[0]?.value;
    const chat: string | undefined = payload.channel?.id ?? payload.container?.channel_id;
    if (!agent || !choice || !chat || !payload.user?.id) return;
    const question: string = payload.message?.text ?? "";
    const message: SlackMessage = { type: "message", channel: chat, channel_type: chat.startsWith("D") ? "im" : "channel", user: payload.user.id, ts: payload.message?.ts ?? "" };
    const handled = await receive(agent, { ...(await incoming(message, payload.user.id, choice)), addressed: true }, rules);
    if (!handled) return;
    // Take the buttons away so the question cannot be answered twice, and say what was chosen.
    if (message.ts) await call("chat.update", { channel: chat, ts: message.ts, text: `${question}\n\n→ ${choice}`, blocks: [] }).catch(() => {});
    if (handled.text) await send(chat, handled.text).catch(() => {});
  }

  function handle(envelope: Envelope): void {
    const failed = (error: Error) => console.error("slack:", error);
    const payload = envelope.payload;
    if (envelope.type === "events_api") {
      const event = payload?.event as SlackMessage | undefined;
      if (event?.type === "message" || event?.type === "app_mention") void onMessage(event).catch(failed);
    }
    if (envelope.type === "slash_commands" && payload) void onCommand(payload).catch(failed);
    if (envelope.type === "interactive" && payload?.type === "block_actions") void onButton(payload).catch(failed);
  }

  /** One connection at a time, opened again whenever Slack closes it, which it does every few hours. */
  async function connect(): Promise<void> {
    while (!stopped) {
      try {
        if (!me) me = (await call<{ user_id: string }>("auth.test", {})).user_id;
        const { url } = await call<{ url: string }>("apps.connections.open", {}, options.appToken);
        await new Promise<void>((closed, failed) => {
          const ws = new WebSocket(url);
          socket = ws;
          ws.onmessage = (event) => {
            let envelope: Envelope;
            try {
              envelope = JSON.parse(String(event.data)) as Envelope;
            } catch {
              return;
            }
            // Acknowledged at once, or Slack sends it again three seconds later.
            if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            if (envelope.type === "disconnect") ws.close();
            else handle(envelope);
          };
          ws.onclose = () => closed();
          ws.onerror = () => failed(new Error("the connection to Slack failed"));
        });
        // A moment before the next one, so a connection that keeps closing is not opened again in a tight loop.
        if (!stopped) await new Promise((done) => setTimeout(done, 1000));
      } catch (error) {
        if (stopped) break;
        console.error(`slack: ${name} could not reach Slack, trying again in 5s:`, (error as Error).message);
        await new Promise((done) => setTimeout(done, 5000));
      }
    }
  }
  void connect();

  return {
    stop() {
      stopped = true;
      socket?.close();
      unreach(channel, name);
    },
  };
}
