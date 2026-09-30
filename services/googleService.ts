// Signing in to Google, and holding that sign-in.
//
// One sign-in reaches mail, the calendar, the files and the documents, because
// the work is done by gog, one downloaded program with nothing under it. What
// this file owns is everything around gog: the folder it keeps its config and
// its locked keyring in, the passphrase that opens that keyring, and the two
// halves of a sign-in that somebody does from a phone.
//
// **The passphrase is made here and shown to nobody.** It was a setting once,
// and gog asks for it at a prompt too, so a person who signed in by hand and
// typed a different one left the two disagreeing. That reads as
// "integrity check failed", looks exactly like a sign-in that has expired, and
// cost this box seventeen days of unreadable mail. There is one copy now, in
// one file, and no prompt anybody can answer.
//
// Nothing in here opens a browser, because the person is not at this machine.
// A sign-in is `start()`, which hands back a link, and `finish()`, which takes
// what the link came back with. Whatever carries those two, a chat, Telegram or
// the API, is the caller's business.
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { settings } from "#chloe/core/settings";
import { STATE } from "#chloe/core/paths";

import { run } from "./runService.ts";

/**
 * The oldest gog this works with. `--home` arrived in 0.42.0, and without it
 * gog writes into the person's own config folder, where a second copy of the
 * sign-in is exactly the thing this file exists to prevent.
 */
export const NEEDS_GOG = "0.42.0";

/** Everything Google, in one folder inside the state directory. */
export const GOOGLE = join(STATE, "google");

/** Where gog keeps its config, its client and its locked keyring. */
const GOG_HOME = join(GOOGLE, "gog");

/** The passphrase that opens that keyring. Made once, read after that, never shown. */
const PASS = join(GOOGLE, "keyring.pass");

/** The client Google's console gave this install, as gog wants it: a file. */
const CLIENT = join(GOOGLE, "client.json");

/** A sign-in that has been started and not finished. */
const PENDING = join(GOOGLE, "pending.json");

/** Where a downloaded gog goes, when the machine has none. */
const BIN = join(GOOGLE, "bin");

/** What one sign-in asks Google for. Read is mail in, send is mail out. */
export const SERVICES = "gmail,calendar,drive,docs,sheets";

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

/** Which release to fetch, and where from. */
const RELEASE = (version: string, asset: string) =>
  `https://github.com/openclaw/gogcli/releases/download/v${version}/${asset}`;

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
  /** Google hands this back with the code, and gog checks it. Kept so a bare code can be rebuilt into a link. */
  state: string;
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

