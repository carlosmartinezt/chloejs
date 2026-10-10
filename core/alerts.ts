// Mail when somebody signs in from an address this copy has not seen before,
// when one gets locked out for guessing, and when a job starts failing or
// works again.
//
// The addresses that have been seen are kept beside the run history, so the
// first sign-in after a fresh install is always a new one. That first mail is
// not noise: it is the only one that proves the alert works.
//
// Always through Resend, whatever email.provider says, so a box that sends its
// agents' mail some other way still needs the Resend key for these.
//
// Sending is best effort and never blocks a sign-in. A person who cannot get
// in because a mail server is down would be a worse failure than a sign-in
// nobody was told about, and the sign-in is recorded either way.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { db } from "#chloe/core/db";
import { deliverEmail } from "#chloe/services/emailService";
import { STATE } from "#chloe/core/paths";
import { settings } from "#chloe/core/settings";

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
  const { alerts, api_key, email_to, email_from } = settings.connections.resend;
  const to = email_to.split(",").map((one) => one.trim()).filter(Boolean);
  if (!alerts || !api_key || !to.length || !email_from) return null;
  return { to, from: email_from };
}

/**
 * Whether alerts go out, in words for the startup log: "off", "on, to ...",
 * or "on" and what is missing for any to be sent.
 */
export function alertsSay(): string {
  const { alerts, api_key, email_to, email_from } = settings.connections.resend;
  if (!alerts) return "off";
  const missing = [!api_key && "connections.resend.api_key", !email_to.trim() && "connections.resend.email_to", !email_from && "connections.resend.email_from"].filter(Boolean);
  if (missing.length) return `on, but none can be sent: ${missing.join(", ")} not set`;
  return `on, to ${email_to}`;
}

/** Sends, and says so in the log if it could not. Never throws at the caller. */
function mail(subject: string, body: string): void {
  const address = where();
  if (!address) return;
  void deliverEmail({ from: address.from, to: address.to, tag: "chloe" }, subject, body, "resend").catch((error: unknown) => {
    console.error("could not send the alert:", error instanceof Error ? error.message : error);
  });
}

/** Records a successful sign-in, and mails when the address is a new one. */
export function signedInFrom(address: string): void {
  const all = read();
  const first = !all[address];
  all[address] = new Date().toISOString();
  write(all);
  if (!first) return;
  mail(
    `New sign-in from ${address}`,
    `Somebody signed in from ${address}, which this copy had not seen before.\n\n` +
      `If that was not you, run \`npx chloe account\` on the box for a new password, which signs them out.\n` +
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

/**
 * What to say when a job's run ends, if anything: once when it goes from
 * working to failing, with the error, and once when it works again. Read from
 * the job's own run history, so a job that fails every hour sends one mail and
 * not twenty-four, and a restart in between changes nothing. `since` is when
 * the run began: a run that left no finished row (it is waiting on a person,
 * or never started) says nothing, and neither does a trial run, which is left
 * out of the history it reads.
 */
export function jobTurned(agent: string, job: string, since: string): { subject: string; body: string } | null {
  const [now, before] = db
    .prepare("select finished, error from runs where agent = ? and job = ? and finished is not null and held is null order by finished desc limit 2")
    .all(agent, job) as { finished: string; error: string | null }[];
  if (!now || now.finished < since || Boolean(now.error) === Boolean(before?.error)) return null;
  if (now.error) {
    return {
      subject: `${agent}/${job} is failing`,
      body: `It failed at ${now.finished}:\n\n${now.error.slice(0, 2000)}\n\nYou will hear again when it works, not on every failure.\n`,
    };
  }
  return { subject: `${agent}/${job} works again`, body: `It finished without an error at ${now.finished}.\n` };
}

/** Mails what `jobTurned` says, if anything. Never throws at the caller. */
export function jobEnded(agent: string, job: string, since: string): void {
  try {
    const said = jobTurned(agent, job, since);
    if (said) mail(said.subject, said.body);
  } catch (error) {
    console.error("could not check whether to alert:", error instanceof Error ? error.message : error);
  }
}

/** Forgets what was read, so a test can write the file and be believed. */
export function forgetAddresses(): void {
  seen = undefined;
}
