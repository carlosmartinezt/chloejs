// The email channel's way into a mailbox signed in to with an address and a
// password: an app password from Gmail, iCloud, Fastmail or any provider that
// lets a mail program in. It reads with IMAP, the protocol mail programs use to
// read a mailbox on a server, and sends with SMTP, the one they use to send.
// Both are written here on node's own TLS, so nothing is installed.
//
// Only the runtime's own code calls these, never a model. As on Gmail, the
// channel reads the recipients of what is new and fetches a message whole only
// when it is addressed to one of its own tagged addresses, and every fetch is a
// peek, so nothing in the mailbox is marked read, moved or deleted.
//
// Where the channel is up to is the mailbox's UIDVALIDITY and the next UID,
// "<validity>:<next>": a UID is the number the server gives each message in
// INBOX, in order, and a new UIDVALIDITY means the server numbered them all
// again, so the point is gone and the channel starts from now.
import { randomUUID } from "node:crypto";
import { isIP, connect as plain, type Socket } from "node:net";
import { connect as secure, type ConnectionOptions, type TLSSocket } from "node:tls";

import { addresses, headersOf, type Inbox, type Since } from "#chloe/core/mail";

/** What `passwordMailbox()` signs in with. The settings are `agents.<id>.email`. */
export interface PasswordMailboxOptions {
  /** The mailbox's address, which mail goes out from. */
  address: string;
  /** The password, usually an app password the provider made for this. */
  password: string;
  /** The reading server, "host:port". Default: the provider's own, for the providers in `SERVERS`. */
  imap?: string;
  /** The sending server, "host:port". Port 465 is TLS from the start, any other is upgraded with STARTTLS. */
  smtp?: string;
  /** How long one answer from a server may take, in milliseconds. Default: 60000. */
  wait?: number;
  /** Extra TLS options. Only the tests set it, to trust a stand-in server's certificate. */
  tls?: ConnectionOptions;
}

/**
 * The reading and sending servers of the providers that deliver mail sent to
 * `you+tag@` to `you@`, which every conversation's address needs. Yahoo does
 * not, so it is not here. Sending is on 587 with STARTTLS, because many hosts
 * block 465 going out.
 */
