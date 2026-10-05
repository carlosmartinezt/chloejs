// Reading mail, bound to a fixed search.
//
// The point of this file is the thing it does NOT let a caller do lightly. The
// sign-in this reads with can see the whole mailbox, so a query written at the
// call site is a filter, not a boundary: one prompt injection or one sloppy
// turn and the filter widens. The search comes from the binding in the agent's
// own config, the caller may only choose how far back and how many, and
// fetching a single message re-runs the same search first and refuses an id
// that is not in it.
//
// The tool a model reaches is gmail.ts beside it, which calls this
// with the same binding, so a job does not get a wider search for skipping
// the model.
//
// The sign-in itself is googleService.ts, and every call out goes
// through `gog()` there, so one file holds it, renews it and explains it and
// this one only reads mail.
import type { EmailProvider } from "#chloe/services/emailService";

import { explain, gog, unwrapped } from "./googleService.ts";

export { explain };

/** One message from a mailbox, as a search hands it back. */
export interface Message {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
}

/**
 * The ids each binding has already handed out, oldest first.
 *
 * The boundary is "you may only read what this search listed", and this is what
 * makes that sentence literally true. Checking it by running the search a
 * second time was close but not the same thing, and the difference cost real
 * turns: list with one window, then ask for one message without repeating that
 * window, and the second search returns a different page, so an id just handed
 * over is refused. Asking for more days made it worse rather than better,
 * because the newest ten of a wider window is a different ten.
 *
 * Keyed by the binding's own search, so one agent's list is never another's
 * permission. Capped, because the process outlives any one run.
 */
const listed = new Map<string, Set<string>>();

/** How many ids one binding remembers. Several pages, and still small. */
const REMEMBER = 500;

function remember(search: string, messages: Message[]): void {
  let ids = listed.get(search);
  if (!ids) listed.set(search, (ids = new Set()));
  for (const message of messages) {
    for (const id of [message.id, message.threadId]) {
      if (!id) continue;
      // Re-adding keeps a Set's original position, so drop it first to leave
      // the oldest id genuinely at the front for the trim below.
      ids.delete(id);
      ids.add(id);
    }
  }
  for (const oldest of ids) {
    if (ids.size <= REMEMBER) break;
    ids.delete(oldest);
  }
}

/**
 * Whether this binding may reach this message: either it listed the id earlier,
 * or the search run now returns it. Both halves are the same binding's search,
 * so neither one widens what the agent can see.
 */
async function mayReach(
  { search, days, limit }: { search: string; days: number; limit: number },
  messageId: string,
): Promise<{ query: string; allowed: boolean }> {
  if (listed.get(search)?.has(messageId)) return { query: `${search} newer_than:${days}d`, allowed: true };
  const { query, messages } = await readEmailMessages({ search, days, limit });
  return { query, allowed: messages.some((m) => m.id === messageId || m.threadId === messageId) };
}

/** What the bound search matches. Nothing here widens it. */
export async function readEmailMessages({
  search,
  days = 7,
  limit = 10,
}: {
  search: string;
  days?: number;
  limit?: number;
}): Promise<{ query: string; count: number; messages: Message[] }> {
  const query = `${search} newer_than:${days}d`;
  const messages = await search_(query, limit);
  remember(search, messages);
  return { query, count: messages.length, messages };
}

/**
 * One message in full. An id this binding has never listed is refused, which is
 * what makes the binding a boundary rather than a filter. Same check as the
 * tool, because a job is not more trusted than a model here: it is only more
 * predictable.
 */
export async function readOneEmailMessage({
  search,
  what,
  days = 7,
  limit = 10,
  messageId,
}: {
  search: string;
  what: string;
  days?: number;
  limit?: number;
  messageId: string;
}): Promise<{ query: string; message: unknown }> {
  const { query, allowed } = await mayReach({ search, days, limit }, messageId);
  if (!allowed) {
    throw new Error(
      `That message is not in ${what}. You can only read what this search listed. ` +
        `List it again and use an id from that list.`,
    );
  }
  const out = await gog(["gmail", "get", messageId, "--format", "full", "--json"], { reading: true });
  return { query, message: JSON.parse(out) };
}

async function search_(query: string, max: number): Promise<Message[]> {
  const out = await gog(["gmail", "search", query, "--max", String(max), "--json"], { reading: true });

  // gog wraps results in an envelope on some commands and not others, so take
  // whichever shape came back rather than assuming one.
  const parsed: unknown = JSON.parse(out || "[]");
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>)?.messages ??
       (parsed as Record<string, unknown>)?.threads ??
       (parsed as Record<string, unknown>)?.results ??
       []);
  return (Array.isArray(rows) ? rows : []) as Message[];
}

/**
 * Send one mail as the signed-in account.
 *
 * What `email.provider` of `"gmail"` reaches, so a copy that already has a
 * Google sign-in needs no second account anywhere to send from. It sends as
 * the person, from their own address, which is the difference from Resend: a
 * reply lands in their own mailbox and the mail reads as theirs. That is a
 * reason to choose it and a reason not to.
 */
export async function sendGmail({
  to,
  subject,
  text,
  html,
  replyTo,
  from,
}: {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string[];
  /**
   * The From line. Google only allows the signed-in account or an alias it has
   * verified, so an address that belongs to another provider is refused here
   * rather than quietly rewritten: a mail that went out as somebody else is
   * worse than one that did not go out.
   */
  from?: string;
}): Promise<{ id: string }> {
  // gog takes its addresses as one comma separated list, not a flag each.
  const args = ["gmail", "send", "--to", to.join(","), "--subject", subject, "--body", text, "--json"];
  if (html) args.push("--body-html", html);
  if (replyTo?.length) args.push("--reply-to", replyTo.join(","));
  if (from) args.push("--from", from);
  const out = await gog(args, { timeoutMs: 120_000 });
  const parsed = JSON.parse(out || "{}") as { id?: string; messageId?: string };
  return { id: parsed.id ?? parsed.messageId ?? "" };
}

