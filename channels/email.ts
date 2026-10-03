// Talking to an agent by email. It is one entry in the agent's channels:
//
//   // agents/<name>/agent.ts
//   import { emailChannel } from "@chloejs/core/channels";
//   channels: [emailChannel({ allowFrom: ["someone@example.com"] })],
//
// It needs a Chloe Cloud: `cloud.url` and `cloud.api_key` in settings. The cloud
// owns the mail domain, so it hands out the addresses and sends the mail, and
// nothing here needs a mail account of its own.
//
// Each conversation has its own address, `reply-<id>@<the cloud's domain>`,
// made for one person. The agent starts one with `startEmail()` (or the
// `start_email` tool, or a job's `ask("email:<address>")`), and the person's
// replies to that address come back here as messages in that conversation.
//
// A reply reaches the cloud through its mail worker, and waits in this
// channel's post box, sealed, until this collects it, the way WhatsApp's do.
// Nothing in between is trusted. A message is taken only when:
//
//   1. it is to an address made here, for this agent and channel, still open,
//      and used in the last 30 days;
//   2. it has one From line, and that is the person the address was made for;
//   3. that person is in allowFrom;
//   4. a DKIM signature on it checks out, made by the domain in the From line
//      (core/mail.ts). The From line alone can be written by anyone.
//
// Anything else is dropped with a line in the log saying why. The address being
// unguessable is the other half: a stranger who could sign as that domain still
// has to know it.
//
// What the person wrote this time is cut from above the quoted history. Files
// on a message are named to the agent and not handed over.
//
// What happens to a message once it is taken is channels/shared.ts, the same
// for every channel. `withoutTools` keeps tools away from every turn on this
// channel, for an agent whose tools reach things this person should not.
import { randomUUID } from "node:crypto";

import type { Agent, Channel, ChatHistory, Running } from "#chloe/load/load";
import { reachBy, unreach } from "#chloe/model/ask";
import { remember } from "#chloe/model/memory";
import { db } from "#chloe/core/db";
import { readEmail, signedBy, type LookUp } from "#chloe/core/mail";
import { settings } from "#chloe/core/settings";
import { markdownToHtml, markdownToText } from "#chloe/services/emailService";
import { boxFor, collectFrom, type Box } from "./postbox.ts";
import { receive, type Rules } from "./shared.ts";

db.exec(`
  create table if not exists email_addresses (
    address text primary key,
    agent   text not null,
    channel text not null,
    person  text not null,
    thread  text not null,
    subject text not null,
    made    text not null,
    used    text not null,
    closed  text,
    last_id text,
    refs    text
  )
`);

/** How long an address stays open with nothing sent or received on it. */
const OPEN_FOR = 30 * 24 * 3600 * 1000;

/** How an agent is put on email: who may write to it, and what its turns may not use. */
export interface EmailOptions {
  /** "email" unless the agent has two. The first half of an address a job asks, "email:someone@example.com". */
  name?: string;
  /** The people it may write to and hear from, by address. Nobody else is ever sent anything. */
  allowFrom: string[];
  /** Tools a turn on this channel is not given, by name, like the ones that read the owner's own mail. */
  withoutTools?: string[];
  /** How much of a conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Where the cloud is, instead of `cloud.url` in settings. Only the tests change it. */
  cloud?: string;
  /** The workspace key, instead of `cloud.api_key`. Only the tests change it. */
  key?: string;
  /** How DNS is asked for a DKIM key. Only the tests change it. */
  lookUp?: LookUp;
}

/** One address as kept here. */
interface Row {
  address: string;
  agent: string;
  channel: string;
  person: string;
  thread: string;
  subject: string;
  made: string;
  used: string;
  closed: string | null;
  last_id: string | null;
  refs: string | null;
}

/** What starting a conversation gives back. */
export interface Started {
  /** The address the person replies to. */
  address: string;
  /** The conversation it is, as every channel names one. */
  thread: string;
}