export const SERVERS: Record<string, { imap: string; smtp: string }> = {
  "gmail.com": { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:587" },
  "googlemail.com": { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:587" },
  "icloud.com": { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  "me.com": { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  "mac.com": { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  "fastmail.com": { imap: "imap.fastmail.com:993", smtp: "smtp.fastmail.com:587" },
  "fastmail.fm": { imap: "imap.fastmail.com:993", smtp: "smtp.fastmail.com:587" },
};

/** A host and port written "host:port". */
function hostPort(said: string, what: string): { host: string; port: number } {
  const at = said.lastIndexOf(":");
  const port = Number(said.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port <= 0) throw new Error(`The ${what} server "${said}" should be written host:port, like "imap.example.com:993".`);
  return { host: said.slice(0, at), port };
}

/** One server's lines and the bytes between them, read as latin1 so every byte is one character. */
class Wire {
  private buffer = "";
  private waiting?: () => void;
  private failed?: Error;
  private socket: Socket | TLSSocket;
  private wait: number;

  constructor(socket: Socket | TLSSocket, wait: number) {
    this.socket = socket;
    this.wait = wait;
    this.listen(socket);
  }

  private listen(socket: Socket | TLSSocket) {
    socket.setEncoding("latin1");
    socket.on("timeout", () => socket.destroy(new Error(`the server said nothing for ${this.wait / 1000} seconds`)));
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.waiting?.();
    });
    const end = (error?: Error) => {
      this.failed ??= error ?? new Error("the server closed the connection");
      this.waiting?.();
    };
    socket.on("error", end);
    socket.on("close", () => end());
  }

  /** Moves the conversation onto TLS, for STARTTLS. */
  async upgrade(options: ConnectionOptions): Promise<void> {
    const old = this.socket;
    old.removeAllListeners("data").removeAllListeners("error").removeAllListeners("close");
    const upgraded = secure({ ...options, socket: old });
    await new Promise<void>((done, fail) => upgraded.once("secureConnect", done).once("error", fail));
    this.socket = upgraded;
    this.listen(upgraded);
  }

  /** Waits until `found` finds what it wants in the buffer, and takes that much. */
  async take<T>(found: (buffer: string) => { value: T; used: number } | undefined): Promise<T> {
    // Only while waiting: a connection kept open between asks is quiet, and that is fine.
    this.socket.setTimeout(this.wait);
    try {
      for (;;) {
        const got = found(this.buffer);
        if (got) {
          this.buffer = this.buffer.slice(got.used);
          return got.value;
        }
        if (this.failed) throw this.failed;
        await new Promise<void>((done) => (this.waiting = done));
        this.waiting = undefined;
      }
    } finally {
      this.socket.setTimeout(0);
    }
  }

  /** Whether the connection has ended. */
  get closed(): boolean {
    return !!this.failed;
  }

  /** The next line, without its line ending. */
  line(): Promise<string> {
    return this.take((buffer) => {
      const at = buffer.indexOf("\r\n");
      return at < 0 ? undefined : { value: buffer.slice(0, at), used: at + 2 };
    });
  }

  write(text: string): void {
    this.socket.write(text, "latin1");
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Opens a connection, with TLS from the start or not. */
async function open(host: string, port: number, tls: boolean, options: PasswordMailboxOptions): Promise<Wire> {
  const wait = options.wait ?? 60_000;
  const socket = tls ? secure({ host, port, servername: isIP(host) ? undefined : host, ...options.tls }) : plain({ host, port });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => (socket.destroy(), fail(new Error(`could not reach ${host}:${port} in ${wait / 1000} seconds`))), wait);
    socket.once(tls ? "secureConnect" : "connect", () => (clearTimeout(timer), done()));
    socket.once("error", (error) => (clearTimeout(timer), fail(error)));
  });
  return new Wire(socket, wait);
}

/** A string as IMAP writes one in quotes. */
const quote = (text: string) => {
  if (/[\r\n\0]/.test(text)) throw new Error("a line break cannot go to a mail server");
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
};

/** One untagged answer from an IMAP server: its line, and the bytes of each `{n}` in it. */
interface Untagged {
  text: string;
  literals: string[];
}

/** One IMAP connection, signed in, INBOX selected. Commands go one at a time. */
class Imap {
  private count = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private wire: Wire;

  private constructor(wire: Wire) {
    this.wire = wire;
  }

  static async open(options: PasswordMailboxOptions, server: string): Promise<Imap> {
    const { host, port } = hostPort(server, "reading");
    const imap = new Imap(await open(host, port, true, options));
    const hello = await imap.wire.line();
    if (!/^\* (OK|PREAUTH)/i.test(hello)) throw new Error(`the reading server said: ${hello}`);
    try {
      await imap.run(`LOGIN ${quote(options.address)} ${quote(options.password)}`);
    } catch (error) {
      imap.close();
      throw new Error(`could not sign in to ${host} as ${options.address}: ${(error as Error).message}`);
    }
    return imap;
  }

  /** Runs one command and returns what the server said before its OK. Throws on NO or BAD. */
  run(command: string): Promise<Untagged[]> {
    const next = this.queue.then(() => this.one(command));
    this.queue = next.catch(() => {});
    return next;
  }

  private async one(command: string): Promise<Untagged[]> {
    const tag = `c${++this.count}`;
    this.wire.write(`${tag} ${command}\r\n`);
    const said: Untagged[] = [];
    for (;;) {
      const answer = await this.answer();
      if (answer.text.startsWith(`${tag} `)) {
        const rest = answer.text.slice(tag.length + 1);
        if (/^OK/i.test(rest)) return said;
        throw new Error(rest.replace(/^(NO|BAD)\s*/i, "") || rest);
      }
      if (answer.text.startsWith("* ")) said.push(answer);
    }
  }

  /** One whole answer: a line, and when it ends in `{n}`, the n bytes after it and the line that carries on. */
  private async answer(): Promise<Untagged> {
    let text = "";
    const literals: string[] = [];
    for (;;) {
      const line = await this.wire.line();
      text += line;
      const size = line.match(/\{(\d+)\}$/);
      if (!size) return { text, literals };
      const length = Number(size[1]);
      literals.push(await this.wire.take((buffer) => (buffer.length >= length ? { value: buffer.slice(0, length), used: length } : undefined)));
    }
  }

  /** Selects INBOX, and returns its UIDVALIDITY and the UID the next message will get. */
  async inbox(): Promise<{ validity: string; next: number }> {
    const said = await this.run("SELECT INBOX");
    const code = (name: string) => said.map((one) => one.text.match(new RegExp(`\\[${name} (\\d+)\\]`, "i"))?.[1]).find(Boolean);
    const validity = code("UIDVALIDITY");
    let next = code("UIDNEXT");
    if (!next) {
      const status = await this.run("STATUS INBOX (UIDNEXT)");
      next = status.map((one) => one.text.match(/UIDNEXT (\d+)/i)?.[1]).find(Boolean);
    }
    if (!validity || !next) throw new Error("the reading server did not say where INBOX is up to");
    return { validity, next: Number(next) };
  }

  /** The UIDs from `from` on. */
  async uidsFrom(from: number): Promise<number[]> {
    const said = await this.run(`UID SEARCH UID ${from}:*`);
    const uids = said.flatMap((one) => (/^\* SEARCH/i.test(one.text) ? one.text.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : []));
    // "n:*" always holds the last message, even one before n.
    return uids.filter((uid) => uid >= from).sort((a, b) => a - b);
  }

  /** One part of one message, without marking it read. */
  async fetch(uid: string, part: string): Promise<string> {
    if (!/^\d+$/.test(uid)) throw new Error(`"${uid}" is not a message number`);
    const said = await this.run(`UID FETCH ${uid} (BODY.PEEK[${part}])`);
    const fetched = said.find((one) => /^\* \d+ FETCH/i.test(one.text));
    if (!fetched) throw new Error(`there is no message ${uid} in INBOX`);
    if (fetched.literals.length) return fetched.literals[0];
    return fetched.text.match(/BODY\[[^\]]*\] "((?:[^"\\]|\\.)*)"/i)?.[1].replace(/\\(.)/g, "$1") ?? "";
  }

  get closed(): boolean {
    return this.wire.closed;
  }

  close(): void {
    if (!this.wire.closed) this.wire.write("z LOGOUT\r\n");
    this.wire.close();
  }
}

