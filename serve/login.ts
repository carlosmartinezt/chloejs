// The login in front of the page: one password, set on the first visit.
//
// There is no username, because with one account a name identifies nobody. A
// fresh copy of chloe has no password, so the first person to open the page
// chooses one, and once one exists that door is shut. Changing it afterwards
// takes a shell on the box: `npx chloe account` again.
//
// Hand rolled on node:crypto, scrypt for the password and HMAC-SHA256 for the
// cookie, because the alternative is a dependency for forty lines.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import { STATE } from "#chloe/core/paths";
import { checkToken, type Token } from "./tokens.ts";
import { lockedOut } from "./alerts.ts";

/** The one account, beside the run history, mode 600. Not in source control. */
const FILE = `${STATE}/login.json`;

export const COOKIE = "chloe_session";

/** A week. Long enough not to be a chore, short enough that a stolen cookie dies. */
const LASTS = 7 * 24 * 60 * 60;

/** Five wrong passwords from one address buys fifteen minutes of nothing. */
const TRIES = 5;
const WINDOW = 15 * 60 * 1000;
const LOCKED = 15 * 60 * 1000;

interface Account {
  password: string;
  /** Signs the session cookie. Made with the account, so a restart keeps people signed in. */
  secret: string;
  /** Older copies had one. Read so their file still loads, never checked. */
  username?: string;
}

let account: Account | null | undefined;

function read(): Account | null {
  if (account !== undefined) return account;
  try {
    account = JSON.parse(readFileSync(FILE, "utf8")) as Account;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    account = null;
  }
  return account;
}

export function hasAccount(): boolean {
  return Boolean(read());
}

/**
 * The password this copy will have, from the setup page. Throws if one already
 * exists: the first visit wins, and every visit after it is refused.
 */
export function createAccount(password: string): void {
  if (hasAccount()) throw new Error("A password is already set.");
  write(password);
}

/**
 * A new password for a copy that already has one, for somebody who has a shell.
 * No route calls this and none ever should: the way back in from a forgotten
 * password is `npx chloe account`, and that is the whole of the recovery.
 *
 * Nothing else is touched. The agents, their runs, their memories and the
 * tokens are all somewhere else. Browsers signed in on the old password are
 * signed out, because the secret that signs their cookies is made fresh here.
 */
export function resetPassword(password: string): void {
  write(password);
}

