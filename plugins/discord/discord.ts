// Talking to an agent from Discord. It is one entry in the agent's channels:
//
//   // agents/<id>/agent.ts
//   import { discordChannel } from "@chloejs/core/channels";
//   channels: { discord: discordChannel({ allowFrom: ["123456789012345678"] }) },
//
// It needs a bot, made at discord.com/developers/applications: create an
// application, and on its Bot page reset the token and copy it, and turn on
// Message Content Intent (without it Discord refuses the connection). Then
// under OAuth2, URL Generator, tick the scope `bot` and the permissions Send
// Messages, Read Message History and Attach Files, and open the address it
// makes to add the bot to a server. The token is
// `agents: { <id>: { discord: process.env.CHLOE_AGENTS_<id>_DISCORD } }` in
// chloe.config.ts's settings, with the token in .env, or
// `credentials: { botToken }` here.
//
// chloe opens a connection out to Discord (its gateway), so nothing is exposed
// past the login and nothing needs a public address. A message sent while the
// connection was down for a moment is handed over when it comes back; one
// sent while chloe was stopped is not.
//
// allowFrom is who may talk to the agent, by Discord user id (with Developer
// Mode on in Discord's settings, right-click a person and Copy User ID). Ids
// are strings: they are too long for a JavaScript number. Leave it empty only
// the first time: until it has an entry, the bot answers a direct message with
// the sender's id. The first id is also who the agent's jobs ask when they
// name nobody, in a direct message.
//
// A Discord thread is a channel of its own, so each thread is its own
// conversation. A job runs from `/<job id>` typed as a message: the bot
// registers no slash commands with Discord.
//
// What happens to a message once it is read is channels/shared.ts, the same
// for every channel. This file reads Discord, sends to it, and nothing else.
import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { ownedBy, reachBy, together, unreach } from "#chloe/services/messageService";
import type { Agent, Channel, ChatHistory, Running } from "#chloe/load/load";
import type { Attachment } from "#chloe/model/model";
import type { FileToSend } from "#chloe/model/tools/chat";
import { settings, whereKeyGoes } from "#chloe/core/settings";
import { type Bound, type Button, defineChannel, type Incoming, inPieces, receive, rulesOf, type Shared } from "#chloe/channels/shared";

const MAX_MESSAGE = 2000; // Discord refuses a message over 2000 characters.
const MAX_FILE = 10 * 1024 * 1024; // What Discord takes from a bot in a server with no boosts.
// Server messages (1 << 9), direct messages (1 << 12), and what they say (1 << 15).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const PORTAL = "the app's Bot page at discord.com/developers/applications";

/** Closes Discord gives for something only the owner can fix, with what to do. */
const FATAL: Record<number, string> = {
  4004: `Discord refused the bot token. Reset it on ${PORTAL} and put the new one in`,
  4014: `Discord will not hand over what messages say. Turn on Message Content Intent on ${PORTAL}`,
};

