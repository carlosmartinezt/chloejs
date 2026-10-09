// The people the owner invites, each to one or more agents, and the
// invitations on their way to them.
//
// The owner invites somebody by email from the page and gets a link back, once,
// to send them however they like: the runtime sends nothing. Opening the link,
// the person chooses a password, and from then on signs in with their email and
// that password. A link works once, for a week.
//
// Somebody invited sees the agents they were let in to and nothing else of the
// owner's, and on each of those only what they were given: chat (their own
// conversations), read (their own runs) and run (start a job). Nothing they
// are given lets them change anything. What each route allows them is
// `guest` on the route, in http.ts. Taking somebody off their last agent
// removes them, and signs them out at once, since every request reads this
// table again.
import crypto from "node:crypto";

import { db } from "#chloe/core/db";
import { checkPassword, hashPassword } from "./password.ts";

/** What somebody can be given on an agent. */
export const SWITCHES = ["chat", "read", "run"] as const;
export type Switch = (typeof SWITCHES)[number];

/** Each agent a person may reach, with what they were given on it. */
export type Given = Record<string, Switch[]>;

/** How long an invitation can be used for. */
const LASTS = 7 * 24 * 60 * 60 * 1000;

db.exec(`
  create table if not exists people (
    email     text primary key,
    name      text not null,
    password  text not null,
    given     text not null,
    added     text not null
  );
  create table if not exists invitations (
    hash      text primary key,
    email     text not null,
    name      text not null,
    agent     text not null,
    given     text not null,
    created   text not null,
    expires   text not null,
    used      text
  );
`);

/** Somebody invited, as kept. */
export interface Person {
  email: string;
  name: string;
  /** The password as `hashPassword` keeps it. */
  password: string;
  given: Given;
  added: string;
}

/** Only the switches there are, each once, in a fixed order. Chat when nothing is left. */
export function cleanGiven(asked: readonly string[] | undefined): Switch[] {
  const kept = SWITCHES.filter((one) => (asked ?? ["chat"]).includes(one));
  return kept.length ? kept : ["chat"];
}

/** An address as it is kept: trimmed and lowercase. Throws when it does not read as one. */
export function cleanEmail(email: string): string {
  const said = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(said) || said.length > 200) throw new Error(`${JSON.stringify(email)} is not an email address.`);
  return said;
}

/** A name safe to show and to tell an agent: one plain line. */
function cleanName(name: string): string {
  return name.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function readGiven(text: string): Given {
  try {
    const said = JSON.parse(text) as Record<string, string[]>;
    return Object.fromEntries(Object.entries(said).map(([agent, given]) => [agent, cleanGiven(given)]));
  } catch {
    return {};
  }
}

const now = () => new Date().toISOString();
const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

/** The person with that email, or undefined. */
export function person(email: string): Person | undefined {
  const row = db.prepare("select * from people where email = ?").get(email.trim().toLowerCase()) as (Omit<Person, "given"> & { given: string }) | undefined;
  return row ? { ...row, given: readGiven(row.given) } : undefined;
}

/** Everybody let in, and the invitations nobody has used yet that are still in date. The owner's. */
export function people(): {
  people: { email: string; name: string; given: Given; added: string }[];
  invitations: { email: string; name: string; agent: string; given: Switch[]; created: string; expires: string }[];
} {
  const rows = db.prepare("select email, name, given, added from people order by added").all() as { email: string; name: string; given: string; added: string }[];
  const open = db
    .prepare("select email, name, agent, given, created, expires from invitations where used is null and expires > ? order by created")
    .all(now()) as { email: string; name: string; agent: string; given: string; created: string; expires: string }[];
  return {
    people: rows.map((one) => ({ ...one, given: readGiven(one.given) })),
    invitations: open.map((one) => ({ ...one, given: cleanGiven(JSON.parse(one.given) as string[]) })),
  };
}

/**
 * An invitation to one agent, and the code that takes it, which is handed
 * back here once and kept only as a hash. Inviting the same address to the
 * same agent again replaces the invitation still open.
 */
export function invite(email: string, name: string, agent: string, given: readonly string[]): string {
  const address = cleanEmail(email);
  const code = crypto.randomBytes(24).toString("base64url");
  db.prepare("delete from invitations where email = ? and agent = ? and used is null").run(address, agent);
  db.prepare("insert into invitations (hash, email, name, agent, given, created, expires) values (?, ?, ?, ?, ?, ?, ?)").run(
    hashOf(code),
    address,
    cleanName(name),
    agent,
    JSON.stringify(cleanGiven(given)),
    now(),
    new Date(Date.now() + LASTS).toISOString(),
  );
  return code;
}

/** What an invitation is for, while it can still be used, and whether its address is somebody already let in. */
export function invitation(code: string): { email: string; name: string; agent: string; given: Switch[]; known: boolean } | null {
  const row = db.prepare("select * from invitations where hash = ? and used is null and expires > ?").get(hashOf(code), now()) as
    | { email: string; name: string; agent: string; given: string }
    | undefined;
  if (!row) return null;
  return { email: row.email, name: row.name, agent: row.agent, given: cleanGiven(JSON.parse(row.given) as string[]), known: Boolean(person(row.email)) };
}

/**
 * Takes an invitation: the agent it was for is the person's from now on.
 * Somebody new chooses their password here; somebody already let in to
 * another agent proves it is them with the one they have. Returns their email.
 */
export function accept(code: string, password: string, name = ""): string {
  const found = invitation(code);
  if (!found) throw new Error("That invitation is used, out of date, or was never made.");
  const already = person(found.email);
  if (already) {
    if (!checkPassword(password, already.password)) throw new Error("Wrong password. Use the one you chose when you were first invited.");
    const given = { ...already.given, [found.agent]: found.given };
    db.prepare("update people set given = ? where email = ?").run(JSON.stringify(given), found.email);
  } else {
    if (password.length < 8) throw new Error("The password must be at least 8 characters.");
    const called = cleanName(name) || found.name || found.email;
    db.prepare("insert into people (email, name, password, given, added) values (?, ?, ?, ?, ?)").run(
      found.email,
      called,
      hashPassword(password),
      JSON.stringify({ [found.agent]: found.given }),
      now(),
    );
  }
  db.prepare("update invitations set used = ? where hash = ?").run(now(), hashOf(code));
  return found.email;
}

/** Changes what somebody may do on one agent, whether they are in or still invited. */
export function change(email: string, agent: string, given: readonly string[]): void {
  const address = cleanEmail(email);
  const switches = JSON.stringify(cleanGiven(given));
  db.prepare("update invitations set given = ? where email = ? and agent = ? and used is null").run(switches, address, agent);
  const found = person(address);
  if (found?.given[agent]) {
    db.prepare("update people set given = ? where email = ?").run(JSON.stringify({ ...found.given, [agent]: cleanGiven(given) }), address);
  }
}

/** Takes somebody off one agent, at once. Off their last one, they are removed. An open invitation to it stops working. */
export function remove(email: string, agent: string): void {
  const address = cleanEmail(email);
  db.prepare("delete from invitations where email = ? and agent = ? and used is null").run(address, agent);
  const found = person(address);
  if (!found) return;
  const { [agent]: _, ...rest } = found.given;
  if (Object.keys(rest).length) db.prepare("update people set given = ? where email = ?").run(JSON.stringify(rest), address);
  else db.prepare("delete from people where email = ?").run(address);
}
