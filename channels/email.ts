// Talking to an agent by email. It is one entry in the agent's channels:
//
//   // agents/<id>/agent.ts
//   import { emailChannel } from "@chloejs/core/channels";
//   channels: [emailChannel({ allowFrom: ["someone@example.com"] })],
//
// Each conversation has its own address, made for one person. The agent starts
// one with `openEmail()` (or the `email.startConversation` tool, or a job's
// `ask("email:<address>")`), and the person's replies to that address come back
// here as messages in that conversation. The mail goes through one of two
// places:
//
//   Gmail: `emailChannel({ allowFrom, mailbox: "gmail" })`. The mailbox is the
//   account Google is signed in to (`connections.google.account`), the same
//   sign-in the mail tools use. Mail goes out from that account under the
//   agent's name, and its reply address is the account with a tag,
//   `you+<8 letters>@gmail.com`, which Gmail delivers to the same inbox. The
//   runtime asks Gmail what is new every few seconds, the way Telegram is
//   polled, so nothing reaches in from outside and nothing else is involved. It
//   looks only at what is addressed to one of its own tagged addresses; the
//   rest of the mailbox is never read.
//
//   A mailbox signed in to with a password: `emailChannel({ allowFrom,
//   mailbox: "password" })` signs in to `agents.<id>.email` in settings, an
//   address and an app password, reads it with IMAP and sends with SMTP
//   (connections/mail/mailbox.ts). Everything else is as on Gmail: the tagged
//   addresses, asking what is new, and reading only what is addressed to a tag.
//   The provider must deliver `you+tag@` to `you@`: Gmail, iCloud and Fastmail do.
//
//   A mailbox of your own making: `mailbox` is an object that makes an
//   address for a conversation, sends from it, and hands over what arrives
//   (`Mailbox`), for mail that goes through a service of your choosing.
//
// Nothing in between is trusted either way. A message is taken only when:
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
// A message is written down as answered only once its answer is sent. Gmail is
// asked again from where it was up to, and a mailbox of your own should forget
// a delivery only once `take` has finished with it, so a restart in the middle
// of a turn gets it again, and it is answered then rather than dropped as
// already seen.
import { randomInt, randomUUID } from "node:crypto";

import { google } from "#chloe/connections/google/connection";
import { rawMail } from "#chloe/connections/google/gmailService";
import { gmailMailbox } from "#chloe/connections/google/mailbox";
import { passwordMailbox } from "#chloe/connections/mail/mailbox";
import type { Agent, Channel, ChatHistory, Running } from "#chloe/load/load";
import { reachBy, unreach } from "#chloe/model/ask";
import { remember } from "#chloe/model/memory";
import { holdBack } from "#chloe/core/current";
import { db } from "#chloe/core/db";
import { addresses, readEmail, signedBy, whenSent, type Email, type Inbox, type LookUp } from "#chloe/core/mail";
import { settings, whereKeyGoes } from "#chloe/core/settings";
import { markdownToHtml, markdownToText } from "#chloe/services/emailService";
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

// Where each channel on Gmail or a password is up to in its mailbox, so a restart asks from
// there and misses nothing that arrived while it was down.
db.exec(`
  create table if not exists email_mailbox (
    agent   text not null,
    channel text not null,
    history text not null,
    primary key (agent, channel)
  )
`);

/** How often a channel on Gmail or a password asks what is new. */
const EVERY = 15_000;

/** How long an address stays open with nothing sent or received on it. */
const OPEN_FOR = 30 * 24 * 3600 * 1000;

/** One email a mailbox of your own sends, from one of the addresses it made. */
export interface OutgoingMail {
  /** The address it goes out from: one `address()` made. */
  from: string;
  /** The agent's name, to put in front of `from`. */
  name: string;
  /** The one person it goes to. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The message it answers, for threading. Not set on the first email of a conversation. */
  inReplyTo?: string;
  /** The ids of the messages before it in the thread, space separated. */
  references?: string;
}

/**
 * A mailbox of your own making, for mail that goes through a service you
 * chose rather than Gmail. Give one as `mailbox` on `emailChannel()`. The
 * channel still checks every message itself: the address, the sender, and a
 * DKIM signature from the sender's domain.
 */
