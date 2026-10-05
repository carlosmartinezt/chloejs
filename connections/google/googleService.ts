// Signing in to Google, and holding that sign-in.
//
// One sign-in reaches mail, the calendar and the files, over Google's own web
// addresses with plain requests, so there is nothing to install beside chloe.
// What this file owns is the sign-in itself: the two halves of it that
// somebody does from a phone, the one file the key is kept in afterwards, and
// `googleApi()`, which every call to Google goes through.
//
// **The key is one file, `token.json` in the state folder, mode 600**, and
// nothing asks a person for a passphrase. Two copies of one secret is how a
// sign-in that works comes to look like one that has expired.
//
// Nothing in here opens a browser, because the person is not at this machine.
// A sign-in is `start()`, which hands back a link, and `finish()`, which takes
// what the link came back with. Whatever carries those two, a chat, Telegram or
// the API, is the caller's business.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { settings, whereKeyGoes } from "#chloe/core/settings";
import { STATE } from "#chloe/core/paths";
import { NeedsSignIn } from "#chloe/connections/connection";

/** Everything Google, in one folder inside the state directory. */
export const GOOGLE = join(STATE, "google");

/** The sign-in: the account and the key that lasts, which Google calls a refresh token. */
const TOKEN = join(GOOGLE, "token.json");

/** A sign-in that has been started and not finished. */
const PENDING = join(GOOGLE, "pending.json");

/** Where a person approves, and where a code or a lasting key is traded for a key that opens Google for an hour. */
const APPROVE = "https://accounts.google.com/o/oauth2/v2/auth";
const TRADE = "https://oauth2.googleapis.com/token";

/** What one sign-in asks Google for, by service. */
export const SERVICES = "gmail,calendar,drive";

/**
 * What each service asks Google for. Mail is read and sent and never deleted,
 * events are read and added, and files are only read: a Doc is read through
 * Drive as text. `openid email` is always asked, to check who approved.
 */
const SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
};

/** What each service is called when telling somebody what a sign-in cannot reach. */
const NAMES: Record<string, string> = { gmail: "mail", calendar: "the calendar", drive: "files" };

/**
 * The services, out of those asked for, that a sign-in was not allowed, read
 * from the scopes Google says it granted. Google lets a person untick a box on
 * its approval page, and a link that lost a scope on its way to them asks for
 * less, so a sign-in that went through is not one that reaches everything.
 * Empty when Google said nothing about scopes.
 */
function notGranted(services: string, scope: string | undefined): string[] {
  if (scope === undefined) return [];
  const granted = new Set(scope.split(/\s+/));
  return services
    .split(",")
    .map((one) => one.trim())
    .filter((one) => SCOPES[one]?.some((each) => !granted.has(each)));
}

/** "mail and files", for services by their names in settings. */
function named(services: string[]): string {
  const words = services.map((one) => NAMES[one] ?? one);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
}

/**
 * The loopback address Google is told to send the answer to when nothing
 * public is catching it.
 *
 * Fixed rather than picked, because Google matches a registered address
 * exactly, port and all, and a different port every time means registering
 * every port there is. Nothing listens on it: the browser fails to load the
 * page, which is expected, and the person pastes the address back.
 */
const PASTE_BACK = "http://127.0.0.1:33067/oauth2/callback";

/**
 * The page that shows the person their code, and the address `connections.google.callback`
 * is meant to be. One address for every copy of chloe there is, because the
 * person carries the code and so nothing here has to know which runtime the
 * answer belongs to.
 *
 * The whole sign-in, as it is meant to go: the agent is asked for mail, says it
 * needs signing in and sends a link, the person approves on their phone, lands
 * here, and sends the short code back to the same chat. The agent checks it
 * against the state it started with and the account it expected, and that is it.
 *
 * What `callback()` uses when nobody said otherwise and the client is a web one.
 * Not for a desktop client, because Google refuses a public address for those, so
 * one of those falls back to the loopback port and a longer paste.
 */
export const SHOWS_THE_CODE = "https://chloejs.org/connected";

/**
 * Thrown when this copy has no client to sign in with, which is the one thing
 * a sign-in cannot start without and the one thing an agent cannot do itself.
 * Its own type, so the tool can hand over the steps instead of the message.
 */
export class NeedsClient extends Error {
  constructor() {
    super("This copy has no Google client to sign in with, so somebody has to make one once. The steps are in setupSteps().");
    this.name = "NeedsClient";
  }
}

