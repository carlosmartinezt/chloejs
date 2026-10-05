// Signing in to Google, and holding that sign-in.
//
// One sign-in reaches mail, the calendar and the files, through Google's own
// npm packages, so there is nothing to install beside chloe. What this file
// owns is the sign-in itself: the two halves of it that somebody does from a
// phone, and the one file the key is kept in afterwards.
//
// **The key is one file, `token.json` in the state folder, mode 600**, and
// nothing asks a person for a passphrase. Two copies of one secret is how a
// sign-in that works comes to look like one that has expired.
//
// Nothing in here opens a browser, because the person is not at this machine.
// A sign-in is `start()`, which hands back a link, and `finish()`, which takes
// what the link came back with. Whatever carries those two, a chat, Telegram or
// the API, is the caller's business.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import { settings, whereKeyGoes } from "#chloe/core/settings";
import { STATE } from "#chloe/core/paths";

/** Everything Google, in one folder inside the state directory. */
export const GOOGLE = join(STATE, "google");

/** The sign-in: the account and the key that lasts, which Google calls a refresh token. */
const TOKEN = join(GOOGLE, "token.json");

/** A sign-in that has been started and not finished. */
const PENDING = join(GOOGLE, "pending.json");

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
 * The page that shows the person their code, and the address `google.callback`
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
  const account = settings.google.account.trim().toLowerCase();
  return held?.refresh_token && account && held.account.toLowerCase() === account ? held : undefined;
}

/**
 * The client this copy signs in with, out of `google.client`: the file
 * Google's console downloads, its path, or its contents as one string.
 */
function clientOf(): { id: string; secret: string } {
  const said = settings.google.client;
  const given = typeof said === "string" ? said.trim() : said;
  if (!given || (typeof given === "object" && Object.keys(given).length === 0)) throw new NeedsClient();
  let parsed: Record<string, unknown>;
  if (typeof given === "object") {
    parsed = given;
  } else {
    const text = given.startsWith("{") ? given : existsSync(given) ? readFileSync(given, "utf8") : undefined;
    if (text === undefined) throw new Error(`google.client points at ${JSON.stringify(given)} and there is no file there.`);
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("google.client is not JSON: it is the file Google's console downloads, its path, or its contents.");
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
      `google.client holds a client id and secret loose, and Google's console does not write them that way. ` +
        `Put them under "installed" for a client made as a desktop app, or under "web" for one made as a web ` +
        `application, and use the file the console downloaded if you still have it. Which of the two it is decides ` +
        `where Google will send its answer, so this is not a guess worth making for you.`,
    );
  }
  throw new Error(`google.client is not a Google client file: it has neither an "installed" nor a "web" section with an id and a secret.`);
}

/**
 * Whether an address is a Chloe Cloud's own route, which is the one kind that
 * hands the answer back down the connection instead of showing it to somebody.
 * Matched on the route's shape rather than built, so the workspace name in it is
 * whatever it is and nothing here has to know. False when
 * `cloud.remote.google` is off, because then the cloud's handing back is refused
 * and nothing would arrive.
 */
function caughtByCloud(url: string): boolean {
  const cloud = settings.cloud.url.trim().replace(/\/+$/, "");
  if (!cloud || !settings.cloud.remote.google) return false;
  return url.startsWith(`${cloud}/oauth/google/callback/`);
}

/**
 * Where Google is told to send its answer, and whether it comes back without
 * anybody carrying it.
 *
 * **The flow this is built for is the one with a code in it.** `google.callback`
 * is `SHOWS_THE_CODE`, one address that is the same for everybody: the person
 * approves on their phone, lands on a page that shows a short code, and sends
 * that code back to the agent in the chat they started in. The code alone is no
 * use to anyone who reads it, because the sign-in uses PKCE and the matching
 * secret never left this machine. Nothing per-copy is registered and no connection has
 * to be up at the right moment.
 *
 * `relayed` means the answer gets back on its own, and that is true for one
 * address only: a Chloe Cloud's `/oauth/google/callback/<workspace>`, which
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
  const said = settings.google.callback.trim();
  if (said) return { url: said, relayed: caughtByCloud(said) };
  // A desktop client may answer to any port here and to nothing on the internet,
  // so for one of those the loopback address is the only one Google will take.
  // A web client is the other way round, and then the page that shows a code is
  // what somebody actually wants, so it is what they get without asking.
  return { url: clientKind() === "web" ? SHOWS_THE_CODE : "", relayed: false };
}

/**
 * Which kind of client `google.client` holds, "web" or "installed", or "" when
 * there is nothing readable there. Which it is decides where Google will agree to
 * send its answer, so it decides the address when nobody has said one.
 *
 * Read on each call rather than kept: the setting can change while this runs, and
 * this is only asked when a sign-in starts or the console walkthrough is printed.
 */
