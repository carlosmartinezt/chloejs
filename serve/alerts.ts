// Mail when somebody signs in from an address this copy has not seen before,
// and when one gets locked out for guessing.
//
// The addresses that have been seen are kept beside the run history, so the
// first sign-in after a fresh install is always a new one. That first mail is
// not noise: it is the only one that proves the alert works.
//
// Sending is best effort and never blocks a sign-in. A person who cannot get
// in because a mail server is down would be a worse failure than a sign-in
// nobody was told about, and the sign-in is recorded either way.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { sendEmail } from "#chloe/services/emailService.ts";
import { STATE } from "#chloe/core/paths.ts";
import { settings } from "#chloe/core/settings.ts";

const FILE = `${STATE}/seen-addresses.json`;

let seen: Record<string, string> | undefined;

function read(): Record<string, string> {
  if (seen) return seen;
  try {
    seen = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
  } catch {
    seen = {};
  }
  return seen;
}

function write(all: Record<string, string>): void {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  seen = all;
}

function where(): { to: string[]; from: string } | null {
  const to = settings.alerts.email_to.split(",").map((one) => one.trim()).filter(Boolean);
  if (!to.length || !settings.alerts.email_from) return null;
  return { to, from: settings.alerts.email_from };
}

/** Sends, and says so in the log if it could not. Never throws at the caller. */
function mail(subject: string, body: string): void {
  const address = where();
  if (!address) return;
  void sendEmail({ from: address.from, to: address.to, tag: "chloe" }, subject, body).catch((error: unknown) => {
    console.error("could not send the alert:", error instanceof Error ? error.message : error);
  });
}

/** Records a successful sign-in, and mails when the address is a new one. */
export function signedInFrom(username: string, address: string): void {
  const all = read();
  const first = !all[address];
  all[address] = new Date().toISOString();
  write(all);
  if (!first) return;
  mail(
    `New sign-in from ${address}`,
    `${username} signed in from ${address}, which this copy had not seen before.\n\n` +
      `If that was not you, change the password: delete data/login.json on the box and run \`npm run account\`.\n` +
      `Revoke every token at the same time, from the site's tokens page.\n`,
  );
}

/** Mails when one address has been locked out for guessing. */
export function lockedOut(address: string): void {
  mail(
    `Locked out ${address}`,
    `Too many wrong passwords from ${address}, so it is locked out for fifteen minutes.\n`,
  );
}

/** Forgets what was read, so a test can write the file and be believed. */
export function forgetAddresses(): void {
  seen = undefined;
}
