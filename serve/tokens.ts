// Tokens for other systems, made and revoked from the runtime site.
//
// A token is not a second password. It opens the read side of the API and the
// agents that bind an api channel, and nothing else: it cannot make or revoke
// tokens, cannot write a file, and cannot reach an agent that has not opted in.
// The account session is the one that can do everything, and it is only ever
// held by a browser somebody signed in on.
//
// The token itself is shown once, when it is made, and never stored. What is
// kept is its sha256, so this file leaking is not the same as the tokens
// leaking. Losing one means revoking it and making another.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

import { STATE } from "#chloe/core/paths.ts";

/** Beside the account and the run history, mode 600. Not in source control. */
const FILE = `${STATE}/tokens.json`;

/** Long enough that guessing is not a strategy. */
const BYTES = 32;

/** So a token is recognisable in a log or a config file as something to rotate. */
const PREFIX = "chloe_";

export interface Token {
  id: string;
  /** What it is for, so revoking the right one does not need guesswork. */
  name: string;
  /** sha256 of the token, base64url. The token itself was never written down. */
  hash: string;
  created: string;
  lastUsed?: string;
  revoked?: string;
}

let held: Token[] | undefined;

function read(): Token[] {
  if (held) return held;
  try {
    held = JSON.parse(readFileSync(FILE, "utf8")) as Token[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    held = [];
  }
  return held;
}

function write(tokens: Token[]): void {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  held = tokens;
}

/** Every token, revoked ones included, newest first. Never the secrets: there are none to give. */
export function tokens(): Token[] {
  return [...read()].sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * A new token. The returned `secret` is the only time it exists in one piece,
 * so whatever asked for it has to hand it over now or make another.
 */
export function makeToken(name: string): { secret: string; token: Token } {
  const called = name.trim();
  if (!called) throw new Error("Give the token a name, so you know what you are revoking later.");
  const secret = PREFIX + crypto.randomBytes(BYTES).toString("base64url");
  const token: Token = {
    id: crypto.randomBytes(8).toString("hex"),
    name: called,
    hash: digest(secret),
    created: new Date().toISOString(),
  };
  write([...read(), token]);
  return { secret, token };
}

/**
 * Stops a token working, now. The record stays so the list can show what was
 * revoked and when: a token that vanishes leaves nobody able to answer "was
 * that one ever real".
 */
export function revokeToken(id: string): Token {
  const all = read();
  const found = all.find((one) => one.id === id);
  if (!found) throw new Error("No token with that id.");
  if (!found.revoked) {
    found.revoked = new Date().toISOString();
    write(all);
  }
  return found;
}

/**
 * The token this value is, or null. Comparing the hashes rather than the
 * values means a wrong guess never gets to see how much of it was right.
 */
export function checkToken(value: string): Token | null {
  if (!value.startsWith(PREFIX)) return null;
  const want = digest(value);
  const found = read().find((one) => !one.revoked && same(one.hash, want));
  if (found) touch(found);
  return found ?? null;
}

/**
 * When it was last used, to the minute. To the minute because every call would
 * otherwise rewrite this file, and the answer nobody needs is the second.
 */
function touch(token: Token): void {
  const now = new Date().toISOString();
  if (token.lastUsed && now.slice(0, 16) === token.lastUsed.slice(0, 16)) return;
  token.lastUsed = now;
  write(read());
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function same(a: string, b: string): boolean {
  const one = Buffer.from(a), two = Buffer.from(b);
  if (one.length !== two.length) return false;
  return crypto.timingSafeEqual(one, two);
}

/** Forgets what was read, so a test can write the file and be believed. */
export function forgetTokens(): void {
  held = undefined;
}