export interface Mailbox {
  /** A new address for one conversation with `person`. Their replies to it come back through `receive`. */
  address(person: string): Promise<string>;
  /** Sends one email. Throws when it could not be sent. */
  send(mail: OutgoingMail): Promise<void>;
  /**
   * Hands over each email that arrives until `signal` aborts: the address it
   * was sent to, and the whole message as it arrived, one character per byte
   * (latin1). Forget a delivery only once `take` has finished with it, so a
   * restart in the middle of an answer gets it again.
   */
  receive(take: (to: string, raw: string) => Promise<void>, signal: AbortSignal): Promise<void>;
}

/**
 * The options for `emailChannel()`: who the agent may write to, and which
 * mailbox it uses. It also takes `tools` and `job` (see `Answering`).
 */
export interface EmailOptions extends Shared {
  /**
   * The channel's name. Default: "email".
   *
   * Set it only when the agent has two email channels, because two channels
   * of one agent cannot share a name. It is the first part of the address a
   * job uses to ask somebody, like `email:someone@example.com`.
   */
  name?: string;
  /**
   * The email addresses of the people the agent may write to and hear from.
   * Nobody else is ever sent anything, and mail from anybody else is
   * dropped. Required.
   */
  allowFrom: string[];
  /**
   * How much of the conversation the agent sees with each new message:
   * `{ messages, days }`. `messages` is the most it sees, and `days` leaves
   * out anything older. Default: the last 10 messages.
   */
  chatHistory?: ChatHistory;
  /**
   * Which mailbox the mail goes through. Required.
   *
   * - "gmail": the Gmail account Google is signed in to
   *   (`connections.google.account` in settings).
   * - "password": the mailbox in `agents.<id>.email` in settings, an address
   *   and an app password, on any provider that delivers `you+tag@` to
   *   `you@` (Gmail, iCloud, Fastmail).
   * - A `Mailbox`: one of your own making, for another mail service.
   */
  mailbox: "gmail" | "password" | Mailbox;
  /** Stands in for Gmail or the password mailbox. Only the tests set it. */
  gmail?: Inbox;
  /** How often the mailbox is asked for new mail, in milliseconds. Default: 15000. Only the tests change it. */
  every?: number;
  /** How DNS is asked for the key that checks a DKIM signature. Only the tests change it. */
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

/** What `openEmail()` returns: the new conversation. */
export interface Started {
  /** The new address the person replies to. */
  address: string;
  /** The id of the conversation. The agent remembers it under this id. */
  thread: string;
}

type Starter = (to: string, subject: string, text: string) => Promise<Started>;

const starters = new Map<string, Starter>();

/**
 * Starts an email conversation. Sends an email to one of the people in the
 * `allowFrom` of an agent's email channel, from a new address made for this
 * conversation. The words are kept in the conversation, so when the person
 * replies, the agent knows what it wrote.
 *
 * - `agent`: the agent's id.
 * - `to`, `subject`, `text`: the email. `text` is Markdown.
 * - `channel`: the email channel's name. Default: "email".
 *
 * Throws when `to` is not in `allowFrom`, or when the channel is not running
 * in this process. In a trial run nothing is sent and no conversation is
 * made: the run's record keeps the email, and `address` and `thread` are "".
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

/** Letters a tag is made of: no l, o, 0 or 1, which read as each other. */
const LETTERS = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * A new address for one conversation: the account with a tag, which Gmail
 * delivers to the same inbox. 8 letters, 40 random bits, so nobody guesses one.
 */
function tagged(address: string): string {
  const at = address.lastIndexOf("@");
  let tag = "";
  for (let i = 0; i < 8; i++) tag += LETTERS[randomInt(LETTERS.length)];
  return `${address.slice(0, at).split("+")[0]}+${tag}${address.slice(at)}`;
}

/**
 * Puts an agent on email. Add it to the `channels` list in the agent's
 * `agent.ts`:
 *
 * ```ts
 * channels: [emailChannel({ allowFrom: ["someone@example.com"], mailbox: "gmail" })],
 * ```
 *
 * Each conversation has its own address, made for one person. The agent
 * starts one with `openEmail()`, the `email.startConversation` tool, or a
 * job's `ask("email:<address>")`. The person's replies to that address come
 * back as messages in that conversation.
 *
 * A reply is taken only when all of these are true. Anything else is dropped,
 * with a line in the log.
 *
 * - It is sent to an open address made for this agent and channel, used in
 *   the last 30 days.
 * - It has one sender, the person the address was made for, and that person
 *   is in `allowFrom`.
 * - It has a DKIM signature from the sender's domain that checks out.
 *   Anybody can write any From line, so this is what shows who sent it.
 *
 * Files on a message are named to the agent, but it does not receive them.
 */
export function emailChannel(options: EmailOptions): Channel {
  // Ignored, it would hand every tool to a turn that was meant to have fewer.
  if ("withoutTools" in options) throw new Error("emailChannel's withoutTools is gone: name the tools its turns may have instead, like tools: [tools.readPage].");
  const channel = defineChannel("email", options, ({ agent, agentId, name, bound }) => {
    if (options.mailbox !== "gmail" && options.mailbox !== "password" && typeof options.mailbox?.receive !== "function") {
      console.error(
        `email: ${agentId} is on email with no mailbox. Put it on Gmail, emailChannel({ mailbox: "gmail", ... }), which uses ` +
          `the Google sign-in the mail tools use, on a mailbox with an app password, emailChannel({ mailbox: "password", ... }), ` +
          `or give it a mailbox of your own.`,
      );
      return { stop: () => {} };
    }
    if (options.mailbox === "password" && !options.gmail) {
      const held = settings.agents[agentId]?.email;
      if (!held?.address.includes("@") || !held.password) {
        console.error(
          `email: ${agentId} is on a mailbox with a password, and has no address or password. Put the address ` +
            `in chloe.config.ts's settings as \`agents: { ${agentId}: { email: { address: "you@example.com" } } }\`, and the app password ` +
            `${whereKeyGoes(["agents", agentId, "email", "password"])}.`,
        );
        return { stop: () => {} };
      }
      return listen({ ...options, gmail: passwordMailbox(held), agentId, channel: name, agent, bound });
    }
    return listen({ ...options, agentId, channel: name, agent, bound });
  }, { hidden: ["lookUp", "gmail", "every"] });
  // On Gmail it works through the Google sign-in, so the agent's Connections
  // page lists it and can sign in, even with no Gmail tool beside it.
  if (options.mailbox === "gmail") channel.needs = google;
  return channel;
}

/** Answers on email until stopped. Separate from the channel so the tests can point it somewhere else. */
export function listen(options: EmailOptions & { agentId: string; channel: string; agent: () => Agent | undefined; bound?: Bound }): Running {
  const { agentId, channel } = options;
  const own = typeof options.mailbox === "object" ? options.mailbox : undefined;
  const gmail = own ? undefined : (options.gmail ?? gmailMailbox);
  const allowed = options.allowFrom.map(lower);
  const rules = rulesOf(options, allowed);
  const stopping = new AbortController();

  /**
   * Sends Markdown from one of this channel's addresses. When it answers a
   * message it is threaded under it, with that message quoted below.
   */
  async function send(row: Row, subject: string, text: string, answering?: Email, threadId?: string): Promise<void> {
    const label = displayName(options.agent()?.label ?? agentId);
    const quote = answering?.text ? quoted(answering) : { text: "", html: "" };
    if (gmail) {
      const references = answering ? `${answering.references} ${answering.messageId}`.trim() : "";
      const raw = rawMail({
        from: `"${label}" <${gmail.account()}>`,
        to: [row.person],
        replyTo: [row.address],
        subject,
        text: markdownToText(text) + quote.text,
        html: markdownToHtml(text) + quote.html,
        inReplyTo: answering?.messageId || undefined,
        references: references || undefined,
      });
      await gmail.send(raw, threadId);
      db.prepare("update email_addresses set used = ? where address = ?").run(new Date().toISOString(), row.address);
      return;
    }
    await own!.send({
      from: row.address,
      name: label,
      to: row.person,
      subject,
      text: markdownToText(text) + quote.text,
      html: markdownToHtml(text) + quote.html,
      inReplyTo: answering?.messageId || undefined,
      references: answering ? `${answering.references} ${answering.messageId}`.trim() || undefined : undefined,
    });
    db.prepare("update email_addresses set used = ? where address = ?").run(new Date().toISOString(), row.address);
  }

  const start: Starter = async (to, subject, text) => {
    const person = lower(to);
    if (!allowed.includes(person)) throw new Error(`${to} is not somebody ${agentId} may email. It may email: ${allowed.join(", ")}.`);
    if (holdBack({ kind: "email", to: person, subject, text })) return { address: "", thread: "" };
    const address = gmail ? tagged(gmail.account()) : await own!.address(person);
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

  /** One email to one of this channel's addresses: checked, then handed to the agent, and its answer sent back. */
  async function take(to: string, raw: string, threadId?: string): Promise<void> {
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
      await answerMail(agent, row, mail, from, threadId);
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
  async function answerMail(agent: Agent, row: Row, mail: Email, from: string, threadId?: string): Promise<void> {
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
    await send(row, subject, handled.text, mail, threadId);
  }

  /**
   * Asks the mailbox what arrived since last time, and takes what is addressed to one
   * of this channel's open addresses. Where it is up to is written down only
   * after everything new was dealt with, so a restart in the middle asks again
   * and a reply cut off halfway is answered then.
   */
  async function check(box: Inbox): Promise<void> {
    const kept = db.prepare("select history from email_mailbox where agent = ? and channel = ?").get(agentId, channel) as { history: string } | undefined;
    const keep = (history: string) =>
      db.prepare("insert into email_mailbox (agent, channel, history) values (?, ?, ?) on conflict (agent, channel) do update set history = excluded.history").run(agentId, channel, history);
    if (!kept) return void keep(await box.now());
    const found = await box.since(kept.history);
    if (found === "gone") {
      console.warn(`email: ${agentId} can no longer ask its mailbox what it missed (away too long, or the mailbox was numbered again), and starts from now.`);
      return void keep(await box.now());
    }
    const open = new Set(
      (db.prepare("select address from email_addresses where agent = ? and channel = ? and closed is null").all(agentId, channel) as { address: string }[]).map((one) => one.address),
    );
    const done = new Set<string>();
    for (const { id, threadId } of found.added) {
      if (done.has(id) || !open.size) continue;
      done.add(id);
      const to = addresses(await box.recipients(id)).list.find((one) => open.has(one));
      if (!to) continue;
      await take(to, await box.raw(id), threadId).catch((error) => console.error(`email: ${agentId}:`, (error as Error).message));
    }
    keep(found.history);
  }

  if (gmail) {
    void (async () => {
      const every = options.every ?? EVERY;
      let wait = every;
      let said = "";
      while (!stopping.signal.aborted) {
        try {
          await check(gmail);
          wait = every;
          said = "";
        } catch (error) {
          const why = (error as Error).message;
          // Said once, not every few seconds: a sign-in to do stays true until somebody does it.
          if (why !== said) console.error(`email: ${agentId} could not read ${options.mailbox === "gmail" ? "Gmail" : "its mailbox"}: ${why}`);
          said = why;
          wait = Math.min(5 * 60_000, wait * 2);
        }
        await new Promise((done) => {
          const timer = setTimeout(done, wait);
          stopping.signal.addEventListener("abort", () => (clearTimeout(timer), done(undefined)), { once: true });
        });
      }
    })();
  } else {
    own!
      .receive((to, raw) => take(to, raw).catch((error) => console.error(`email: ${agentId}:`, (error as Error).message)), stopping.signal)
      .catch((error) => console.error(`email: ${agentId}:`, (error as Error).message));
  }

  return {
    stop() {
      stopping.abort();
      starters.delete(`${agentId}/${channel}`);
      unreach(channel, agentId);
    },
  };
}
