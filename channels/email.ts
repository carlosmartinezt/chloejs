// Talking to an agent by email. It is one entry in the agent's channels:
//
//   // agents/<id>/agent.ts
//   import { emailChannel } from "@chloejs/core/channels";
//   channels: [emailChannel({ allowFrom: ["someone@example.com"] })],
//
// It needs a remote dashboard: `dashboard.remote.url` and `dashboard.remote.api_key` in settings. The dashboard
// owns the mail domain, so it hands out the addresses and sends the mail, and
// nothing here needs a mail account of its own.
//
// Each conversation has its own address, `reply-<id>@<the dashboard's domain>`,
// made for one person. The agent starts one with `openEmail()` (or the
// `email.startConversation` tool, or a job's `ask("email:<address>")`), and the person's
// replies to that address come back here as messages in that conversation.
//
// A reply reaches the dashboard through its mail worker, and waits in this
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
// for every channel: `tools` keeps a turn here to the tools named, for an
// agent whose other tools reach things this person should not, and `job` hands
// every message to a job instead.
//
// A message is written down as answered only once its answer is sent. The post
// box forgets a delivery only after it has been dealt with, so a restart in the
// middle of a turn gets it again, and it is answered then rather than dropped as
// already seen.
import { randomUUID } from "node:crypto";

import type { Agent, Channel, ChatHistory, Running } from "#chloe/load/load";
import { reachBy, unreach } from "#chloe/model/ask";
import { remember } from "#chloe/model/memory";
import { db } from "#chloe/core/db";
import { readEmail, signedBy, whenSent, type Email, type LookUp } from "#chloe/core/mail";
import { settings, whereKeyGoes } from "#chloe/core/settings";
import { markdownToHtml, markdownToText } from "#chloe/services/emailService";
import { boxFor, collectFrom, type Box } from "./postbox.ts";
import { type Bound, defineChannel, receive, rulesOf, type Shared } from "./shared.ts";

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

/** How an agent is put on email: who may write to it, and what its messages get (`tools` or `job`, see Answering). */
export interface EmailOptions extends Shared {
  /** "email" unless the agent has two. The first half of an address a job asks, "email:someone@example.com". */
  name?: string;
  /** The people it may write to and hear from, by address. Nobody else is ever sent anything. */
  allowFrom: string[];
  /** How much of a conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Where the dashboard is, instead of `dashboard.remote.url` in settings. Only the tests change it. */
  dashboard?: string;
  /** The workspace key, instead of `dashboard.remote.api_key`. Only the tests change it. */
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
export async function openEmail(agent: string, to: string, subject: string, text: string, channel = "email"): Promise<Started> {
  const start = starters.get(`${agent}/${channel}`);
  if (!start) throw new Error(`${agent} has no ${channel} channel running, so it cannot start an email.`);
  return start(to, subject, text);
}

const lower = (address: string) => address.trim().toLowerCase();

/** A name safe to put in front of an address in a From line. */
const displayName = (name: string) => name.replace(/["<>\r\n\\]/g, "").trim().slice(0, 60);

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The message being answered, to go under the answer the way mail programs
 * quote one: "On <when> <who> wrote:" and every line of it, the history it
 * quoted included, so the whole thread travels with each email.
 */
export function quoted(mail: Email): { text: string; html: string } {
  const who = mail.fromName ? `${mail.fromName} <${mail.from[0]}>` : mail.from[0];
  const when = whenSent(mail.date);
  const line = `On ${when ? `${when} ` : ""}${who} wrote:`;
  const lines = mail.text.split("\n").map((one) => (one.startsWith(">") ? `>${one}` : one ? `> ${one}` : ">"));
  return {
    text: `\n\n${line}\n\n${lines.join("\n")}`,
    html:
      `<div class="gmail_quote"><p>${escape(line)}</p>` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escape(mail.text).replace(/\n/g, "<br>")}</blockquote></div>`,
  };
}

/** An agent on email, as a channel its own `agent.ts` names. */
export function emailChannel(options: EmailOptions): Channel {
  // Ignored, it would hand every tool to a turn that was meant to have fewer.
  if ("withoutTools" in options) throw new Error("emailChannel's withoutTools is gone: name the tools its turns may have instead, like tools: [tools.readPage].");
  return defineChannel("email", options, ({ agent, agentId, name, bound }) => {
    const dashboard = (options.dashboard ?? settings.dashboard.remote.url).replace(/\/+$/, "");
    const key = options.key ?? settings.dashboard.remote.api_key;
    if (!dashboard || !key) {
      console.error(
        `email: ${agentId} is on email and has no ${dashboard ? "workspace key" : "dashboard"}. Email goes through a remote dashboard: ` +
          `put the workspace's key ${whereKeyGoes(["dashboard", "remote", "api_key"])}.`,
      );
      return { stop: () => {} };
    }
    return listen({ ...options, agentId, channel: name, dashboard, key, agent, bound });
  }, { hidden: ["lookUp", "key"] });
}

