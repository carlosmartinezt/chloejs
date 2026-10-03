// Reading one web page, as text.
//
// Only public addresses: this box serves its own sites and the runtime on
// loopback ports, and a page that redirects to one of them must not be read
// back to whoever asked. Every redirect is checked the same way as the first
// address.
//
// The tool a model reaches is model/tools/web.ts, which calls this.
import { lookup } from "node:dns";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** One fetched web page as plain text, in slices when it is longer than one. */
export interface Page {
  url: string;
  status: number;
  title?: string;
  /** The page as plain text, links written as `[text](url)`. */
  text: string;
  /** Where the next slice starts, when the page was longer than one. */
  next?: number;
}

/** Enough for a results table, short enough not to fill a turn. */
const SLICE = 20_000;
const HOPS = 5;
const LARGEST = 5_000_000;

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** An IPv6 address as its eight 16-bit groups, however it was written. */
function groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = text.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(fill).fill("0"), ...right].map((one) => parseInt(one, 16));
  return all.length === 8 && all.every((one) => one >= 0 && one <= 0xffff) ? all : null;
}

/**
 * Loopback, private ranges, link local, multicast, and the same in IPv6,
 * including an IPv4 address carried inside an IPv6 one in any spelling.
 */
export function isPrivate(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address.split(".").map(Number));
  const g = groups(address);
  if (!g) return true;
  const inner = [g[6] >> 8, g[6] & 0xff];
  // ::/96 and ::ffff:0:0/96 carry an IPv4 address, and 64:ff9b::/96 translates to one.
  if (g.slice(0, 5).every((one) => one === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return (g[5] === 0 && g[6] === 0) || privateV4(inner);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((one) => one === 0)) return privateV4(inner);
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 || g[0] === 0x2001 && g[1] === 0xdb8;
}

/**
 * The name is resolved once, here, and the socket connects to what was
 * checked, so a name cannot answer public for the check and private for the
 * connection.
 */
const publicOnly: LookupFunction = (host, options, done) => {
  lookup(host, { ...options, all: true }, (error, found) => {
    if (error) return done(error, "", 0);
    const bad = found.find((one) => isPrivate(one.address));
    if (bad) return done(new Error(`${host} is a private address, and those are not read.`), "", 0);
    if (options.all) return (done as any)(null, found);
    done(null, found[0].address, found[0].family);
  });
};

interface Reply {
  status: number;
  location?: string;
  retryAfter?: string;
  type: string;
  body: string;
}