/** The options for `discordChannel()`: who may reach the agent, and when it answers in a server. */
export interface DiscordOptions extends Shared {
  /**
   * The channel's name. Default: "discord".
   *
   * Set it only when the agent has two Discord bots, because two channels of
   * one agent cannot share a name. The name shows in the log, and it is the
   * first part of every address on this bot, like `discord:123456789012345678`.
   */
  name?: string;
  /**
   * The bot's token, if you do not keep it in settings. `botToken` is used in
   * place of `agents.<id>.discord`.
   *
   * Read it from `process.env`. Never write a token in the file itself.
   */
  credentials?: { botToken?: string };
  /**
   * The Discord user ids allowed to talk to the agent, like
   * "123456789012345678", in a direct message or any server the bot is in.
   * Default: `[]` (nobody).
   *
   * Leave it empty only at first: until it has an id, the bot answers a
   * direct message with the sender's id, so you can add it.
   *
   * The first id counts as the agent's owner. Their messages can use the
   * tools only the owner may use, and jobs ask them, in a direct message,
   * when they name nobody.
   */
  allowFrom?: string[];
  /**
   * Which messages in a server get an answer. Default: "when-addressed".
   *
   * - "when-addressed": a `/command`, a mention of the bot, or a reply to it.
   * - "always": every message from somebody in `allowFrom`, in every channel
   *   the bot can read.
   */
  inGroups?: "when-addressed" | "always";
  /**
   * How much of the conversation the agent sees with each new message:
   * `{ messages, days }`. `messages` is the most it sees, and `days` leaves
   * out anything older. Default: the last 10 messages.
   */
  chatHistory?: ChatHistory;
  /**
   * Sends what the model writes before its final answer (like a "let me
   * check" line) as soon as it is written. Off by default.
   */
  sendWhileWorking?: boolean;
  /**
   * Which files the agent receives, and how big they may be.
   *
   * - `allowedMediaTypes`: default `["image/*", "application/pdf", "text/*"]`.
   * - `maxBytes`: default 10 MB (`10 * 1024 * 1024`).
   *
   * The agent is told the name of any other file, but does not receive it.
   */
  uploadPolicy?: { allowedMediaTypes?: string[]; maxBytes?: number };
  /** The address of Discord's API. Default: "https://discord.com/api/v10". Only the tests change it. */
  api?: string;
}

/** Which agent has each bot. Two connections for one bot would each get every message, and answer twice. */
const taken = new Map<string, string>();

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordMessage {
  id: string;
  type?: number;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content?: string;
  mentions?: DiscordUser[];
  referenced_message?: { author?: DiscordUser; content?: string } | null;
  attachments?: { filename?: string; content_type?: string; size?: number; url?: string }[];
  components?: { components?: { custom_id?: string; label?: string }[] }[];
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  guild_id?: string;
  user?: DiscordUser;
  member?: { user?: DiscordUser };
  message?: DiscordMessage;
  data?: { custom_id?: string; values?: string[] };
}

/**
 * Puts an agent on Discord. Add it to the `channels` in the agent's
 * `agent.ts`:
 *
 * ```ts
 * channels: { discord: discordChannel({ allowFrom: ["123456789012345678"] }) },
 * ```
 *
 * It needs a bot from discord.com/developers/applications with Message
 * Content Intent on. chloe connects out to Discord, so nothing on your
 * machine needs to be reachable from the internet. The bot's token goes in
 * settings in `chloe.config.ts`, as
 * `agents: { <id>: { discord: process.env.CHLOE_AGENTS_<ID>_DISCORD } }`, with
 * the token itself in `.env`.
 *
 * - A message in a server is answered when it mentions the bot or replies to
 *   it, unless `inGroups` is "always".
 * - A job runs from `/<job id>` typed as a message.
 * - Each agent needs its own bot. A bot that another agent already uses is
 *   ignored, with a line in the log.
 */
export function discordChannel(options: DiscordOptions = {}): Channel {
  return defineChannel("discord", options, ({ agent, agentId, name, bound }) => {
    const token = options.credentials?.botToken || settings.agents[agentId]?.discord || "";
    if (!token) {
      console.error(
        `discord: ${agentId} has a Discord channel but no bot. Make an application at discord.com/developers/applications, ` +
          `reset its bot's token, and put it ${whereKeyGoes(["agents", agentId, "discord"])}.`,
      );
      return { stop: () => {} };
    }
    const holder = taken.get(token);
    if (holder && holder !== agentId) {
      console.error(`discord: ${holder} already answers this bot, so ${agentId}'s channel does nothing. Give it its own bot.`);
      return { stop: () => {} };
    }
    taken.set(token, agentId);
    const running = listen({ ...options, agentId, channel: name, bound, token, agent });
    return {
      stop() {
        running.stop();
        taken.delete(token);
      },
    };
  });
}