function write(password: string): void {
  if (password.length < 8) throw new Error("The password must be at least 8 characters.");
  const made: Account = {
    password: hash(password),
    secret: crypto.randomBytes(32).toString("base64url"),
  };
  mkdirSync(STATE, { recursive: true });
  writeFileSync(FILE, JSON.stringify(made, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  account = made;
}

/**
 * A password nobody has to think up: twelve characters in groups of four, from
 * an alphabet with no 0/o, 1/l/i or u in it, so reading one off a screen and
 * typing it into a phone works. Sixty bits, which is not guessable.
 */
export function suggestPassword(): string {
  const alphabet = "abcdefghjkmnpqrstvwxyz23456789";
  const pick = (): string =>
    Array.from(crypto.randomBytes(4), (byte) => alphabet[byte % alphabet.length]).join("");
  return [pick(), pick(), pick()].join("-");
}

/**
 * The cookie value for the right password, or the reason it was refused. The
 * address is what the lockout counts, so one person guessing does not lock
 * everybody out.
 */
export function signIn(password: string, from: string): string {
  const held = read();
  if (!held) throw new Error("There is no password yet.");
  const wait = lockedFor(from);
  if (wait) throw new Error(`Too many tries. Try again in ${Math.ceil(wait / 60)} minutes.`);
  if (!check(password, held.password)) {
    countFailure(from);
    throw new Error("Wrong password.");
  }
  failures.delete(from);
  return sign(held);
}

/**
 * Who is making this request. Two different things can be true, and the
 * difference is the whole of the authorisation this runtime has:
 *
 *   account  somebody signed in on this box. Can do everything.
 *   token    another system holding a token. Read, plus the agents that bind
 *            an api channel. Cannot write files, make tokens or revoke them.
 *
 * A browser carries the account session as a cookie. Anything that is not a
 * browser sends either the same session value or a token as
 * `Authorization: Bearer`, and which one it is decides what it may do.
 */
export type Caller =
  | { kind: "account" }
  | { kind: "token"; token: Token }
  | { kind: "dashboard"; user: string; name?: string; guest?: Guest }
  | null;

/**
 * What somebody the workspace's owner invited may do, agent by agent: the
 * switches of `dashboard.remote.allow` they were given on it. An agent that is not a key
 * here is one they cannot see. Never more than `dashboard.remote.allow` allows anybody.
 */
export type Guest = Record<string, string[]>;

export function caller(request: IncomingMessage): Caller {
  const relayed = relayedBy(request);
  if (relayed !== null) {
    const guest = guestOf(request);
    const name = nameOf(request);
    return { kind: "dashboard", user: relayed, ...(name ? { name } : {}), ...(guest ? { guest } : {}) };
  }
  const held = read();
  const values = carried(request);
  if (held && values.some((value) => holds(value, held))) return { kind: "account" };
  for (const value of values) {
    const token = checkToken(value);
    if (token) return { kind: "token", token };
  }
  return null;
}

/**
 * The third kind of caller: a request the dashboard sent down this runtime's
 * own connection to it, which dashboard/connect.ts turns into a request to this
 * port. It carries this secret, which is made when the process starts and
 * never leaves it, so nothing that reaches the port from outside can carry
 * it. What such a caller may have is decided by `dashboard.remote.allow` in settings,
 * in api() in http.ts, and it never has a session: signing in is not relayed.
 */
export const RELAY_SECRET = crypto.randomBytes(32).toString("base64url");

/** The header that carries the secret, and the one that says who asked. */
export const RELAY = "x-chloe-relay";
export const RELAY_USER = "x-chloe-relay-user";

/**
 * Set by the dashboard when who asked is a guest rather than the workspace's
 * owner: JSON, each agent they may reach with the switches they were given on
 * it. Only read on a relayed request. A value that does not read as that is a
 * guest who may do nothing, never an owner.
 */
export const RELAY_GUEST = "x-chloe-relay-guest";

function guestOf(request: IncomingMessage): Guest | undefined {
  const carried = request.headers[RELAY_GUEST];
  const value = Array.isArray(carried) ? carried[0] : carried;
  if (value === undefined) return undefined;
  try {
    const said = JSON.parse(value) as unknown;
    if (!said || typeof said !== "object" || Array.isArray(said)) return {};
    const guest: Guest = {};
    for (const [agent, given] of Object.entries(said)) {
      if (Array.isArray(given)) guest[agent] = given.filter((one): one is string => typeof one === "string");
    }
    return guest;
  } catch {
    return {};
  }
}

/**
 * The name the person who asked goes by on the dashboard, URI encoded, and
 * left out when they have not set one. Only read on a relayed request. It ends
 * up in what an agent is told, so it is cut to one plain line.
 */
export const RELAY_NAME = "x-chloe-relay-name";

function nameOf(request: IncomingMessage): string {
  const carried = request.headers[RELAY_NAME];
  const value = Array.isArray(carried) ? carried[0] : carried;
  if (!value) return "";
  let name: string;
  try {
    name = decodeURIComponent(value);
  } catch {
    return "";
  }
  return name.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The path this runtime's addresses sit under on the dashboard, when the
 * request came from one: `/workspaces/<name>`. A memory file's root-relative
 * links are pointed back into its own memory, and the address they have to end
 * up at is the browser's, not this port's, so the dashboard says what to put in
 * front. Only trusted on a relayed request, and only when it is plain path
 * segments, so nothing from outside can move the frame's links elsewhere.
 */
export const RELAY_UNDER = "x-chloe-relay-under";

export function relayUnder(request: IncomingMessage): string {
  if (relayedBy(request) === null) return "";
  const carried = request.headers[RELAY_UNDER];
  const value = Array.isArray(carried) ? carried[0] : carried;
  return value && /^(?:\/[A-Za-z0-9._~-]+)+$/.test(value) ? value : "";
}

/** The account the dashboard relayed this request for, or null when it is not a relayed request. */
export function relayedBy(request: IncomingMessage): string | null {
  const carried = request.headers[RELAY];
  const value = Array.isArray(carried) ? carried[0] : carried;
  if (!value || !same(value, RELAY_SECRET)) return null;
  const user = request.headers[RELAY_USER];
  return (Array.isArray(user) ? user[0] : user) || "somebody";
}

/** Whether this request carries anything at all this copy will accept. */
export function signedIn(request: IncomingMessage): boolean {
  return caller(request) !== null;
}

/** The session values on a request: the cookie, then the bearer header. */
function carried(request: IncomingMessage): string[] {
  const found: string[] = [];
  const cookie = cookies(request.headers.cookie)[COOKIE];
  if (cookie) found.push(cookie);
  const header = request.headers.authorization ?? "";
  if (header.toLowerCase().startsWith("bearer ")) found.push(header.slice(7).trim());
  return found;
}

/** Whether one value is a session this copy signed, for this account, still in date. */
function holds(value: string, held: Account): boolean {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const body = value.slice(0, dot);
  const expected = crypto.createHmac("sha256", held.secret).update(body).digest("base64url");
  if (!same(value.slice(dot + 1), expected)) return false;
  try {
    const inside = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { until: number };
    return inside.until > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/**
 * The Set-Cookie headers for a session, or for ending one when the value is
 * empty. The cookie carries no Domain, so it is this site's own and nothing
 * else's: a session made on one name is no use on another. A proxy in front of
 * another site asks GET /api/check instead of sharing this.
 */
export function setCookie(value: string, secure: boolean): string[] {
  const rest = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  if (value) return [`${COOKIE}=${value}; Max-Age=${LASTS}; ${rest}`];
  return [`${COOKIE}=; Max-Age=0; ${rest}`];
}

/**
 * A cookie for something already running on this box, like `npm run agent`.
 * It reads the account file, which needs the account's own user, so this is
 * not a way past the login: it is the same permission, said over HTTP.
 */
export function ownCookie(): string {
  const held = read();
  if (!held) throw new Error("There is no password yet. Open the page and set one.");
  return `${COOKIE}=${sign(held)}`;
}

/**
 * Something signed with the account's secret, for a purpose other than a
 * session. The purpose is part of what is signed, so a value made for one
 * purpose can never be passed off as another, and in particular never as a
 * session. Dies with the account, like everything signed here.
 */
export function seal(purpose: string, payload: object): string {
  const held = read();
  if (!held) throw new Error("There is no password yet, so nothing can be signed.");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", held.secret).update(`${purpose}:${body}`).digest("base64url")}`;
}

/** The payload a `seal` made for this purpose, or null when it is not one. */
export function unseal<T>(purpose: string, value: string): T | null {
  const held = read();
  if (!held) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const expected = crypto.createHmac("sha256", held.secret).update(`${purpose}:${body}`).digest("base64url");
  if (!same(value.slice(dot + 1), expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sign(held: Account): string {
  const body = Buffer.from(JSON.stringify({ until: Math.floor(Date.now() / 1000) + LASTS })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", held.secret).update(body).digest("base64url")}`;
}

/**
 * scrypt:N:r:p:salt:hash, colon separated rather than the usual $ separated
 * form: some environment loaders read $16384 as a variable and quietly cut the
 * hash in half, which is a login that always fails and never says why.
 */
function hash(password: string): string {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const made = crypto.scryptSync(password.normalize("NFKC"), salt, 32, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString("base64")}:${made.toString("base64")}`;
}

function check(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, salt, expected] = stored.split(":");
    if (scheme !== "scrypt") return false;
    const want = Buffer.from(expected, "base64");
    const got = crypto.scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), want.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Compares without letting the time it takes say how much of it matched. */
function same(a: string, b: string): boolean {
  const one = Buffer.from(a), two = Buffer.from(b);
  if (one.length !== two.length) return false;
  return crypto.timingSafeEqual(one, two);
}

// In this process, so a restart clears it.
const failures = new Map<string, { count: number; first: number; until: number }>();

function lockedFor(from: string): number {
  const seen = failures.get(from);
  if (!seen) return 0;
  return seen.until > Date.now() ? Math.ceil((seen.until - Date.now()) / 1000) : 0;
}

function countFailure(from: string): void {
  const now = Date.now();
  const seen = failures.get(from);
  if (!seen || now - seen.first > WINDOW) return void failures.set(from, { count: 1, first: now, until: 0 });
  seen.count += 1;
  if (seen.count >= TRIES) {
    Object.assign(seen, { count: 0, first: now, until: now + LOCKED });
    lockedOut(from);
  }
}

/**
 * Who this request is really from, for the lockout and the audit log.
 *
 * The socket address is the proxy's, because this binds loopback and something
 * is always in front. So it comes from a header, and the only question that
 * matters is which part of which header the caller cannot write.
 *
 * `x-forwarded-for` is a list that every hop APPENDS to. So whatever the client
 * sent arrives at the front, and the entry the proxy in front added is at the
 * end. The first entry is therefore the one part of it a stranger controls: a
 * caller sending `x-forwarded-for: 1.2.3.4` and changing it each time would
 * never be locked out, and could lock anybody out by borrowing their address.
 * Read the last entry, which is the address the proxy in front actually saw.
 *
 * `cf-connecting-ip` is better still where it exists, because Cloudflare
 * overwrites rather than appends, so a client cannot put anything in it. It is
 * preferred, and without it the last forwarded entry is the fallback: behind a
 * CDN that is the CDN's own address, which makes the lockout coarse, but coarse
 * and honest beats precise and forgeable.
 *
 * All of this is only as good as the proxy in front, which is the point of
 * binding loopback: nothing else can reach this port to set these headers.
 */
export function from(request: IncomingMessage): string {
  const address = addressOf(request);
  // Through the dashboard, the address is the browser's as the dashboard saw it, and
  // the audit log and the console say whose account it was signed in to.
  const user = relayedBy(request);
  return user === null ? address : `${address} via dashboard as ${user}`;
}

/** The address a request came from, as `from()` reads it, without saying who relayed it. */
export function addressOf(request: IncomingMessage): string {
  const head = (name: string): string[] => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(",").map((one) => one.trim()).filter(Boolean) ?? [];
  };
  const cloudflare = head("cf-connecting-ip")[0];
  const forwarded = head("x-forwarded-for").at(-1);
  return cloudflare || forwarded || request.socket.remoteAddress || "unknown";
}

/** True when the proxy in front is speaking HTTPS, so the cookie can be Secure. */
export function overHttps(request: IncomingMessage): boolean {
  return request.headers["x-forwarded-proto"] === "https";
}

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const one of (header ?? "").split(";")) {
    const at = one.indexOf("=");
    if (at > 0) out[one.slice(0, at).trim()] = one.slice(at + 1).trim();
  }
  return out;
}