function get(url: URL): Promise<Reply> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https pages, not ${url.protocol}`);
  // A literal address is connected to without a lookup, so it is checked here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivate(literal)) throw new Error(`${url.hostname} is a private address, and those are not read.`);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http)(
      url,
      {
        lookup: publicOnly,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; chloe)",
          Accept: "text/html,text/plain,application/json,*/*",
          "Accept-Encoding": "identity",
        },
        timeout: 30_000,
      },
      (response) => {
        const type = String(response.headers["content-type"] ?? "");
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > LARGEST) return request.destroy(new Error(`${url.href} is over ${LARGEST / 1_000_000} MB.`));
          chunks.push(chunk);
        });
        response.on("end", () => {
          const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
          let decoder: TextDecoder;
          try {
            decoder = new TextDecoder(charset);
          } catch {
            decoder = new TextDecoder();
          }
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            retryAfter: response.headers["retry-after"],
            type,
            body: decoder.decode(Buffer.concat(chunks)),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`${url.href} did not answer in 30 seconds.`)));
    request.on("error", reject);
    request.end();
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-" };

function decode(text: string): string {
  // Some sites write &nbsp with no semicolon, and browsers forgive it.
  return text.replace(/&nbsp(?!;)/gi, " ").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** HTML to readable text: blocks become lines, cells are split by " | ", links keep their address. */
export function htmlToText(html: string, base: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = html
    .replace(/\s+/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->|<![^>]*>/g, "")
    .replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_whole, _quote, href: string, inner: string) => {
      const words = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      let address = decode(href);
      try {
        address = new URL(address, base).href;
      } catch {}
      if (!words) return "";
      return /^(javascript|mailto):|^#/.test(href) ? words : `[${words}](${address.replace(/ /g, "%20")})`;
    })
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer)>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, " ");
  return {
    title: title ? decode(title).replace(/\s+/g, " ").trim() : undefined,
    text: decode(text)
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").replace(/(\s*\|\s*)+$/, "").trim())
      .filter(Boolean)
      .join("\n"),
  };
}

/** The inside of the first `<name>` element in `xml`, CDATA unwrapped and entities left alone. */
function element(xml: string, name: string): { inner: string; cdata: boolean } | undefined {
  const inner = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml)?.[1];
  if (inner === undefined) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return cdata ? { inner: cdata[1], cdata: true } : { inner, cdata: false };
}

/**
 * An Atom or RSS feed as text: each entry is its title as a link, who wrote it
 * and when, then its words. Raw, a feed's words are HTML escaped inside XML,
 * and a slice of it holds a few entries where this holds a page of them.
 */
export function feedToText(xml: string, base: string): { title?: string; text: string } {
  const words = (name: string, from: string) => {
    const found = element(from, name);
    if (!found) return "";
    return htmlToText(found.cdata ? found.inner : decode(found.inner), base).text;
  };
  const entries = xml.match(/<(entry|item)\b[\s\S]*?<\/\1>/gi) ?? [];
  const first = xml.search(/<(entry|item)\b/i);
  const head = first < 0 ? xml : xml.slice(0, first);
  const text = entries.map((entry) => {
    const title = words("title", entry).replace(/\s+/g, " ");
    // Atom's link is an empty element with an href, RSS's is the address as text.
    const link =
      /<link\b(?![^>]*\brel=["'](?!alternate))[^>]*\bhref=["']([^"']+)["']/i.exec(entry)?.[1] ?? element(entry, "link")?.inner.trim();
    const by = words("name", entry) || words("dc:creator", entry) || words("author", entry);
    const when = words("published", entry) || words("pubDate", entry) || words("updated", entry);
    const body = words("content", entry) || words("description", entry) || words("summary", entry);
    return [link ? `[${title}](${decode(link)})` : title, [by, when].filter(Boolean).join(", "), body].filter(Boolean).join("\n");
  });
  return { title: words("title", head) || undefined, text: text.join("\n\n") };
}

/** Fetches `address` and returns it as text, a slice at a time starting at `from`. */
export async function readPage(address: string, from = 0): Promise<Page> {
  let url = new URL(address);
  let waited = false;
  for (let hop = 0; ; hop++) {
    const reply = await get(url);
    if (reply.status >= 300 && reply.status < 400 && reply.location) {
      if (hop >= HOPS) throw new Error(`More than ${HOPS} redirects from ${address}.`);
      url = new URL(reply.location, url);
      continue;
    }
    // A model cannot wait, so a site that limits how often it is read (Reddit
    // allows about one read in 30 seconds from a server) is waited for here,
    // once, and the same address asked again.
    if (reply.status === 429 && !waited) {
      waited = true;
      hop--;
      const seconds = Math.min(Math.max(Number(reply.retryAfter) || 0, 30), 60);
      await new Promise((done) => setTimeout(done, seconds * 1000));
      continue;
    }
    // A refusal often has no body worth reading, and "not text" would hide why.
    if (reply.status === 429) throw new Error(`${url.href} answered 429 twice, too many requests. Read something else first.`);
    if (!/text|json|xml/.test(reply.type)) {
      throw new Error(reply.status >= 400 ? `${url.href} answered ${reply.status}.` : `${url.href} is ${reply.type || "not text"}, which this cannot read.`);
    }
    const { title, text } = /html/.test(reply.type)
      ? htmlToText(reply.body, url.href)
      : /xml/.test(reply.type) && /^\s*(<\?xml[^>]*>\s*)?<(feed|rss)\b/i.test(reply.body)
        ? feedToText(reply.body, url.href)
        : { title: undefined, text: reply.body };
    const end = from + SLICE;
    return { url: url.href, status: reply.status, title, text: text.slice(from, end), next: end < text.length ? end : undefined };
  }
}