/** The longest subject a reply will carry over. Longer than any real one. */
const SUBJECT = 200;

/** One line, which is all a mail header can carry. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Who a reply goes to and what its subject is, read off the message being
 * answered.
 *
 * Every input here was written by somebody else, so this is the one place a
 * reply can be talked into something, and all three rules below are about
 * that rather than about tidiness.
 *
 * **One address, and it is the sender's.** A display name can hold angle
 * brackets of its own (`"<them@example.com>" <me@example.com>`), so taking the
 * first bracketed thing in the line would send the reply to an address the
 * sender chose to put in their own name. The quoted part goes first, and a
 * header carrying more than one address is refused rather than guessed at: a
 * second one is either a header nobody should be replying to or somebody
 * trying to be copied in. What is left has to look like one address and
 * nothing else, so a comma (which gog reads as another recipient), a space or
 * a bracket is refused too.
 *
 * **One line.** gog refuses a header value with a newline in it, which is
 * right, and a subject arrives folded across lines often enough. The subject
 * is also written into the frontmatter of the copy an agent keeps, where a
 * newline would be a second field nobody wrote.
 *
 * **The markers come off.** The subject comes back wrapped as somebody else's
 * words, which is what it is, and a header is not a place that can carry them.
 * That is why the length below is capped: unwrapped, the subject is the one
 * piece of the sender's text that comes back to a model as this tool's own
 * answer rather than as marked-up mail, so it is held to the length of a
 * subject and cannot carry a paragraph of instructions.
 */
export function replyTo(headers: Record<string, string>): { to: string; subject: string } {
  // Unwrapped before being chosen between, not after: an empty Reply-To that
  // came back wrapped is still a wrapper, and a wrapper is not falsy.
  const line = oneLine(unwrapped(headers.reply_to ?? "")) || oneLine(unwrapped(headers.from ?? ""));
  const named = line.replace(/"(?:[^"\\]|\\.)*"/g, "");
  const angled = [...named.matchAll(/<([^>]*)>/g)].map((found) => found[1].trim());
  if (angled.length > 1) {
    throw new Error(
      `That message gives more than one address to reply to, so nothing was sent. Reply to it from Gmail.`,
    );
  }
  const to = (angled[0] ?? named).trim();
  if (!/^[^\s,<>"]+@[^\s,<>"]+$/.test(to)) {
    throw new Error(`That message carries no address to reply to, so nothing was sent.`);
  }

  const was = oneLine(unwrapped(headers.subject ?? "")).slice(0, SUBJECT) || "(no subject)";
  return { to, subject: /^re:/i.test(was) ? was : `Re: ${was}` };
}

/**
 * Reply to one message in the mail this binding can see.
 *
 * **The address is never the caller's to choose.** It is read off the message
 * being answered, its `Reply-To` or else its `From`, which is what separates
 * this from sending: a model that can reply can only answer somebody who
 * already wrote in, so a borrowed turn or an instruction buried in an email
 * cannot send mail to a new address. The same id check as reading comes first,
 * so the mail it can answer is the mail it can read and nothing else.
 *
 * It goes out as the signed-in person, in the original thread, with the
 * `In-Reply-To` and `References` headers set, so it reads in both mailboxes as
 * the reply it is rather than as a new message with a similar subject.
 */
export async function replyGmail({
  search,
  what,
  days = 7,
  limit = 10,
  messageId,
  body,
  html,
}: {
  search: string;
  what: string;
  days?: number;
  limit?: number;
  messageId: string;
  /** Plain text. */
  body: string;
  html?: string;
}): Promise<{ sent: true; to: string; subject: string; id: string }> {
  const { allowed } = await mayReach({ search, days, limit }, messageId);
  if (!allowed) {
    throw new Error(
      `That message is not in ${what}, so there is nothing here to reply to. ` +
        `List the mail again and use an id from that list.`,
    );
  }

  // metadata, not full: the headers are all a reply needs, and the body of
  // somebody else's mail does not have to be read again to answer it.
  const out = await gog(["gmail", "get", messageId, "--format", "metadata", "--json"], { reading: true });
  const headers = (JSON.parse(out || "{}") as { headers?: Record<string, string> }).headers ?? {};
  const { to, subject } = replyTo(headers);

  const args = [
    "gmail",
    "send",
    "--to",
    to,
    "--subject",
    subject,
    "--body",
    body,
    "--reply-to-message-id",
    messageId,
    "--json",
  ];
  if (html) args.push("--body-html", html);
  const sent = await gog(args, { timeoutMs: 120_000 });
  const parsed = JSON.parse(sent || "{}") as { id?: string; messageId?: string };
  return { sent: true, to, subject, id: parsed.id ?? parsed.messageId ?? "" };
}

/**
 * Sends as the person, through the Google sign-in this copy already has.
 *
 * No key and no second account: whoever is signed in is who it comes from. So
 * the From line has to be that account or an alias Google has verified for it,
 * and anything else is refused. A reply comes back to their own mailbox, which
 * is the reason to pick this over Resend and the reason not to.
 */
export const gmailProvider: EmailProvider = {
  async send({ from, to, replyTo, subject, body, html }) {
    return await sendGmail({ from, to, replyTo, subject, text: body, html });
  },
};