function folder(): void {
  for (const dir of [GOOGLE, GOG_HOME]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * The passphrase, made on first use.
 *
 * Written before it is used, and read every time after, so the keyring and the
 * passphrase are made in the same breath and cannot be made apart.
 */
function passphrase(): string {
  folder();
  if (!existsSync(PASS)) {
    writeFileSync(PASS, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  chmodSync(PASS, 0o600);
  return readFileSync(PASS, "utf8").trim();
}

/**
 * The environment every gog call gets: which folder, which account, and the
 * passphrase. Nothing else, and never the caller's own environment, so a gog
 * on this machine that somebody set up by hand is not reached by accident.
 */
function where(): Record<string, string> {
  return {
    GOG_HOME,
    GOG_ACCOUNT: settings.google.account,
    GOG_KEYRING_PASSWORD: passphrase(),
    // The one backend that works with nobody logged in. Left to itself gog
    // looks for a desktop keyring first, which on a server is a prompt that
    // never gets answered.
    GOG_KEYRING_BACKEND: "file",
  };
}

/** What `gog --version` prints, as three numbers, or nothing when it does not run. */
async function version(program: string): Promise<number[] | undefined> {
  const result = await run(program, ["--version"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return undefined;
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined;
}

function old(has: number[], wants: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((has[i] ?? 0) !== (wants[i] ?? 0)) return (has[i] ?? 0) < (wants[i] ?? 0);
  }
  return false;
}

/** The release asset for this machine. */
function asset(v: string): string {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `gogcli_${v}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
}

/**
 * The program, fetched if this machine has none new enough.
 *
 * Downloaded to the state folder rather than anywhere on the path, because
 * nothing here may write outside what the runtime owns. The checksum is
 * checked before anything is unpacked: the file arrives over the internet and
 * is then run, so the one thing worth being strict about is that it is the file
 * the release says it is.
 */
export async function ensureGog(): Promise<string> {
  const wants = NEEDS_GOG.split(".").map(Number);

  const named = settings.google.gog;
  if (named) {
    const has = await version(named);
    if (!has) throw new Error(`google.gog is set to ${JSON.stringify(named)} and that does not run.`);
    if (old(has, wants)) {
      throw new Error(
        `google.gog is ${has.join(".")} and this needs ${NEEDS_GOG} or newer. Point it at a newer one or unset it and let chloe fetch its own.`,
      );
    }
    return named;
  }

  const own = join(BIN, process.platform === "win32" ? "gog.exe" : "gog");
  for (const candidate of [own, "gog"]) {
    const has = await version(candidate);
    if (has && !old(has, wants)) return candidate;
  }

  return await fetchGog(settings.google.version || NEEDS_GOG, own);
}

/** Download one release, check it, unpack it, and hand back the program. */
async function fetchGog(v: string, to: string): Promise<string> {
  folder();
  if (!existsSync(BIN)) mkdirSync(BIN, { recursive: true, mode: 0o700 });

  const name = asset(v);
  const sums = await fetch(RELEASE(v, "checksums.txt"));
  if (!sums.ok) throw new Error(`Could not read the checksums for gog ${v}: ${sums.status}.`);
  const want = (await sums.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === name)?.[0];
  if (!want) throw new Error(`The gog ${v} release has no ${name}, so this machine is not one it builds for.`);

  const got = await fetch(RELEASE(v, name));
  if (!got.ok) throw new Error(`Could not download gog ${v}: ${got.status}.`);
  const bytes = Buffer.from(await got.arrayBuffer());
  const is = createHash("sha256").update(bytes).digest("hex");
  if (is !== want) {
    throw new Error(`The gog ${v} download does not match its checksum, so it was thrown away.`);
  }

  const packed = join(BIN, name);
  writeFileSync(packed, bytes, { mode: 0o600 });
  // tar reads both of the shapes a release comes in, and is on macOS, Linux
  // and Windows 10 and later alike, so this is one call and not three.
  const out = await run("tar", ["-xf", packed, "-C", BIN], { timeoutMs: 120_000 });
  rmSync(packed, { force: true });
  if (out.exitCode !== 0) throw new Error(`Could not unpack gog ${v}: ${out.stderr || out.stdout}`);
  if (!existsSync(to)) throw new Error(`gog ${v} unpacked without a program in it.`);
  chmodSync(to, 0o700);
  return to;
}

/**
 * The client this install signs in with, handed to gog once.
 *
 * `google.client` is either the path to the file Google's console downloads or
 * that file's contents pasted into the setting, because one of those is what a
 * person has in front of them and which one depends on where they are.
 */
async function client(program: string): Promise<void> {
  const held = await run(program, ["auth", "credentials", "list", "-p"], { timeoutMs: 20_000, env: where() });
  if (held.exitCode === 0 && held.stdout.trim()) return;

  const given = settings.google.client.trim();
  if (!given) {
    throw new NeedsClient();
  }

  let path = given;
  if (given.startsWith("{")) {
    folder();
    writeFileSync(CLIENT, given, { mode: 0o600 });
    path = CLIENT;
  }
  if (!existsSync(path)) {
    throw new Error(`google.client points at ${JSON.stringify(path)} and there is no file there.`);
  }
  mustBeAClientFile(path);
  const set = await run(program, ["auth", "credentials", "set", path], { timeoutMs: 20_000, env: where() });
  if (set.exitCode !== 0) throw new Error(`That Google client was refused: ${set.stderr || set.stdout}`);
}

/**
 * Check the client file is the one Google's console downloads, before gog
 * refuses it in its own words.
 *
 * The console wraps everything in `installed` or `web`, and which of the two
 * decides where Google will agree to send its answer: a desktop client may use
 * any port on this machine and no address on the internet, and a web client is
 * the other way round. A file holding the two values loose, which some tools
 * used to write, does not say which it is, so it is refused rather than
 * guessed at: guessing wrong shows up as Google rejecting the address at the
 * last step, long after this.
 */
function mustBeAClientFile(path: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`google.client points at ${JSON.stringify(path)} and that is not JSON.`);
  }
  if (parsed.installed || parsed.web) return;
  if (parsed.client_id && parsed.client_secret) {
    throw new Error(
      `${path} holds a client id and secret loose, and Google's console does not write them that way. ` +
        `Put them under "installed" for a client made as a desktop app, or under "web" for one made as a web ` +
        `application, and use the file the console downloaded if you still have it. Which of the two it is decides ` +
        `where Google will send its answer, so this is not a guess worth making for you.`,
    );
  }
  throw new Error(`${path} is not a Google client file: it has neither an "installed" nor a "web" section.`);
}

/**
 * Where Google is told to send its answer.
 *
 * `google.callback` is a public address that catches it, and the answer then
 * comes down the connection this runtime already holds open, so the sign-in
 * finishes with nobody pasting anything. It is set by hand rather than worked
 * out, because Google matches the address it was registered with exactly and a
 * guess that is one character out fails at the last step.
 *
 * Unset, the answer goes to a loopback port on this machine, which the
 * person's browser cannot reach, so they paste the address back instead. That
 * way needs nothing set up at all, which is why it is what happens by default.
 */
export function callback(): { url: string; relayed: boolean } {
  const said = settings.google.callback.trim();
  // Set but switched off is worth telling somebody about, so it is not silently
  // the paste flow while the setting says otherwise.
  if (said) return { url: said, relayed: settings.cloud.remote.google };
  return { url: "", relayed: false };
}

function pending(): Pending | undefined {
  if (!existsSync(PENDING)) return undefined;
  try {
    return JSON.parse(readFileSync(PENDING, "utf8")) as Pending;
  } catch {
    return undefined;
  }
}

/**
 * Where the sign-in stands. Reads files and runs one command, and asks Google
 * nothing, so it is cheap enough for a job to check before it needs mail.
 */
export async function signInState(): Promise<SignInState> {
  const account = settings.google.account;
  const waiting = Boolean(pending());
  if (!account) {
    return { ready: false, account, missing: "google.account is not set, so there is no account to sign in", waiting };
  }
  let program: string;
  try {
    program = await ensureGog();
  } catch (error) {
    return { ready: false, account, missing: (error as Error).message, waiting };
  }
  const list = await run(program, ["auth", "list", "-p"], { timeoutMs: 30_000, env: where() });
  if (list.exitCode === 0 && list.stdout.includes(account)) {
    return { ready: true, account, missing: "", waiting: false };
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

/**
 * Start a sign-in: hand back a link for the person to open.
 *
 * Everything the second half needs is written down here, so the process can
 * restart, or a job can park for a day, between the two.
 */
export async function start({
  services = SERVICES,
  again = false,
}: { services?: string; again?: boolean } = {}): Promise<Started> {
  const account = settings.google.account;
  if (!account) {
    throw new Error("google.account is not set, so there is nobody to sign in. Put the address in settings.local.json.");
  }
  const program = await ensureGog();
  await client(program);

  const to = callback();
  const args = [
    "auth", "add", account, "--remote", "--step", "1", "--services", services, "-p",
    "--redirect-uri", to.url || PASTE_BACK,
  ];
  // Google only hands back a refresh token the first time it asks, so a
  // sign-in meant to replace one that stopped working has to ask again.
  if (again) args.push("--force-consent");

  const out = await run(program, args, { timeoutMs: 60_000, env: where() });
  if (out.exitCode !== 0) throw new Error(explain(out.stderr || out.stdout));

  const link = /(https:\/\/accounts\.google\.com\S+)/.exec(out.stdout)?.[1];
  if (!link) throw new Error(`gog did not hand back a link to open: ${out.stdout.trim().slice(0, 300)}`);
  const state = new URL(link).searchParams.get("state") ?? "";
  const redirect = new URL(link).searchParams.get("redirect_uri") ?? (to.url || PASTE_BACK);

  folder();
  writeFileSync(
    PENDING,
    JSON.stringify({ account, services, redirect, state, started: new Date().toISOString() } satisfies Pending, null, 2),
    { mode: 0o600 },
  );

  return {
    link,
    account,
    relayed: to.relayed,
    say: to.relayed
      ? `Open this link and approve it as ${account}. I will know when you are done, so there is nothing to send back.`
      : `Open this link and approve it as ${account}. The page it lands on will not load, which is expected: ` +
        `copy that page's whole address out of the address bar and send it back to me.`,
  };
}

/**
 * Finish a sign-in with whatever came back from the browser.
 *
 * Takes the whole address, or just the code out of it, because a person on a
 * phone sends one or the other and neither is wrong.
 */
export async function finish(answer: string): Promise<{ account: string; signedIn: true }> {
  const waiting = pending();
  if (!waiting) {
    throw new Error("No sign-in is waiting for a code. Start one first, then send what the browser came back with.");
  }
  const url = asLink(answer.trim(), waiting);
  const program = await ensureGog();

  const out = await run(
    program,
    ["auth", "add", waiting.account, "--remote", "--step", "2", "--auth-url", url, "--services", waiting.services, "-p"],
    { timeoutMs: 120_000, env: where() },
  );
  if (out.exitCode !== 0) throw new Error(explain(out.stderr || out.stdout));

  rmSync(PENDING, { force: true });
  await mustBe(waiting.account);
  return { account: waiting.account, signedIn: true };
}

/**
 * Check that whoever approved is the account that was asked for.
 *
 * A code can be handed in by anybody who has the link, and where a dashboard
 * catches the answer that is an address on the internet. Somebody who
 * approved with their own account instead would leave the agent reading their
 * mailbox and calling it the configured one, which is nobody's idea of what
 * happened. So the sign-in is thrown away when the profile it reaches is not
 * the address in settings, and a check that cannot run is a refusal too.
 */
async function mustBe(account: string): Promise<void> {
  const program = await ensureGog();
  const out = await run(program, ["people", "me", "--json"], { timeoutMs: 30_000, env: where() });
  const matches = out.exitCode === 0 && out.stdout.toLowerCase().includes(account.toLowerCase());
  if (matches) return;
  await run(program, ["auth", "remove", account, "-y"], { timeoutMs: 30_000, env: where() });
  throw new Error(
    out.exitCode === 0
      ? `That sign-in was approved by somebody other than ${account}, so it was thrown away. Sign in again with that account.`
      : `That sign-in could not be checked against ${account}, so it was thrown away: ${(out.stderr || out.stdout).trim().slice(0, 200)}`,
  );
}

/**
 * The address gog wants, from what a person sent.
 *
 * A code on its own is put back together with the address and the state that
 * were written down when the link was made, so the two halves still match and
 * gog's own check on the state still means something.
 */
export function asLink(answer: string, waiting: Pending): string {
  if (/^https?:\/\//i.test(answer)) return answer;
  const code = /(?:code=)?([\w./~-]+)/.exec(answer)?.[1];
  if (!code) throw new Error(`That does not look like a code or a web address: ${JSON.stringify(answer.slice(0, 80))}`);
  if (!waiting.redirect) {
    throw new Error("Send the whole address of the page the browser landed on, not just the code.");
  }
  const url = new URL(waiting.redirect);
  url.searchParams.set("code", code);
  if (waiting.state) url.searchParams.set("state", waiting.state);
  return url.toString();
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
    addresses: [PASTE_BACK, ...(to.url ? [to.url] : [])],
    steps: [
      "Go to console.cloud.google.com and make a project. The name does not matter.",
      "Open APIs and Services, then Library, and switch on the Gmail API. Switch on Calendar, Drive, Docs and Sheets too if the agents should reach those.",
      "Open the Google Auth Platform section. Fill in an app name and your own email as the contact, and choose External for who it is for.",
      "Add your own Google address as a test user. You are the only user this will ever have.",
      "Go to Credentials, create an OAuth client, and choose Web application as the type.",
      "Add the redirect addresses listed here, exactly as they are written, one per line in that form.",
      "Download the client file it gives you, and put either its path or the whole of its contents in settings.local.json as google.client.",
      "Tell me when that is done and I will send you the link to approve.",
    ],
  };
}

/**
 * Turn gog's own failures into something an agent can act on, rather than
 * letting "integrity check failed" reach a model that will retry it forever.
 *
 * Every one of these is fixed by one sign-in, and a sign-in is something the
 * agent can start itself, so none of them tells anybody to go to the box.
 */
export function explain(text: string): string {
  const sign = "Start a sign-in with google_sign_in, send the person the link, and do not retry this until they answer.";

  if (/integrity check failed|KeyUnwrap/i.test(text)) {
    return `Google cannot be reached: the saved sign-in will not open. ${sign}`;
  }
  if (/invalid_grant|token has been expired or revoked/i.test(text)) {
    return `Google cannot be reached: the saved sign-in has expired or was taken back. ${sign}`;
  }
  if (/no TTY|GOG_KEYRING_PASSWORD|no token|not found for account/i.test(text)) {
    return `Google cannot be reached: nobody has signed in on this copy. ${sign}`;
  }
  if (/missing --account|GOG_ACCOUNT/i.test(text)) {
    return (
      "Google cannot be reached: google.account is not set, so there is no account to read. " +
      "A person has to put the address in settings.local.json. Do not retry."
    );
  }
  if (/credentials|client/i.test(text) && /no|missing|not found/i.test(text)) {
    return (
      "Google cannot be reached: this copy has no client to sign in with. One person makes one once in Google's " +
      "console and puts it in settings.local.json as google.client. Do not retry."
    );
  }
  return `Google could not be reached: ${text.trim().slice(0, 300)}`;
}

/**
 * Every gog call goes through here, so none of them can miss the folder or the
 * passphrase, and none of them can forget the two guards.
 *
 * `reading` turns on gog's own two safety switches, and a call that only reads
 * should always pass it. `--readonly` makes gog refuse a request that would
 * change anything, at the moment it is made, so a bug or a borrowed turn
 * cannot delete mail even though the sign-in would allow it. `--wrap-untrusted`
 * marks the text that came back as somebody else's words, which matters when
 * the next thing to read it is a model.
 */
export async function gog(
  args: string[],
  { timeoutMs = 60_000, reading = false }: { timeoutMs?: number; reading?: boolean } = {},
): Promise<string> {
  const program = await ensureGog();
  const all = reading ? [...args, "--readonly", "--wrap-untrusted"] : args;
  const out = await run(program, all, { timeoutMs, env: where() });
  if (out.exitCode !== 0) throw new Error(explain(out.stderr || out.stdout));
  return out.stdout;
}
