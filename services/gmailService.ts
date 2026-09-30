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
// The tool a model reaches is model/tools/gmail.ts, which calls this
// with the same binding, so a job does not get a wider search for skipping
// the model.
//
// The sign-in itself is services/googleService.ts, and every call out goes
// through `gog()` there, so one file holds it, renews it and explains it and
// this one only reads mail.
import { explain, gog } from "./googleService.ts";

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
  return { query, count: messages.length, messages };
}

/**
 * One message in full. The search runs again first and an id it does not
 * return is refused, which is what makes the binding a boundary rather than a
 * filter. Same check as the tool, because a job is not more trusted than a
 * model here: it is only more predictable.
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
  const { query, messages: found } = await readEmailMessages({ search, days, limit });
  if (!found.some((m) => m.id === messageId || m.threadId === messageId)) {
    throw new Error(
      `That message is not in ${what}. You can only read what this search listed. ` +
        `If it is older than ${days} days, ask for more days.`,
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