/** Answers on email until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(
  options: EmailOptions & { agentId: string; channel: string; dashboard: string; key: string; agent: () => Agent | undefined; bound?: Bound },
): Running {
  const { agentId, channel, dashboard, key } = options;
  const allowed = options.allowFrom.map(lower);
  const rules = rulesOf(options, allowed);
  const stopping = new AbortController();
  let box: Promise<Box> | undefined;
  const ourBox = () => (box ??= boxFor("email", agentId, channel, dashboard));

  /** One call to the dashboard's mail routes, with the workspace key. */
  async function call<T>(path: string, body: object, what: string): Promise<T> {
    const response = await fetch(`${dashboard}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(`${what}: ${answer.error ?? response.status}`);
    return answer;
  }

  /**
   * Sends Markdown from one of this channel's addresses. When it answers a
   * message it is threaded under it, with that message quoted below.
   */
  async function send(row: Row, subject: string, text: string, answering?: Email): Promise<void> {
    const label = displayName(options.agent()?.label ?? agentId);
    const quote = answering?.text ? quoted(answering) : { text: "", html: "" };
    await call(
      "/mail/send",
      {
        from: row.address,
        name: label,
        subject,
        text: markdownToText(text) + quote.text,
        html: markdownToHtml(text) + quote.html,
        inReplyTo: answering?.messageId || undefined,
        references: answering ? `${answering.references} ${answering.messageId}`.trim() : undefined,
      },
      "sending",
    );
    db.prepare("update email_addresses set used = ? where address = ?").run(new Date().toISOString(), row.address);
  }

  const start: Starter = async (to, subject, text) => {
    const person = lower(to);
    if (!allowed.includes(person)) throw new Error(`${to} is not somebody ${agentId} may email. It may email: ${allowed.join(", ")}.`);
    const mine = await ourBox();
    const { address } = await call<{ address: string }>("/mail/addresses", { box: mine.id, person }, "asking for an address");
    const thread = `${agentId}/${channel}-${randomUUID()}`;
    const at = new Date().toISOString();
    const row: Row = { address: lower(address), agent: agentId, channel, person, thread, subject, made: at, used: at, closed: null, last_id: null, refs: null };
    db.prepare(
      "insert into email_addresses (address, agent, channel, person, thread, subject, made, used) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.address, agentId, channel, person, thread, subject, at, at);
    // The person's own conversation, under the subject, so it is in their list wherever they look.
    db.prepare("insert into threads (thread, label, owner) values (?, ?, ?) on conflict (thread) do nothing").run(thread, subject.slice(0, 80), person);
    await send(row, subject, text);
    remember(thread, "assistant", text);
    return { address: row.address, thread };
  };
  starters.set(`${agentId}/${channel}`, start);
  // A job that stops to ask somebody by email starts a conversation with them.
  reachBy(channel, async (to, text) => void (await start(to, `A question from ${options.agent()?.label ?? agentId}`, text)), agentId);

  /** Message ids already dealt with, so one delivered twice is answered once. */
  const seen = new Set<string>();

  /** One email from the post box: checked, then handed to the agent, and its answer sent back. */
  async function opened(body: string): Promise<void> {
    const { to, raw: encoded } = JSON.parse(body) as { to?: string; raw?: string };
    if (!to || !encoded) return;
    const raw = Buffer.from(encoded, "base64").toString("latin1");
    const drop = (why: string) => console.warn(`email: ${agentId} dropped a message to ${to}: ${why}.`);

    const row = db.prepare("select * from email_addresses where address = ? and agent = ? and channel = ?").get(lower(to), agentId, channel) as Row | undefined;
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
    const agent = options.agent();
    if (!agent) return;
    try {
      await answerMail(agent, row, mail, from);
    } finally {
      db.prepare("update email_addresses set used = ?, last_id = ?, refs = ? where address = ?").run(
        new Date().toISOString(),
        mail.messageId || null,
        mail.references || null,
        row.address,
      );
    }
  }

  /** One checked email handed to the agent, and its answer sent back. */
  async function answerMail(agent: Agent, row: Row, mail: Email, from: string): Promise<void> {
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
        files: files.length ? async () => ({ notes: files }) : undefined,
      },
      rules,
    );
    if (!handled?.text) return;
    const subject = /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject || row.subject}`;
    await send(row, subject, handled.text, mail);
  }

  void ourBox()
    .then((mine) =>
      collectFrom(mine, {
        label: `email: ${agentId}`,
        signal: stopping.signal,
        open: (body) => opened(body).catch((error) => console.error(`email: ${agentId}:`, (error as Error).message)),
      }),
    )
    .catch((error) => console.error(`email: ${agentId}:`, (error as Error).message));

  return {
    stop() {
      stopping.abort();
      starters.delete(`${agentId}/${channel}`);
      unreach(channel, agentId);
    },
  };
}
