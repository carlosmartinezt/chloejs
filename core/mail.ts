// Reading one email as it arrived, and checking who really sent it.
//
// `raw` is the message byte for byte, held as a latin1 string so every byte is
// one character and nothing is lost before the DKIM check. Text is decoded to
// what a person reads only when it is taken out (`readEmail`).
//
// The From line of an email can be written by anyone. What cannot be faked is a
// DKIM signature: the sending domain signs the From line and the body with a key
// whose public half is in its DNS, at `<selector>._domainkey.<domain>`.
// `signedBy` checks that, with node's own crypto and DNS and nothing installed.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { Resolver } from "node:dns/promises";

/** One header as it was written: its name, and its value with any folding kept. */
export interface Header {
  name: string;
  value: string;
}

/** What a person reads from an email. */
export interface Email {
  headers: Header[];
  /** Every From address, lower case. One is normal; more than one is refused by whoever reads this. */
  from: string[];
  /** The name in the From line, or "". */
  fromName: string;
  /** Every address in To and Cc, lower case. */
  to: string[];
  subject: string;
  messageId: string;
  references: string;
  /** All of the text, as the person's mail program wrote it. */
  text: string;
  /** What they wrote this time: the text with the quoted history and their client's reply header cut off. */
  reply: string;
  /** The names of any files on it. */
  files: string[];
}

/** The message with every line ending as CRLF, which is what a signature was made over. */
export function crlf(raw: string): string {
  return raw.replace(/\r?\n/g, "\r\n");
}

/** The headers and the body, split at the first empty line. */
function split(raw: string): { head: string; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  if (at < 0) return { head: raw, body: "" };
  return { head: raw.slice(0, at + 2), body: raw.slice(at + 4) };
}

/** Each header, in order, with its folded lines kept as they were. */
export function headersOf(head: string): Header[] {
  const out: Header[] = [];
  for (const line of head.split("\r\n")) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].value += `\r\n${line}`;
    else {
      const colon = line.indexOf(":");
      if (colon > 0) out.push({ name: line.slice(0, colon), value: line.slice(colon + 1) });
    }
  }
  return out;
}

function unfold(value: string): string {
  return value.replace(/\r\n(?=[ \t])/g, "").trim();
}

function all(headers: Header[], name: string): string[] {
  return headers.filter((one) => one.name.toLowerCase() === name).map((one) => unfold(one.value));
}

/** Bytes held as latin1, read as text in a charset, UTF-8 when the charset is unknown. */
function decode(bytes: Buffer, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^us-ascii$/, "utf-8")).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** A header's words, with any `=?utf-8?B?...?=` parts decoded and raw UTF-8 read as UTF-8. */
export function words(value: string): string {
  const plain = decode(Buffer.from(value, "latin1"));
  return plain
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, how: string, text: string) => {
      const bytes =
        how.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return decode(bytes, charset.split("*")[0]);
    });
}

/**
 * The addresses in an address header, lower case, and the first one's name.
 * Commas inside quotes and angle brackets do not split it.
 */
export function addresses(value: string): { list: string[]; name: string } {
  const parts: string[] = [];
  let quoted = false;
  let angled = false;
  let part = "";
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angled = true;
    if (!quoted && char === ">") angled = false;
    if (char === "," && !quoted && !angled) {
      parts.push(part);
      part = "";
    } else part += char;
  }
  parts.push(part);
  const list: string[] = [];
  let name = "";
  for (const one of parts) {
    const angle = /<([^>]*)>/.exec(one);
    const address = (angle ? angle[1] : one.replace(/\(.*?\)/g, "")).trim().toLowerCase();
    if (!address.includes("@")) continue;
    if (!list.length) name = words(angle ? one.slice(0, angle.index) : "").trim().replace(/^"|"$/g, "").trim();
    list.push(address);
  }
  return { list, name };
}

/** A header's parameters, like the boundary and charset on a Content-Type. */
function parameters(value: string): { main: string; params: Record<string, string> } {
  const [main, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const one of rest) {
    const eq = one.indexOf("=");
    if (eq < 0) continue;
    params[one.slice(0, eq).trim().toLowerCase()] = one.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { main: main.trim().toLowerCase(), params };
}

/** A part's body as bytes, undoing its transfer encoding. */
function undo(body: string, encoding: string): Buffer {
  const how = encoding.trim().toLowerCase();
  if (how === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (how === "quoted-printable") {
    return Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
  }
  return Buffer.from(body, "latin1");
}

/** The text parts and file names in a message, walking into every multipart. */
function parts(head: Header[], body: string, found: { plain?: string; html?: string; files: string[] }, depth = 0): void {
  const type = parameters(all(head, "content-type")[0] ?? "text/plain");
  const disposition = parameters(all(head, "content-disposition")[0] ?? "");
  if (type.main.startsWith("multipart/") && type.params.boundary && depth < 10) {
    const fence = `--${type.params.boundary}`;
    const pieces = body.split(fence).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith("--")) break;
      const inner = split(piece.replace(/^\r\n/, ""));
      parts(headersOf(inner.head), inner.body.replace(/\r\n$/, ""), found, depth + 1);
    }
    return;
  }
  const fileName = disposition.params.filename ?? type.params.name;
  if (disposition.main === "attachment" || (fileName && !type.main.startsWith("text/"))) {
    found.files.push(words(fileName ?? "a file"));
    return;
  }
  const text = decode(undo(body, all(head, "content-transfer-encoding")[0] ?? ""), type.params.charset);
  if (type.main === "text/plain" && found.plain === undefined) found.plain = text;
  else if (type.main === "text/html" && found.html === undefined) found.html = text;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…", ndash: "–", mdash: "-", euro: "€", copy: "©",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»",
};