/** Reads SMTP's answer, the lines of one reply, and throws unless its code is one of `want`. */
async function reply(wire: Wire, ...want: number[]): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await wire.line();
    lines.push(line);
    if (!/^\d{3}-/.test(line)) break;
  }
  const code = Number(lines[lines.length - 1].slice(0, 3));
  if (!want.includes(code)) throw new Error(`the sending server said: ${lines.join(" ")}`);
  return lines.join("\n");
}

/**
 * Sends one message by SMTP, signed in with the address and password. Port 465
 * is TLS from the first byte; any other port starts plain and must offer
 * STARTTLS, or nothing is sent, so the password never crosses in the clear.
 */
async function sendBySmtp(options: PasswordMailboxOptions, server: string, to: string[], message: string): Promise<void> {
  const { host, port } = hostPort(server, "sending");
  const wire = await open(host, port, port === 465, options);
  try {
    await reply(wire, 220);
    wire.write("EHLO chloe\r\n");
    let offered = await reply(wire, 250);
    if (port !== 465) {
      if (!/STARTTLS/i.test(offered)) throw new Error(`${host}:${port} does not offer STARTTLS, so the password is not sent to it`);
      wire.write("STARTTLS\r\n");
      await reply(wire, 220);
      await wire.upgrade({ host, servername: isIP(host) ? undefined : host, ...options.tls });
      wire.write("EHLO chloe\r\n");
      offered = await reply(wire, 250);
    }
    const plainAuth = Buffer.from(`\0${options.address}\0${options.password}`, "utf8").toString("base64");
    wire.write(`AUTH PLAIN ${plainAuth}\r\n`);
    await reply(wire, 235);
    wire.write(`MAIL FROM:<${options.address}>\r\n`);
    await reply(wire, 250);
    for (const one of to) {
      wire.write(`RCPT TO:<${one}>\r\n`);
      await reply(wire, 250, 251);
    }
    wire.write("DATA\r\n");
    await reply(wire, 354);
    // A line that starts with a full stop gets a second one, so it is not read as the end.
    wire.write(`${message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.\r\n`);
    await reply(wire, 250);
    wire.write("QUIT\r\n");
  } finally {
    wire.close();
  }
}