/** What a sign-in that was started looks like while it waits for its answer. */
export interface Pending {
  account: string;
  services: string;
  /** Where Google was told to send the answer. A loopback address means somebody pastes it back. */
  redirect: string;
  /** Google hands this back with the code. An answer carrying another is refused. */
  state: string;
  /**
   * The secret half of the code's lock (PKCE), which never leaves this
   * machine, so a code somebody else reads is no use to them.
   */
  verifier: string;
  started: string;
}

/** Where a sign-in stands, without asking Google anything. */
export interface SignInState {
  /** Whether mail and the rest can be reached right now. */
  ready: boolean;
  account: string;
  /** What is missing, in plain words, or empty when nothing is. */
  missing: string;
  /** Whether a link has been sent and the answer has not come back. */
  waiting: boolean;
}

/** The sign-in as it is kept. */
interface Saved {
  account: string;
  refresh_token: string;
  scope?: string;
  saved: string;
}

function folder(): void {
  if (!existsSync(GOOGLE)) mkdirSync(GOOGLE, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeSecret(path: string, value: unknown): void {
  folder();
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The kept sign-in, when it is for the account in settings. */
function saved(): Saved | undefined {
  const held = readJson<Saved>(TOKEN);
  const account = settings.connections.google.account.trim().toLowerCase();
  return held?.refresh_token && account && held.account.toLowerCase() === account ? held : undefined;
}

/**
 * The client this copy signs in with, out of `connections.google.client`: the file
 * Google's console downloads, its path, or its contents as one string.
 */
function clientOf(): { id: string; secret: string } {
  const said = settings.connections.google.client;
  const given = typeof said === "string" ? said.trim() : said;
  if (!given || (typeof given === "object" && Object.keys(given).length === 0)) throw new NeedsClient();
  let parsed: Record<string, unknown>;
  if (typeof given === "object") {
    parsed = given;
  } else {
    const text = given.startsWith("{") ? given : existsSync(given) ? readFileSync(given, "utf8") : undefined;
    if (text === undefined) throw new Error(`connections.google.client points at ${JSON.stringify(given)} and there is no file there.`);
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("connections.google.client is not JSON: it is the file Google's console downloads, its path, or its contents.");
    }
  }
  return mustBeAClient(parsed);
}

/**
 * The id and secret out of the console's own shape, which wraps them in
 * `installed` or `web`.
 *
 * Which of the two decides where Google will agree to send its answer: a
 * desktop client may use any port on this machine and no address on the
 * internet, and a web client is the other way round. A file holding the two
 * values loose does not say which it is, so it is refused rather than guessed
 * at: guessing wrong shows up as Google rejecting the address at the last step.
 */
function mustBeAClient(parsed: Record<string, unknown>): { id: string; secret: string } {
  const inside = (parsed.web ?? parsed.installed) as { client_id?: string; client_secret?: string } | undefined;
  if (inside?.client_id && inside.client_secret) return { id: inside.client_id, secret: inside.client_secret };
  if (parsed.client_id && parsed.client_secret) {
    throw new Error(
      `connections.google.client holds a client id and secret loose, and Google's console does not write them that way. ` +
        `Put them under "installed" for a client made as a desktop app, or under "web" for one made as a web ` +
        `application, and use the file the console downloaded if you still have it. Which of the two it is decides ` +
        `where Google will send its answer, so this is not a guess worth making for you.`,
    );
  }
  throw new Error(`connections.google.client is not a Google client file: it has neither an "installed" nor a "web" section with an id and a secret.`);
}

/**
 * Whether an address is a remote dashboard's own route, which is the one kind that
 * hands the answer back down the connection instead of showing it to somebody.
 * Matched on the route's shape rather than built, so the workspace name in it is
 * whatever it is and nothing here has to know. False when
 * `dashboard.remote.allow.google` is off, because then the dashboard's handing back is refused
 * and nothing would arrive.
 */
function caughtByDashboard(url: string): boolean {
  const dashboard = settings.dashboard.remote.url.trim().replace(/\/+$/, "");
  if (!dashboard || !settings.dashboard.remote.allow.google) return false;
  return url.startsWith(`${dashboard}/oauth/google/callback/`);
}

/**
 * Where Google is told to send its answer, and whether it comes back without
 * anybody carrying it.
 *
 * **The flow this is built for is the one with a code in it.** `connections.google.callback`
 * is `SHOWS_THE_CODE`, one address that is the same for everybody: the person
 * approves on their phone, lands on a page that shows a short code, and sends
 * that code back to the agent in the chat they started in. The code alone is no
 * use to anyone who reads it, because the sign-in uses PKCE and the matching
 * secret never left this machine. Nothing per-copy is registered and no connection has
 * to be up at the right moment.
 *
 * `relayed` means the answer gets back on its own, and that is true for one
 * address only: a remote dashboard's `/oauth/google/callback/<workspace>`, which
 * hands the code down the connection the runtime holds open. Every other
 * address, a page that shows a code included, needs the person to send
 * something back, and saying otherwise leaves them waiting for a sign-in that
 * cannot finish.
 *
 * Unset, it is the page that shows a code for a web client, which is what the
 * console's "Web application" makes, and the loopback port on this machine for a
 * desktop one, because that is the only address Google will take for those. The
 * loopback one reads as a broken page and the person pastes the whole address
 * back, so it is the last resort rather than the aim.
 */
export function callback(): { url: string; relayed: boolean } {
  const said = settings.connections.google.callback.trim();
  if (said) return { url: said, relayed: caughtByDashboard(said) };
  // A desktop client may answer to any port here and to nothing on the internet,
  // so for one of those the loopback address is the only one Google will take.
  // A web client is the other way round, and then the page that shows a code is
  // what somebody actually wants, so it is what they get without asking.
  return { url: clientKind() === "web" ? SHOWS_THE_CODE : "", relayed: false };
}

/**
 * Which kind of client `connections.google.client` holds, "web" or "installed", or "" when
 * there is nothing readable there. Which it is decides where Google will agree to
 * send its answer, so it decides the address when nobody has said one.
 *
 * Read on each call rather than kept: the setting can change while this runs, and
 * this is only asked when a sign-in starts or the console walkthrough is printed.
 */
export function clientKind(): "web" | "installed" | "" {
  const said = settings.connections.google.client;
  let held: Record<string, unknown> | undefined;
  if (said && typeof said === "object") {
    held = said as Record<string, unknown>;
  } else if (typeof said === "string" && said.trim()) {
    const given = said.trim();
    try {
      held = JSON.parse(given.startsWith("{") ? given : readFileSync(given, "utf8")) as Record<string, unknown>;
    } catch {
      // Unreadable or not JSON is said properly by `client()` when a sign-in
      // starts. Here it only means there is nothing to read a kind out of.
      return "";
    }
  }
  if (!held) return "";
  if (held.web) return "web";
  if (held.installed) return "installed";
  return "";
}

/**
 * Where the sign-in stands. Reads files and asks Google nothing, so it is
 * cheap enough for a job to check before it needs mail.
 */
export async function signInState(): Promise<SignInState> {
  const account = settings.connections.google.account;
  const waiting = Boolean(readJson<Pending>(PENDING));
  if (!account) {
    return { ready: false, account, missing: "connections.google.account is not set, so there is no account to sign in", waiting };
  }
  const held = saved();
  if (held) {
    const short = notGranted(SERVICES, held.scope);
    if (!short.length) return { ready: true, account, missing: "", waiting: false };
    return { ready: false, account, missing: `the saved sign-in cannot reach ${named(short)}, so somebody signs in again`, waiting };
  }
  try {
    clientOf();
  } catch (error) {
    return { ready: false, account, missing: (error as Error).message, waiting };
  }
  return {
    ready: false,
    account,
    missing: waiting ? "a sign-in was started and its code has not come back" : "nobody has signed in yet",
    waiting,
  };
}

/** What `start()` hands back. */
export interface Started {
  /** The link the person opens. Nothing else in here matters to them. */
  link: string;
  account: string;
  /** Whether the answer comes back on its own, or the person pastes it. */
  relayed: boolean;
  /** What to say to the person, in plain words, and true whichever way it finishes. */
  say: string;
}

/** Every scope a sign-in for these services asks for. */
function scopesFor(services: string): string[] {
  const asked = services.split(",").map((one) => one.trim()).filter(Boolean);
  const unknown = asked.find((one) => !SCOPES[one]);
  if (unknown) throw new Error(`There is no Google service called ${JSON.stringify(unknown)}. There is ${Object.keys(SCOPES).join(", ")}.`);
  return ["openid", "email", ...asked.flatMap((one) => SCOPES[one])];
}

/**
 * Start a sign-in: hand back a link for the person to open.
 *
 * Everything the second half needs is written down here, so the process can
 * restart, or a job can park for a day, between the two. Google is always
 * asked for consent, because it only hands back a key that lasts when it asks.
 */
export async function start({ services = SERVICES }: { services?: string } = {}): Promise<Started> {
  const account = settings.connections.google.account;
  if (!account) {
    throw new Error("connections.google.account is not set, so there is nobody to sign in. Put the address in chloe.config.ts's settings as `connections: { google: { account: \"you@gmail.com\" } }`.");
  }
  const { id } = clientOf();
  const to = callback();
  const redirect = to.url || PASTE_BACK;
  // PKCE: the code Google hands back only works with this, which never leaves the machine.
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const link = `${APPROVE}?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    login_hint: account,
    scope: scopesFor(services).join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })}`;
  writeSecret(PENDING, { account, services, redirect, state, verifier, started: new Date().toISOString() } satisfies Pending);
  return { link, account, relayed: to.relayed, say: whatToDo(account, to) };
}

/** Whether an address is on the machine the runtime is on, where no browser of the person's can reach it. */
function onThisMachine(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * What to tell the person, which is different in each of the three ways this
 * can end and is the whole of what they experience.
 *
 * The one that reads as broken is the last: nothing is listening on that port,
 * so their browser shows an error and the answer is in the address bar. Saying
 * so in advance is the difference between a step and a fault.
 */
export function whatToDo(account: string, to: { url: string; relayed: boolean }): string {
  const open = `Open this link and approve it as ${account}.`;
  if (to.relayed) return `${open} I will know when you are done, so there is nothing to send back.`;
  if (!onThisMachine(to.url || PASTE_BACK)) {
    return `${open} The page it lands on will show you a short code: send me that code and I will finish.`;
  }
  return (
    `${open} The page it lands on will not load, which is expected, because that address is on my machine ` +
    `and not yours. Copy that page's whole address out of the address bar and send it back to me.`
  );
}

/**
 * The code out of what a person sent: the whole address the browser landed on,
 * or just the code. An address carrying another sign-in's state is refused.
 */
export function codeFrom(answer: string, waiting: Pending): string {
  const text = answer.trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const error = url.searchParams.get("error");
    if (error) throw new Error(`Google said ${error} rather than handing back a code. Start the sign-in again.`);
    const state = url.searchParams.get("state");
    if (state && state !== waiting.state) throw new Error("That address is from another sign-in. Use the link I sent last.");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("That address has no code in it. Send the whole address of the page the browser landed on.");
    return code;
  }
  const code = /^(?:code=)?([\w./~-]+)$/.exec(text)?.[1];
  if (!code) throw new Error(`That does not look like a code or a web address: ${JSON.stringify(text.slice(0, 80))}`);
  return code;
}

/**
 * Whether a message is the answer to the sign-in that is waiting: the address
 * the browser landed on, carrying that sign-in's `state`, or a code in the
 * form Google writes one. Strict, because a message this claims is never seen
 * by the model, and reads only the file the waiting sign-in is in.
 */
export function isAnswer(text: string): boolean {
  const waiting = readJson<Pending>(PENDING);
  if (!waiting) return false;
  const said = text.trim();
  if (/^https?:\/\/\S+$/i.test(said)) {
    try {
      const url = new URL(said);
      return url.searchParams.get("state") === waiting.state && (url.searchParams.has("code") || url.searchParams.has("error"));
    } catch {
      return false;
    }
  }
  return /^(?:code=)?4\/[\w.~-]{20,}$/.test(said);
}

/**
 * Finish a sign-in with whatever came back from the browser.
 *
 * Takes the whole address, or just the code out of it, because a person on a
 * phone sends one or the other and neither is wrong.
 *
 * **Whoever approved has to be the account that was asked for.** A code can be
 * handed in by anybody who has the link, and somebody who approved with their
 * own account would leave the agent reading their mailbox and calling it the
 * configured one. So the address Google vouches for is checked against the
 * account in settings, and anything else is thrown away.
 */
export async function finish(answer: string): Promise<{ account: string; signedIn: true }> {
  const waiting = readJson<Pending>(PENDING);
  if (!waiting) throw new Error("No sign-in is waiting for a code. Start one first, then send what the browser came back with.");
  if (!waiting.verifier) {
    rmSync(PENDING, { force: true });
    throw new Error("That sign-in was started by an older version of this and cannot be finished. Start a new one.");
  }
  const code = codeFrom(answer, waiting);
  const { id, secret } = clientOf();
  // A code works once and for a few minutes, and Google's own words for a bad
  // one are the words for an expired sign-in, which is not what happened.
  const tokens = await trade({
    grant_type: "authorization_code",
    code,
    code_verifier: waiting.verifier,
    redirect_uri: waiting.redirect,
    client_id: id,
    client_secret: secret,
  }).catch((error: Error) => {
    throw new Error(`Google did not take that code, so nothing was saved. A code works once and for a few minutes. (${error.message})`);
  });
  // Straight from Google over HTTPS with this client's secret, so what it says
  // is Google's word, and only the client it was made for is checked.
  const who = tokens.id_token ? idClaims(tokens.id_token) : undefined;
  const approved = who?.aud === id && who.email_verified ? (who.email ?? "").toLowerCase() : "";
  if (approved !== waiting.account.toLowerCase()) {
    rmSync(PENDING, { force: true });
    throw new Error(
      approved
        ? `That sign-in was approved by ${approved} and not by ${waiting.account}, so it was thrown away. Sign in again with that account.`
        : `That sign-in could not be checked against ${waiting.account}, so it was thrown away.`,
    );
  }
  const short = notGranted(waiting.services, tokens.scope);
  if (short.length) {
    rmSync(PENDING, { force: true });
    throw new Error(
      `Google approved the sign-in without ${named(short)}, so it was not kept. On Google's page every box has to be ticked. Sign in again.`,
    );
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google approved but handed back no key that lasts, so nothing was saved. Start the sign-in again: it asks Google for one.",
    );
  }
  writeSecret(TOKEN, { account: waiting.account, refresh_token: tokens.refresh_token, scope: tokens.scope, saved: new Date().toISOString() } satisfies Saved);
  opened = undefined;
  rmSync(PENDING, { force: true });
  return { account: waiting.account, signedIn: true };
}

/** What Google's token address hands back. */
interface Tokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** A form posted to Google's token address, and what came back, or thrown in words, as `NeedsSignIn` when signing in fixes it. */
async function trade(form: Record<string, string>): Promise<Tokens> {
  const response = await fetch(TRADE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw failure(text);
  return JSON.parse(text) as Tokens;
}

/** What an ID token says, read without checking its signature: only for one straight from Google. */
function idClaims(token: string): { aud?: string; email?: string; email_verified?: boolean } | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The key that opens Google now, kept until a minute before it runs out. */
let opened: { key: string; until: number; account: string } | undefined;

/** A key that opens Google for the account in settings, traded for when the last one is about to run out. */
async function accessKey(): Promise<string> {
  const held = saved();
  if (!held) {
    throw settings.connections.google.account
      ? failure("no sign-in")
      : new Error("Google cannot be reached: connections.google.account is not set, so there is no account to read. A person has to set it. Do not retry.");
  }
  // A key that cannot reach everything is a sign-in to do again, said before
  // Google refuses it rather than after.
  if (notGranted(SERVICES, held.scope).length) throw failure("insufficient scope");
  if (opened && opened.account === held.account && opened.until > Date.now()) return opened.key;
  const { id, secret } = clientOf();
  const tokens = await trade({ grant_type: "refresh_token", refresh_token: held.refresh_token, client_id: id, client_secret: secret });
  // Google may hand over a new lasting key, and then the old one stops working.
  if (tokens.refresh_token) writeSecret(TOKEN, { ...held, refresh_token: tokens.refresh_token, saved: new Date().toISOString() });
  opened = { key: tokens.access_token, until: Date.now() + (tokens.expires_in - 60) * 1000, account: held.account };
  return opened.key;
}

/**
 * One call to Google as the signed-in account: an address, its query, and a
 * body sent as JSON. JSON back, or text when `text` is set. Any failure is
 * thrown in words rather than as "invalid_grant", and one that a sign-in fixes
 * as `NeedsSignIn`, which stops a turn before a model can retry it.
 */
export async function googleApi<T>(
  url: string,
  { method = "GET", query, body, text = false }: { method?: string; query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; text?: boolean } = {},
): Promise<T> {
  const address = new URL(url);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) address.searchParams.append(name, String(one));
  }
  const response = await fetch(address, {
    method,
    headers: { authorization: `Bearer ${await accessKey()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const said = await response.text();
  if (response.status === 401) opened = undefined;
  if (!response.ok) throw failure(said || `${response.status} ${response.statusText}`);
  return (text ? said : said ? JSON.parse(said) : {}) as T;
}

/**
 * The trip through Google's console, in order, for the person doing it once.
 *
 * These words are here rather than in a README because the person is on a
 * phone in a chat, and an agent improvising the steps of somebody else's
 * console is an agent inventing menu names. Handed over whole when
 * `connections.google.client` is not set, and that is the only time it is needed.
 *
 * Reading mail is in Google's strictest tier, so a copy of this cannot be
 * signed in to without its own client. There is no way around that short of
 * chloejs itself passing Google's review and paying for the yearly audit that
 * tier requires, which is why the trip exists at all.
 */
export function setupSteps(): { steps: string[]; addresses: string[]; why: string } {
  const to = callback();
  return {
    why:
      "Reading Gmail is in Google's strictest tier, so every copy of this signs in with a client of its own. " +
      "One person makes one once, in about ten minutes, and nobody does it again.",
    addresses: [...new Set([PASTE_BACK, SHOWS_THE_CODE, ...(to.url ? [to.url] : [])])],
    steps: [
      "Go to console.cloud.google.com and make a project. The name does not matter.",
      "Open APIs and Services, then Library, and switch on the Gmail API, the Google Calendar API and the Google Drive API.",
      "Open the Google Auth Platform section. Fill in an app name and your own email as the contact, and choose External for who it is for.",
      "Under Audience, press Publish app so it is In production. Left in Testing, Google ends the sign-in every 7 days. Google will show a warning that it has not checked the app, once, when you approve: it is your own app, so go on past it.",
      "Go to Clients, create an OAuth client, and choose Web application as the type.",
      "Add the redirect addresses listed here, exactly as they are written, one per line in that form.",
      to.relayed
        ? `The ${new URL(to.url).hostname} one is the one that matters: with that registered the sign-in finishes on its own, because the page you land on hands the answer straight back to me.`
        : to.url === SHOWS_THE_CODE
          ? "The chloejs.org one is the one that matters: with that registered, the page you land on shows you a short code to send back. Without it you get a browser error with the answer hidden in its address bar."
          : "The chloejs.org one is optional and worth it, if you make a Web application client: with that registered, the page you land on shows you a short code to send back, instead of a browser error with the answer hidden in its address bar.",
      `Download the client file it gives you, and put its path or its contents ${whereKeyGoes(["connections", "google", "client"])}.`,
      "Then ask me for your mail again, and I will send you the link to approve.",
    ],
  };
}

/**
 * Turn Google's own failures into words. The first three are fixed by one
 * sign-in, which the runtime starts itself when it meets `NeedsSignIn`, so
 * their words say what happened and never what to do about it. The other two
 * need a person in Google's console, and say so.
 */
export function explain(text: string): string {
  if (/invalid_grant|expired or revoked/i.test(text)) return "Google cannot be reached: the saved sign-in has expired or was taken back.";
  if (/no sign-in|no refresh token/i.test(text)) return "Google cannot be reached: nobody has signed in on this copy.";
  if (/insufficient.*(scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
    return "Google cannot be reached: the sign-in was not allowed to do this.";
  }
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(text)) {
    return (
      "Google cannot be reached: this service is not switched on for the client in Google's console. A person " +
      "switches it on under APIs and Services, then Library. Do not retry."
    );
  }
  if (/invalid_client|unauthorized_client/i.test(text)) {
    return "Google cannot be reached: Google refused this copy's client. A person checks connections.google.client. Do not retry.";
  }
  return `Google could not be reached: ${text.trim().slice(0, 300)}`;
}

/** Google's failure as one to throw: `NeedsSignIn` when signing in fixes it, so the runtime starts one. */
export function failure(text: string): Error {
  const said = explain(text);
  return /expired or was taken back|nobody has signed in|not allowed to do this/.test(said) ? new NeedsSignIn("google", said) : new Error(said);
}

/**
 * Text from Google that somebody else wrote (a subject, a mail, a file), marked
 * as theirs for a model reading it. The id is fresh each time, so text inside
 * cannot close a marker it did not open. Only for what goes to a model, never
 * for a value used as data, like an address to reply to.
 */
export function marked(text: string): string {
  const id = randomBytes(6).toString("hex");
  return `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
}