/** Accented letters by name, the way Outlook writes Spanish and French: `&eacute;`, `&Ntilde;`, `&uuml;`. */
function accented(name: string): string | undefined {
  const marks: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", cedil: "\u0327" };
  const found = /^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil)$/.exec(name);
  return found ? `${found[1]}${marks[found[2]]}`.normalize("NFC") : undefined;
}

/** HTML as the text a person would read, with the quoted history cut off first. */
export function htmlText(html: string): string {
  const cut = html.search(/<div[^>]+id="?(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)|<div[^>]+class="?gmail_quote|<blockquote/i);
  return (cut >= 0 ? html.slice(0, cut) : html)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
      name[0] === "#" ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? accented(name) ?? whole),
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What somebody wrote this time: the text above their mail program's reply
 * header ("On ... wrote:", Outlook's "From: ... Sent: ..." block, a line of
 * underscores, "Original Message"), with any trailing "> " lines dropped.
 */
export function replyOnly(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    const soon = lines.slice(i + 1, i + 5).map((one) => one.trim());
    if (
      /^On .+wrote:$/.test(line) ||
      (/^On /.test(line) && /wrote:$/.test(next)) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^_{10,}$/.test(line) ||
      (/^From: /.test(line) && soon.some((one) => /^(Sent|Date): /.test(one)))
    ) {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (kept[kept.length - 1].trim() === "" || kept[kept.length - 1].startsWith(">"))) kept.pop();
  return kept.join("\n").trim();
}

/** One email read for a person: who it is from and to, the subject, and the words. */
export function readEmail(raw: string): Email {
  const { head, body } = split(crlf(raw));
  const headers = headersOf(head);
  const found: { plain?: string; html?: string; files: string[] } = { files: [] };
  parts(headers, body, found);
  const html = found.html !== undefined ? htmlText(found.html) : undefined;
  const text = (found.plain ?? html ?? "").replace(/\r\n/g, "\n").trim();
  // Outlook's plain part keeps the history below a header block, and its HTML
  // marks the same place more reliably, so the HTML wins when there is one.
  const reply = html !== undefined ? replyOnly(html) : replyOnly(text);
  const from = all(headers, "from").map((one) => addresses(one));
  return {
    headers,
    from: from.flatMap((one) => one.list),
    fromName: from[0]?.name ?? "",
    to: [...all(headers, "to"), ...all(headers, "cc")].flatMap((one) => addresses(one).list),
    subject: words(all(headers, "subject")[0] ?? ""),
    messageId: all(headers, "message-id")[0] ?? "",
    references: all(headers, "references")[0] ?? "",
    text,
    reply,
    files: found.files,
  };
}

// DKIM, as RFC 6376 says it.

/** A signature's tags, `a=rsa-sha256; d=example.com; ...`, with folding taken out. */
function tags(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const one of unfold(value).split(";")) {
    const eq = one.indexOf("=");
    if (eq < 0) continue;
    out[one.slice(0, eq).trim()] = one.slice(eq + 1).replace(/\s+/g, "");
  }
  return out;
}

function relaxedHeader(header: Header): string {
  return `${header.name.trim().toLowerCase()}:${unfold(header.value).replace(/[ \t]+/g, " ").trim()}`;
}

function simpleHeader(header: Header): string {
  return `${header.name}:${header.value}`;
}

/** The body as it was signed, in the canonical form the signature names. */
export function canonicalBody(body: string, how: string): string {
  if (how === "relaxed") {
    const lines = body.split("\r\n").map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length ? `${lines.join("\r\n")}\r\n` : "";
  }
  const trimmed = body.replace(/(\r\n)*$/, "");
  return `${trimmed}\r\n`;
}

/** What a DNS TXT lookup gives back: each record as its pieces. */
export type LookUp = (name: string) => Promise<string[][]>;

const resolver = new Resolver({ timeout: 5000, tries: 2 });
const lookUp: LookUp = (name) => resolver.resolveTxt(name);