type Starter = (to: string, subject: string, text: string) => Promise<Started>;

const starters = new Map<string, Starter>();

/**
 * Emails one of the people an agent's email channel allows, from a new address
 * made for that conversation, and keeps the words in it so a reply is read with
 * them. Refused for anybody not in allowFrom, and when the channel is not
 * running.
 */
export async function startEmail(agent: string, to: string, subject: string, text: string, channel = "email"): Promise<Started> {
  const start = starters.get(`${agent}/${channel}`);
  if (!start) throw new Error(`${agent} has no ${channel} channel running, so it cannot start an email.`);
  return start(to, subject, text);
}

const lower = (address: string) => address.trim().toLowerCase();

/** A name safe to put in front of an address in a From line. */
const displayName = (name: string) => name.replace(/["<>\r\n\\]/g, "").trim().slice(0, 60);

/** An agent on email, as a channel its own `agent.ts` names. */
export function emailChannel(options: EmailOptions): Channel {
  return {
    name: options.name ?? "email",
    chatHistory: options.chatHistory,
    madeWith: JSON.stringify({ ...options, lookUp: undefined, key: undefined }),
    start(agent) {
      const name = agent()?.name ?? "";
      const cloud = (options.cloud ?? settings.cloud.url).replace(/\/+$/, "");
      const key = options.key ?? settings.cloud.api_key;
      if (!cloud || !key) {
        console.error(
          `email: ${name} is on email and has no ${cloud ? "workspace key" : "cloud"}. Email goes through a Chloe Cloud: ` +
            `put the workspace's key in .env as CHLOE_CLOUD_API_KEY.`,
        );
        return { stop: () => {} };
      }
      return listen({ ...options, name, channel: options.name ?? "email", cloud, key, agent });
    },
  };
}

/** Answers on email until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: EmailOptions & { name: string; channel: string; cloud: string; key: string; agent: () => Agent | undefined },
): Running {
  const { name, channel, cloud, key } = options;
  const allowed = options.allowFrom.map(lower);
  const rules: Rules = { allowFrom: allowed, chatHistory: options.chatHistory };
  const stopping = new AbortController();
  let box: Promise<Box> | undefined;
  const ourBox = () => (box ??= boxFor("email", name, channel, cloud));

  /** One call to the cloud's mail routes, with the workspace key. */
  async function call<T>(path: string, body: object, what: string): Promise<T> {
    const response = await fetch(`${cloud}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(`${what}: ${answer.error ?? response.status}`);
    return answer;
  }

  /** Sends Markdown from one of this channel's addresses, threaded under a message when there is one. */
  async function send(row: Row, subject: string, text: string, answering?: { id: string; refs: string }): Promise<void> {
    const label = displayName(options.agent()?.label ?? name);
    await call(
      "/mail/send",
      {
        from: row.address,
        name: label,
        subject,
        text: markdownToText(text),
        html: markdownToHtml(text),
        inReplyTo: answering?.id || undefined,
        references: answering ? `${answering.refs} ${answering.id}`.trim() : undefined,
      },
      "sending",
    );
    db.prepare("update email_addresses set used = ? where address = ?").run(new Date().toISOString(), row.address);
  }

  const start: Starter = async (to, subject, text) => {
    const person = lower(to);
    if (!allowed.includes(person)) throw new Error(`${to} is not somebody ${name} may email. It may email: ${allowed.join(", ")}.`);
    const mine = await ourBox();
    const { address } = await call<{ address: string }>("/mail/addresses", { box: mine.id, person }, "asking for an address");
    const thread = `${name}/${channel}-${randomUUID()}`;
    const at = new Date().toISOString();
    const row: Row = { address: lower(address), agent: name, channel, person, thread, subject, made: at, used: at, closed: null, last_id: null, refs: null };
    db.prepare(
      "insert into email_addresses (address, agent, channel, person, thread, subject, made, used) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.address, name, channel, person, thread, subject, at, at);
    // The person's own conversation, under the subject, so it is in their list wherever they look.
    db.prepare("insert into threads (thread, label, owner) values (?, ?, ?) on conflict (thread) do nothing").run(thread, subject.slice(0, 80), person);
    await send(row, subject, text);
    remember(thread, "assistant", text);
    return { address: row.address, thread };
  };
  starters.set(`${name}/${channel}`, start);
  // A job that stops to ask somebody by email starts a conversation with them.
  reachBy(channel, async (to, text) => void (await start(to, `A question from ${options.agent()?.label ?? name}`, text)), name);

  /** Message ids already dealt with, so one delivered twice is answered once. */
  const seen = new Set<string>();

  /** One email from the post box: checked, then handed to the agent, and its answer sent back. */
  async function opened(body: string): Promise<void> {
    const { to, raw: encoded } = JSON.parse(body) as { to?: string; raw?: string };
    if (!to || !encoded) return;
    const raw = Buffer.from(encoded, "base64").toString("latin1");
    const drop = (why: string) => console.warn(`email: ${name} dropped a message to ${to}: ${why}.`);

    const row = db.prepare("select * from email_addresses where address = ? and agent = ? and channel = ?").get(lower(to), name, channel) as Row | undefined;
    if (!row) return drop("that address was not made here");
    if (row.closed) return drop("that address is closed");
    if (Date.now() - Date.parse(row.used) > OPEN_FOR) {
      db.prepare("update email_addresses set closed = ? where address = ?").run(new Date().toISOString(), row.address);
      return drop("that address was not used for 30 days, and is closed now");
    }
    const mail = readEmail(raw);
    if (mail.from.length !== 1) return drop(`it has ${mail.from.length} From addresses`);
    const [from] = mail.from;
    if (from !== row.person) return drop(`it is from ${from}, and the address was made for ${row.person}`);
    if (!allowed.includes(from)) return drop(`${from} is not in allowFrom`);
    if (!mail.to.includes(row.address)) return drop("the address is not in its To or Cc");
    const signed = await signedBy(raw, from.slice(from.lastIndexOf("@") + 1), options.lookUp);
    if (!signed.ok) return drop(`it could not be shown to come from ${from}: ${signed.why}`);
    if (mail.messageId) {
      if (seen.has(mail.messageId) || row.last_id === mail.messageId) return;
      seen.add(mail.messageId);
      if (seen.size > 500) for (const oldest of seen) if (seen.delete(oldest)) break;
    }
    db.prepare("update email_addresses set used = ?, last_id = ?, refs = ? where address = ?").run(
      new Date().toISOString(),
      mail.messageId || null,
      mail.references || null,
      row.address,
    );

    const agent = options.agent();
    if (!agent) return;
    const said = mail.reply || mail.text;
    const files = mail.files.map((one) => `(They attached ${one}, which this channel does not hand over.)`);
    if (!said && !files.length) return;
    const handled = await receive(
      agent,
      {
        channel,
        chat: from,
        thread: row.thread,
        from: { id: from, name: mail.fromName || from },
        text: said,
        private: true,
        context: { address: from, subject: mail.subject || row.subject },
        withoutTools: options.withoutTools,
        files: files.length ? async () => ({ notes: files }) : undefined,
      },
      rules,
    );
    if (!handled?.text) return;
    const subject = /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject || row.subject}`;
    await send(row, subject, handled.text, { id: mail.messageId, refs: mail.references });
  }

  void ourBox()
    .then((mine) =>
      collectFrom(mine, {
        label: `email: ${name}`,
        signal: stopping.signal,
        open: (body) => opened(body).catch((error) => console.error(`email: ${name}:`, (error as Error).message)),
      }),
    )
    .catch((error) => console.error(`email: ${name}:`, (error as Error).message));

  return {
    stop() {
      stopping.abort();
      starters.delete(`${name}/${channel}`);
      unreach(channel, name);
    },
  };
}