export function clientKind(): "web" | "installed" | "" {
  const said = settings.google.client;
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
  const account = settings.google.account;
  const waiting = Boolean(readJson<Pending>(PENDING));
  if (!account) {
    return { ready: false, account, missing: "google.account is not set, so there is no account to sign in", waiting };
  }
  if (saved()) return { ready: true, account, missing: "", waiting: false };
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
  const account = settings.google.account;
  if (!account) {
    throw new Error("google.account is not set, so there is nobody to sign in. Put the address in chloe.config.ts's settings as `google: { account: \"you@gmail.com\" }`.");
  }
  const { id, secret } = clientOf();
  const to = callback();
  const redirect = to.url || PASTE_BACK;
  const client = new OAuth2Client({ clientId: id, clientSecret: secret, redirectUri: redirect });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString("base64url");
  const link = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    login_hint: account,
    scope: scopesFor(services),
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
  writeSecret(PENDING, { account, services, redirect, state, verifier: codeVerifier!, started: new Date().toISOString() } satisfies Pending);
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
  const client = new OAuth2Client({ clientId: id, clientSecret: secret, redirectUri: waiting.redirect });
  let tokens;
  try {
    ({ tokens } = await client.getToken({ code, codeVerifier: waiting.verifier, redirect_uri: waiting.redirect }));
  } catch (error) {
    throw new Error(explain((error as Error).message));
  }
  if (!tokens.id_token) throw new Error("Google did not say who approved, so the sign-in was thrown away. Start it again.");
  const who = (await client.verifyIdToken({ idToken: tokens.id_token, audience: id })).getPayload();
  const approved = who?.email_verified ? (who.email ?? "").toLowerCase() : "";
  if (approved !== waiting.account.toLowerCase()) {
    rmSync(PENDING, { force: true });
    throw new Error(
      approved
        ? `That sign-in was approved by ${approved} and not by ${waiting.account}, so it was thrown away. Sign in again with that account.`
        : `That sign-in could not be checked against ${waiting.account}, so it was thrown away.`,
    );
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google approved but handed back no key that lasts, so nothing was saved. Start the sign-in again: it asks Google for one.",
    );
  }
  writeSecret(TOKEN, { account: waiting.account, refresh_token: tokens.refresh_token, scope: tokens.scope ?? undefined, saved: new Date().toISOString() } satisfies Saved);
  rmSync(PENDING, { force: true });
  return { account: waiting.account, signedIn: true };
}

/**
 * A client signed in as the account in settings, for Google's own packages to
 * call with. Thrown, in words an agent can act on, when there is no sign-in.
 */
export function signedIn(): OAuth2Client {
  const held = saved();
  if (!held) {
    throw new Error(
      settings.google.account
        ? explain("no sign-in")
        : "Google cannot be reached: google.account is not set, so there is no account to read. A person has to set it. Do not retry.",
    );
  }
  const { id, secret } = clientOf();
  const client = new OAuth2Client({ clientId: id, clientSecret: secret });
  client.setCredentials({ refresh_token: held.refresh_token });
  // Google may hand over a new key that lasts while refreshing, and the old one then stops working.
  client.on("tokens", (fresh) => {
    if (fresh.refresh_token) writeSecret(TOKEN, { ...held, refresh_token: fresh.refresh_token, saved: new Date().toISOString() });
  });
  return client;
}

/**
 * One call to Google, with any failure turned into words an agent can act on,
 * rather than letting "invalid_grant" reach a model that will retry it forever.
 */
export async function google<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const text = (error as { response?: { data?: unknown } }).response?.data
      ? JSON.stringify((error as { response: { data: unknown } }).response.data)
      : (error as Error).message;
    throw new Error(explain(text));
  }
}

/**
 * The trip through Google's console, in order, for the person doing it once.
 *
 * These words are here rather than in a README because the person is on a
 * phone in a chat, and an agent improvising the steps of somebody else's
 * console is an agent inventing menu names. Handed over whole when
 * `google.client` is not set, and that is the only time it is needed.
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
      `Download the client file it gives you, and put its path or its contents ${whereKeyGoes(["google", "client"])}.`,
      "Tell me when that is done and I will send you the link to approve.",
    ],
  };
}

/**
 * Turn Google's own failures into something an agent can act on. Every one of
 * these but the last two is fixed by one sign-in, and a sign-in is something
 * the agent can start itself, so none of them tells anybody to go to the box.
 */
export function explain(text: string): string {
  const sign = "Start a sign-in with googleSignIn, send the person the link, and do not retry this until they answer.";
  if (/invalid_grant|expired or revoked/i.test(text)) {
    return `Google cannot be reached: the saved sign-in has expired or was taken back. ${sign}`;
  }
  if (/no sign-in|no refresh token/i.test(text)) {
    return `Google cannot be reached: nobody has signed in on this copy. ${sign}`;
  }
  if (/insufficient.*(scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
    return `Google cannot be reached: the sign-in was not allowed to do this. ${sign}`;
  }
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(text)) {
    return (
      "Google cannot be reached: this service is not switched on for the client in Google's console. A person " +
      "switches it on under APIs and Services, then Library. Do not retry."
    );
  }
  if (/invalid_client|unauthorized_client/i.test(text)) {
    return "Google cannot be reached: Google refused this copy's client. A person checks google.client. Do not retry.";
  }
  return `Google could not be reached: ${text.trim().slice(0, 300)}`;
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
