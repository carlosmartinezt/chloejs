// Reading mail, bound to a fixed search.
//
// The point of this file is the thing it does NOT let a caller do lightly. The
// token `gog` holds can read the whole mailbox, so a query written at the call
// site is a filter, not a boundary: one prompt injection or one sloppy turn
// and the filter widens. The search comes from the binding in the agent's own
// config, the caller may only choose how far back and how many, and fetching a
// single message re-runs the same search first and refuses an id that is not
// in it.
//
// The tool a model reaches is model/tools/gmail.ts, which calls this
// with the same binding, so a job does not get a wider search for skipping
// the model.
import { run } from "./runService.ts";
import { setting, settings } from "#chloe/core/settings.ts";

const GOG = "gog";

/** gog reads its account and the password to its saved login from these two. */
function gog(): Record<string, string> {
  return {
    GOG_ACCOUNT: setting(settings.google.account, "GOG_ACCOUNT"),
    GOG_KEYRING_PASSWORD: setting(settings.google.password, "GOG_KEYRING_PASSWORD"),
  };
}

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
export async function messages({
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
export async function oneMessage({
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
  const { query, messages: found } = await messages({ search, days, limit });
  if (!found.some((m) => m.id === messageId || m.threadId === messageId)) {
    throw new Error(
      `That message is not in ${what}. You can only read what this search listed. ` +
        `If it is older than ${days} days, ask for more days.`,
    );
  }
  const result = await run(GOG, ["gmail", "get", messageId, "--format", "full", "--json"], {
    timeoutMs: 60_000,
    env: gog(),
  });
  if (result.exitCode !== 0) throw new Error(explain(result.stderr || result.stdout));
  return { query, message: JSON.parse(result.stdout) };
}

async function search_(query: string, max: number): Promise<Message[]> {
  const result = await run(GOG, ["gmail", "search", query, "--max", String(max), "--json"], {
    timeoutMs: 60_000,
    env: gog(),
  });
  if (result.exitCode !== 0) throw new Error(explain(result.stderr || result.stdout));

  // gog wraps results in an envelope on some commands and not others, so take
  // whichever shape came back rather than assuming one.
  const parsed: unknown = JSON.parse(result.stdout || "[]");
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>)?.messages ??
       (parsed as Record<string, unknown>)?.threads ??
       (parsed as Record<string, unknown>)?.results ??
       []);
  return (Array.isArray(rows) ? rows : []) as Message[];
}

/**
 * The command a person runs to sign in again, built from the account that is
 * actually configured rather than written down: no file in this repo may name
 * a person. Signing in is the one fix an agent cannot do for itself, so the
 * message carries the command ready to paste.
 */
function signIn(): string {
  const account = gog().GOG_ACCOUNT;
  return account ? `${GOG} auth login --account ${account}` : `${GOG} auth login`;
}

/**
 * Turn the CLI's own failures into something an agent can act on, rather than
 * letting "integrity check failed" reach a model that will retry it forever.
 *
 * Where a person has to do something, say exactly what, as a command they can
 * paste. An agent that answers "you need to re-authenticate" has made someone
 * go and look up how.
 */
export function explain(text: string): string {
  if (/integrity check failed|KeyUnwrap/i.test(text)) {
    return (
      "Mail is not reachable: the saved Google login could not be opened, " +
      "usually because google.password in settings.local.json does not match the one it was saved with. " +
      `A person has to sign in again on the box, with this command exactly as written: ${signIn()} ` +
      "Give them that command. Do not retry."
    );
  }
  // The keyring opened but Google refused the saved refresh token: it expired,
  // was revoked, or the account's password changed. Nothing an agent can do.
  if (/invalid_grant|token has been expired or revoked/i.test(text)) {
    return (
      "Mail is not reachable: the saved Google sign-in has expired or was revoked. " +
      `A person has to sign in again on the box, with this command exactly as written: ${signIn()} ` +
      "Give them that command. Do not retry."
    );
  }
  if (/no TTY|GOG_KEYRING_PASSWORD/i.test(text)) {
    return (
      "Mail is not reachable: google.password is not set, so the saved login cannot be opened. " +
      "A person has to set it in settings.local.json and restart the service. Do not retry."
    );
  }
  if (/missing --account|GOG_ACCOUNT/i.test(text)) {
    return (
      "Mail is not reachable: google.account is not set, so there is no account to read. " +
      "A person has to set it in settings.local.json and restart the service. Do not retry."
    );
  }
  return `Mail could not be read: ${text.trim().slice(0, 300)}`;
}