/**
 * A mailbox signed in to with an address and a password, for the email
 * channel. It keeps one connection to the reading server open between asks,
 * and opens a new one after any failure.
 */
export function passwordMailbox(options: PasswordMailboxOptions): Inbox {
  const address = options.address.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const known = SERVERS[domain];
  const imapServer = options.imap || known?.imap;
  const smtpServer = options.smtp || known?.smtp;
  let connection: Promise<Imap> | undefined;

  /** Runs `work` on the open connection, and drops the connection when it fails. */
  async function onImap<T>(work: (imap: Imap) => Promise<T>): Promise<T> {
    if (!imapServer) throw new Error(`no reading server is known for ${domain}: set imap, like "imap.${domain}:993"`);
    // A server may close a connection that sat quiet, and that is no failure: open another.
    if (connection && (await connection.then((imap) => imap.closed, () => true))) connection = undefined;
    connection ??= Imap.open({ ...options, address }, imapServer);
    const held = connection;
    try {
      return await work(await held);
    } catch (error) {
      if (connection === held) connection = undefined;
      held.then((imap) => imap.close(), () => {});
      throw error;
    }
  }

  return {
    account() {
      if (!address.includes("@")) throw new Error("the mailbox has no address");
      return address;
    },

    async now() {
      return onImap(async (imap) => {
        const { validity, next } = await imap.inbox();
        return `${validity}:${next}`;
      });
    },

    async since(history): Promise<Since | "gone"> {
      const [validity, from] = history.split(":");
      return onImap(async (imap) => {
        const now = await imap.inbox();
        if (now.validity !== validity || !Number(from)) return "gone";
        const uids = await imap.uidsFrom(Number(from));
        const next = Math.max(now.next, Number(from), ...uids.map((uid) => uid + 1));
        return { added: uids.map((uid) => ({ id: String(uid) })), history: `${validity}:${next}` };
      });
    },

    async recipients(id) {
      const head = await onImap((imap) => imap.fetch(id, "HEADER.FIELDS (TO CC)"));
      return headersOf(head.replace(/\r?\n/g, "\r\n")).map((one) => one.value).join(", ");
    },

    raw(id) {
      return onImap((imap) => imap.fetch(id, ""));
    },

    async send(raw) {
      if (!smtpServer) throw new Error(`no sending server is known for ${domain}: set smtp, like "smtp.${domain}:587"`);
      const message = Buffer.from(raw, "base64url").toString("latin1");
      const head = message.slice(0, message.search(/\r?\n\r?\n/) + 1);
      const to = headersOf(head.replace(/\r?\n/g, "\r\n"))
        .filter((one) => /^(to|cc)$/i.test(one.name))
        .flatMap((one) => addresses(one.value).list);
      if (!to.length) throw new Error("the message has nobody to go to");
      // Gmail's own API adds these. A mail server need not, and a reply is threaded on Message-ID.
      const stamped = `Date: ${new Date().toUTCString().replace("GMT", "+0000")}\r\nMessage-ID: <${randomUUID()}@${domain}>\r\n${message}`;
      await sendBySmtp({ ...options, address }, smtpServer, to, stamped);
    },
  };
}