/** The public key a domain publishes for a selector, or why there is none. */
async function keyFor(domain: string, selector: string, algorithm: string, look: LookUp): Promise<KeyObject | string> {
  let records: string[][];
  try {
    records = await look(`${selector}._domainkey.${domain}`);
  } catch (error) {
    return `no key at ${selector}._domainkey.${domain} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
  const record = records.map((one) => one.join("")).find((one) => /(^|;)\s*p=/.test(one));
  if (!record) return `no key at ${selector}._domainkey.${domain}`;
  const found = tags(record);
  if (!found.p) return "the key was taken back";
  const der = Buffer.from(found.p, "base64");
  try {
    if (algorithm === "ed25519-sha256") {
      return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), der]), format: "der", type: "spki" });
    }
    try {
      return createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      return createPublicKey({ key: der, format: "der", type: "pkcs1" });
    }
  } catch {
    return "the key in DNS could not be read";
  }
}

/** One signature on a message and whether it held. */
export interface Signature {
  domain: string;
  pass: boolean;
  why: string;
}

/** Every DKIM signature on a message, each checked against the key its domain publishes. */
export async function signatures(raw: string, look: LookUp = lookUp): Promise<Signature[]> {
  const { head, body } = split(crlf(raw));
  const headers = headersOf(head);
  const out: Signature[] = [];
  for (const signature of headers.filter((one) => one.name.toLowerCase() === "dkim-signature")) {
    const t = tags(signature.value);
    const domain = (t.d ?? "").toLowerCase();
    const no = (why: string) => out.push({ domain, pass: false, why });
    if (!domain || !t.s || !t.b || !t.bh || !t.h) {
      no("a tag is missing");
      continue;
    }
    if (t.a !== "rsa-sha256" && t.a !== "ed25519-sha256") {
      no(`${t.a} is not taken`);
      continue;
    }
    if (t.l !== undefined) {
      no("it signs only part of the body (l=)");
      continue;
    }
    if (t.x && Number(t.x) * 1000 < Date.now()) {
      no("it has expired");
      continue;
    }
    const signed = t.h.split(":").map((one) => one.trim().toLowerCase());
    if (!signed.includes("from")) {
      no("it does not cover the From line");
      continue;
    }
    const [headerHow, bodyHow = "simple"] = (t.c ?? "simple/simple").toLowerCase().split("/");
    const bodyHash = createHash("sha256").update(canonicalBody(body, bodyHow), "latin1").digest("base64");
    if (bodyHash !== t.bh) {
      no("the body was changed after it was signed");
      continue;
    }
    // Each name in h= takes the last instance not already taken, bottom up.
    const left = [...headers];
    const lines: string[] = [];
    const canon = headerHow === "relaxed" ? relaxedHeader : simpleHeader;
    for (const name of signed) {
      let at = -1;
      for (let i = left.length - 1; i >= 0; i--) {
        if (left[i] !== signature && left[i].name.toLowerCase() === name) {
          at = i;
          break;
        }
      }
      if (at < 0) continue;
      lines.push(`${canon(left[at])}\r\n`);
      left.splice(at, 1);
    }
    const emptied = { name: signature.name, value: signature.value.replace(/((?:^|;)\s*b\s*=)[^;]*/, "$1") };
    const data = Buffer.from(lines.join("") + canon(emptied), "latin1");
    const key = await keyFor(domain, t.s, t.a, look);
    if (typeof key === "string") {
      no(key);
      continue;
    }
    const sig = Buffer.from(t.b, "base64");
    let pass = false;
    try {
      pass =
        t.a === "ed25519-sha256"
          ? verify(null, createHash("sha256").update(data).digest(), key, sig)
          : verify("sha256", data, key, sig);
    } catch {
      pass = false;
    }
    out.push({ domain, pass, why: pass ? "it checks out" : "the signature does not match" });
  }
  return out;
}

/**
 * Whether a message carries a DKIM signature that checks out and was made by
 * this domain or one it sits under ("mail.example.com" is covered by
 * "example.com"). With `why`, the reason it was not, for the log.
 */
export async function signedBy(raw: string, domain: string, look: LookUp = lookUp): Promise<{ ok: boolean; why: string }> {
  const wanted = domain.toLowerCase();
  const all = await signatures(raw, look);
  if (!all.length) return { ok: false, why: "it carries no DKIM signature" };
  const ours = all.filter((one) => one.domain.includes(".") && (wanted === one.domain || wanted.endsWith(`.${one.domain}`)));
  if (ours.some((one) => one.pass)) return { ok: true, why: "it checks out" };
  if (!ours.length) return { ok: false, why: `nothing on it is signed by ${wanted} (signed by ${all.map((one) => one.domain).join(", ")})` };
  return { ok: false, why: ours.map((one) => one.why).join("; ") };
}