/** Reads messages until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: Omit<DiscordOptions, "name"> & {
    /** The agent's id. */
    agentId: string;
    /** The channel's name, "discord" when left out. */
    channel?: string;
    token: string;
    agent: () => Agent | undefined;
    /** Its `tools` and `job`, read against the agent as it loaded. */
    bound?: Bound;
  },
): Running {
  const { agentId, token } = options;
  const channel = options.channel ?? "discord";
  const api = options.api ?? "https://discord.com/api/v10";
  const rules = rulesOf(options, options.allowFrom ?? []);
  const allowedTypes = options.uploadPolicy?.allowedMediaTypes ?? ["image/*", "application/pdf", "text/*"];
  const maxBytes = options.uploadPolicy?.maxBytes ?? 10 * 1024 * 1024;
  const stopping = new AbortController();
  let socket: WebSocket | undefined;
  let me = "";

  /** One call to Discord's API. A 429 is waited out and asked again, twice at most. */
  async function call<T = any>(method: string, path: string, body?: object | FormData): Promise<T> {
    for (let tries = 0; ; tries++) {
      const form = body instanceof FormData;
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": "DiscordBot (https://chloejs.org, 1.0)",
          ...(body && !form ? { "Content-Type": "application/json" } : {}),
        },
        body: form ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 204) return undefined as T;
      const reply = (await response.json().catch(() => ({}))) as { message?: string; retry_after?: number } & T;
      if (response.status === 429 && tries < 2) {
        await sleep((reply.retry_after ?? 1) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`${method} ${path}: ${reply.message ?? response.status}`);
      return reply;
    }
  }

  /**
   * A direct message is the person's id in chloe's addresses and a channel of
   * its own in Discord's, so the one is kept for the other. An id that is not
   * a person's is taken to be a channel's.
   */
  const dms = new Map<string, string>();
  function keepDm(user: string, room: string): void {
    dms.set(user, room);
    if (dms.size > 500) dms.delete(dms.keys().next().value!);
  }
  async function roomOf(chat: string): Promise<string> {
    if (!dms.has(chat)) {
      const opened = await call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: chat }).catch(() => undefined);
      if (!opened) return chat;
      keepDm(chat, opened.id);
    }
    return dms.get(chat)!;
  }

  /**
   * Sending is not stopped with the reading: a turn already under way still
   * answers. Discord reads the Markdown a model writes, so it goes as it is.
   * Nothing in it pings anybody, whatever it says.
   */
  async function send(room: string, text: string, more: { replyTo?: string; components?: object[] } = {}): Promise<void> {
    const pieces = inPieces(text, MAX_MESSAGE);
    for (const [i, piece] of pieces.entries()) {
      await call("POST", `/channels/${room}/messages`, {
        content: piece,
        allowed_mentions: { parse: [] },
        ...(i === 0 && more.replyTo ? { message_reference: { message_id: more.replyTo, fail_if_not_exists: false } } : {}),
        ...(i === pieces.length - 1 && more.components?.length ? { components: more.components } : {}),
      });
    }
  }

  async function sendFile(room: string, file: FileToSend): Promise<void> {
    const size = (await stat(file.path)).size;
    if (size > MAX_FILE) throw new Error(`${file.name} is ${Math.round(size / 1048576)} MB, and Discord takes 10 MB from a bot.`);
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ allowed_mentions: { parse: [] } }));
    form.set("files[0]", new Blob([await readFile(file.path)]), file.name);
    await call("POST", `/channels/${room}/messages`, form);
  }

  /** Buttons, five to a row and 25 at most, each sending its id back when pressed. Discord holds 100 characters in an id and 80 on a button. */
  function rows(buttons: { label: string; id: string }[]): object[] {
    const fit = buttons.filter((one) => one.id.length <= 100).slice(0, 25);
    const made: object[] = [];
    for (let i = 0; i < fit.length; i += 5) {
      made.push({ type: 1, components: fit.slice(i, i + 5).map((one) => ({ type: 2, style: 2, label: one.label.slice(0, 80), custom_id: one.id })) });
    }
    return made;
  }
  /** A menu to pick several from, sent as one message when it closes. Discord holds 25 choices in one, 100 characters each. */
  function menu(buttons: Button[]): object[] {
    const fit = buttons.filter((one) => one.sends.length <= 100).slice(0, 25);
    if (!fit.length) return [];
    const options = fit.map((one) => ({ label: one.label.slice(0, 100), value: one.sends }));
    return [{ type: 1, components: [{ type: 3, custom_id: "m", placeholder: "Pick any", min_values: 1, max_values: fit.length, options }] }];
  }
  const replyButtons = (buttons: Button[] = [], multiple?: boolean) =>
    multiple ? menu(buttons) : rows(buttons.map((one) => ({ label: one.label, id: `s:${one.sends}` })));

  // A job of this agent's that stops to ask somebody reaches them through this
  // bot, in a direct message when the address is a person's id. Answers that
  // can be listed become buttons, and anything else is answered by the next
  // message in that chat.
  reachBy(
    channel,
    async (to, text, choices, multiple) =>
      send(await roomOf(to), text, {
        components: multiple ? menu((choices ?? []).map((one) => ({ label: one, sends: one }))) : rows((choices ?? []).map((choice, i) => ({ label: choice, id: `a:${i}` }))),
      }),
    agentId,
  );
  if (options.allowFrom?.[0]) ownedBy(agentId, `${channel}:${options.allowFrom[0]}`);

  /** A server channel's name by id, asked of Discord once each. */
  const names = new Map<string, Promise<string>>();
  function roomName(id: string): Promise<string> {
    if (!names.has(id)) names.set(id, call<{ name?: string }>("GET", `/channels/${id}`).then((r) => (r.name ? `#${r.name}` : ""), () => ""));
    return names.get(id)!;
  }

  function wanted(mediaType: string): boolean {
    return allowedTypes.some((one) => (one.endsWith("/*") ? mediaType.startsWith(one.slice(0, -1)) : one === mediaType));
  }

  /** The files on a message, fetched, and a line for each one that was not. */
  async function filesOn(message: DiscordMessage): Promise<{ attachments: Attachment[]; text?: string; notes: string[] }> {
    const attachments: Attachment[] = [];
    const texts: string[] = [];
    const notes: string[] = [];
    for (const file of message.attachments ?? []) {
      const fileName = file.filename ?? "file";
      const mediaType = (file.content_type ?? "application/octet-stream").split(";")[0];
      if (!wanted(mediaType)) notes.push(`(They sent ${fileName}, a ${mediaType}, which this channel does not take.)`);
      else if ((file.size ?? 0) > maxBytes) notes.push(`(They sent ${fileName}, which is over the ${Math.round(maxBytes / 1048576)}MB this channel takes.)`);
      else if (file.url) {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (mediaType.startsWith("text/")) texts.push(`<file name="${fileName}">\n${bytes.toString("utf8")}\n</file>`);
        else {
          attachments.push({ mediaType, data: bytes.toString("base64"), filename: fileName });
          notes.push(`(Attached: ${fileName})`);
        }
      }
    }
    return { attachments, text: texts.join("\n\n") || undefined, notes };
  }

  /** Shows "typing..." until the returned function is called. Discord clears it after ten seconds, so it is sent again every eight. */
  function typing(room: string): () => void {
    const once = () => call("POST", `/channels/${room}/typing`).catch(() => {});
    void once();
    const timer = setInterval(once, 8000);
    return () => clearInterval(timer);
  }

  /**
   * A Discord message in the words every channel shares. In a direct message
   * the chat is the person's user id, which is also where a job asks them
   * something, so their answer comes back from the same address.
   */
  async function incoming(message: DiscordMessage, from: DiscordUser, text: string): Promise<Incoming> {
    const direct = !message.guild_id;
    const chat = direct ? from.id : message.channel_id;
    const mentioned = !!me && (message.mentions ?? []).some((one) => one.id === me);
    const title = direct ? "" : await roomName(message.channel_id);
    const quoted = message.referenced_message;
    return {
      channel,
      chat,
      thread: `${agentId}/${channel}-${chat}`,
      from: { id: from.id, name: from.global_name || from.username || from.id },
      // The mention is how it was addressed, not part of what was said, and would hide a leading "/".
      text: me ? text.replace(new RegExp(`<@!?${me}>`, "g"), "").trim() : text,
      private: direct,
      addressed: mentioned || (!!me && quoted?.author?.id === me),
      chatTitle: title,
      replyTo: quoted?.content ?? "",
      context: {
        chat_type: direct ? "direct" : "server",
        ...(title ? { chat_title: title } : {}),
        is_mentioned: String(mentioned),
      },
      files: () => filesOn(message),
    };
  }

  /** Each message once: a connection taken up again hands over what it missed, which can include what was already read. */
  const seen = new Set<string>();
  function firstTime(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    return true;
  }

  async function onMessage(message: DiscordMessage): Promise<void> {
    const agent = options.agent();
    // 0 is a message and 19 a reply. The rest are joins, pins and the like.
    if (!agent || message.author.bot || message.author.id === me || (message.type !== 0 && message.type !== 19)) return;
    if (!message.content && !message.attachments?.length) return;
    if (!firstTime(message.id)) return;
    const room = message.channel_id;
    if (!message.guild_id) keepDm(message.author.id, room);
    const replyTo = message.guild_id ? message.id : undefined;
    const handled = await receive(agent, await incoming(message, message.author, message.content ?? ""), rules, {
      working: () => typing(room),
      send: (words) => send(room, words),
      sendFile: (file) => sendFile(room, file),
    });
    if (handled?.text) await send(room, handled.text, { replyTo, components: replyButtons(handled.buttons, handled.multiple) }).catch((error) => console.error("discord:", error.message));
  }

  /**
   * A pressed button is sent by whoever pressed it as if they had written it:
   * "a:<n>" sends the button's own words, which is how it answers a waiting
   * job, and "s:<text>" sends that text, which is how a reply's buttons work.
   */
  async function onButton(interaction: Interaction): Promise<void> {
    const agent = options.agent();
    const user = interaction.member?.user ?? interaction.user;
    const message = interaction.message;
    const id = interaction.data?.custom_id ?? "";
    const pressed = message?.components?.flatMap((row) => row.components ?? []).find((one) => one.custom_id === id);
    const picked = interaction.data?.values ?? [];
    const sends = id === "m" ? (picked.length ? together(picked) : undefined) : id.startsWith("s:") ? id.slice(2) : pressed?.label;
    const allowed = !!user && (!rules.allowFrom?.length || rules.allowFrom.includes(user.id));
    // Discord wants an answer within three seconds, so the buttons are taken away first, saying what was chosen.
    const answer = agent && message && sends && allowed ? { type: 7, data: { content: `${message.content ?? ""}\n\n→ ${pressed?.label ?? sends}`, components: [] } } : { type: 6 };
    await call("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, answer).catch((error) => console.error("discord:", error.message));
    if (answer.type !== 7) return;
    const room = interaction.channel_id ?? message!.channel_id;
    const handled = await receive(agent!, { ...(await incoming({ ...message!, guild_id: interaction.guild_id, channel_id: room }, user!, sends!)), addressed: true }, rules);
    if (handled?.text) await send(room, handled.text, { components: replyButtons(handled.buttons, handled.multiple) }).catch(() => {});
  }

  function dispatch(kind: string, data: any): void {
    const failed = (error: Error) => console.error("discord:", error);
    if (kind === "READY") {
      me = data.user?.id ?? "";
      session = { id: data.session_id, url: data.resume_gateway_url };
    }
    if (kind === "READY" || kind === "RESUMED") up = true;
    if (kind === "MESSAGE_CREATE" && data?.author) void onMessage(data).catch(failed);
    // 3 is a pressed button.
    if (kind === "INTERACTION_CREATE" && data?.type === 3) void onButton(data).catch(failed);
  }

  /** Where the last connection got to, so the next takes it up again and is handed what it missed. */
  let session: { id: string; url: string } | undefined;
  let sequence: number | null = null;
  /** Whether the connection got as far as Discord saying it was ready. */
  let up = false;

  /** One connection, until it closes. Returns the code it closed with. */
  function connection(url: string): Promise<number> {
    return new Promise<number>((closed) => {
      const ws = new WebSocket(`${url}/?v=10&encoding=json`);
      socket = ws;
      let first: ReturnType<typeof setTimeout> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      let answered = true;
      const heartbeat = () => ws.send(JSON.stringify({ op: 1, d: sequence }));
      ws.onmessage = (event) => {
        let packet: { op: number; d?: any; s?: number | null; t?: string };
        try {
          packet = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (packet.s != null) sequence = packet.s;
        if (packet.op === 10) {
          // A heartbeat Discord did not answer means the connection is dead
          // without having closed, so it is closed and taken up again.
          const every = packet.d.heartbeat_interval as number;
          const beatOnce = () => {
            if (!answered) return ws.close(4000);
            answered = false;
            heartbeat();
          };
          first = setTimeout(() => {
            beatOnce();
            beat = setInterval(beatOnce, every);
          }, every * Math.random());
          ws.send(
            JSON.stringify(
              session
                ? { op: 6, d: { token, session_id: session.id, seq: sequence } }
                : { op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: "chloe", device: "chloe" } } },
            ),
          );
        } else if (packet.op === 11) answered = true;
        else if (packet.op === 1) heartbeat();
        // 7 asks for a new connection that takes this one up; 9 says it cannot be, when its d is false.
        else if (packet.op === 7) ws.close(4000);
        else if (packet.op === 9) {
          if (!packet.d) session = undefined;
          ws.close(4000);
        } else if (packet.op === 0 && packet.t) dispatch(packet.t, packet.d);
      };
      ws.onclose = (event) => {
        clearTimeout(first);
        clearInterval(beat);
        closed(event.code);
      };
      ws.onerror = () => {};
    });
  }

  /**
   * Connects, and connects again whenever Discord closes it, which it does
   * every so often. Trouble is said once, not every time it is tried again,
   * and the wait between tries doubles up to a minute.
   */
  async function connect(): Promise<void> {
    let said = "";
    let wait = 1000;
    const trouble = (words: string) => {
      if (words !== said) console.error(`discord: ${agentId}: ${words}`);
      said = words;
    };
    while (!stopping.signal.aborted) {
      try {
        const url = session?.url ?? (await call<{ url: string }>("GET", "/gateway/bot")).url;
        up = false;
        const code = await connection(url);
        if (stopping.signal.aborted) break;
        if (up) said = "";
        // Ours is 4000. Any other of 4000 or more ends the session, and 4010 or more needs the owner.
        if (code > 4000) {
          session = undefined;
          sequence = null;
        }
        if (FATAL[code]) trouble(`${FATAL[code]} ${whereKeyGoes(["agents", agentId, "discord"])}.`);
        else if (code >= 4010) trouble(`Discord closed the connection with ${code}, and it is tried again each minute.`);
        else if (!up) trouble(`Discord closed the connection with ${code} before it was ready, and it is tried again.`);
        wait = FATAL[code] || code >= 4010 ? 60_000 : up ? 1000 : Math.min(wait * 2, 60_000);
      } catch (error) {
        if (stopping.signal.aborted) break;
        trouble(`could not reach Discord, and is trying again: ${(error as Error).message}`);
        wait = Math.min(wait * 2, 60_000);
      }
      await sleep(wait, undefined, { signal: stopping.signal }).catch(() => {});
    }
  }
  void connect();

  return {
    stop() {
      stopping.abort();
      socket?.close();
      unreach(channel, agentId);
    },
  };
}
