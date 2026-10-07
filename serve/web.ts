// What answers a chat box on a web page: the pass a visitor carries, who they
// are, what they may spend, and the handlers of the web routes http.ts lists.
// The channel itself, and what it takes, is channels/web.ts.
//
// A pass is given only to the site's own server, holding a token made for
// that one agent, which says who the visitor is. It is signed here with a key
// of its own, `web-pass.key` in the state folder, so checking one needs no
// lookup. Deleting that file and restarting ends every pass there is.
//
// A turn answers as a stream of events, one HTTP response that sends lines as
// they happen (Server-Sent Events):
//
//   event: working   {}
//   event: text      {"delta": "It shipped "}        words as they are written
//   event: said      {"text": "Let me look."}        words on the way, on a route that does not stream them
//   event: step      {"tool": "getOrders", "text": "Looking up the order"}
//   event: done      {"runId": "...", "text": "It shipped this morning."}
//   event: error     {"message": "..."}
//
// Any `text` before a `step` was written on the way, before a tool call, and
// not the answer. `done` carries the answer whole, so a page can ignore the
// pieces and lose nothing but the wait.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

import { z } from "zod";

import { db } from "#chloe/core/db";
import { STATE } from "#chloe/core/paths";
import type { Agent } from "#chloe/load/load";
import { forget } from "#chloe/model/memory";
import { receive } from "#chloe/channels/shared";
import { visitorThread, webOf, type Web } from "#chloe/channels/web";
import { BadRequest, NotFound, Refused } from "./errors.ts";
import { Picture, type At } from "./http.ts";
import { addressOf, from } from "./login.ts";
import { checkToken } from "./tokens.ts";

/** How long a pass is good for, in seconds. */
const LASTS = 60 * 60;

/** The longest message a visitor may send, in characters. */
const LONGEST = 4000;

/** The most pictures in one message, on a channel that takes them. */
const PICTURES = 2;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The header a page sends its pass in. */
export const PASS_HEADER = "x-chloe-pass";

/** What a pass says. Short keys, because it travels on every request. */
interface Pass {
  /** The agent. */
  a: string;
  /** The site, as the browser names it in Origin. */
  o: string;
  /** The visitor, as the site names them. */
  v: string;
  /** Until when, in seconds since the epoch. */
  u: number;
}

let key: Buffer | undefined;

/** The key passes are signed with, made the first time one is needed. */
function passKey(): Buffer {
  if (key) return key;
  const file = `${STATE}/web-pass.key`;
  try {
    key = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32);
    mkdirSync(STATE, { recursive: true });
    writeFileSync(file, key.toString("base64url"), { mode: 0o600 });
  }
  return key;
}

function sign(pass: Pass): string {
  const body = Buffer.from(JSON.stringify(pass)).toString("base64url");
  return `${body}.${createHmac("sha256", passKey()).update(`web-pass:${body}`).digest("base64url")}`;
}

/** What a pass says, when this runtime signed it, whether or not it has run out. */
function unsign(value: string): Pass | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const want = createHmac("sha256", passKey()).update(`web-pass:${body}`).digest();
  const got = Buffer.from(value.slice(dot + 1), "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const pass = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Pass;
    return typeof pass.a === "string" && typeof pass.o === "string" && typeof pass.v === "string" && typeof pass.u === "number" ? pass : null;
  } catch {
    return null;
  }
}

const now = (): number => Math.floor(Date.now() / 1000);

// In this process, so a restart clears it.
const seen = new Map<string, number[]>();

/**
 * Whether `what` has happened `most` times in the last `within` milliseconds.
 * When it has not, this time is counted.
 */
function tooMany(what: string, most: number, within: number): boolean {
  const since = Date.now() - within;
  const times = (seen.get(what) ?? []).filter((at) => at > since);
  if (seen.size > 10_000) for (const [one, at] of seen) if (!at.some((t) => t > since)) seen.delete(one);
  const over = times.length >= most;
  if (!over) times.push(Date.now());
  seen.set(what, times);
  return over;
}

/** What web turns of one agent have come to over the last 24 hours, for one visitor or for everybody. */
export function spent(agent: string, visitor?: string): { visitors: number; messages: number; dollars: number } {
  const since = new Date(Date.now() - DAY).toISOString();
  const row = db
    .prepare(
      `select count(distinct owner) as visitors, count(*) as messages, coalesce(sum(cost), 0) as dollars
       from runs where agent = ? and source = 'web' and started >= ?${visitor ? " and owner = ?" : ""}`,
    )
    .get(agent, since, ...(visitor ? [`web:${visitor}`] : [])) as { visitors: number; messages: number; dollars: number };
  return row;
}

/** The agent a web route names, and its web channel, or a 404 when it has none. */
function channelOf(at: At): { agent: Agent; web: Web } {
  const agent = at.context.agent(at.params.id);
  const web = webOf(agent);
  if (!web) throw new NotFound(`${agent.id} has no web channel.`);
  return { agent, web };
}

/** The sites an agent's web channel answers, for http.ts to answer a browser on another site. */
export function webOrigins(at: Pick<At, "params" | "context">): string[] {
  return webOf(at.context.agent(at.params.id))?.origins ?? [];
}

/** The page's own address, when a browser sent one. */
function originOf(request: IncomingMessage): string {
  const said = request.headers.origin;
  return (Array.isArray(said) ? said[0] : said) ?? "";
}

/** One plain line of at most `most` characters, for anything a site or a browser sends that a model is shown. */
function plain(text: string, most = 200): string {
  return text.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, most);
}

/**
 * A pass, for the site's own server, which sends a token made for this agent
 * and no other, `visitor` (its own id for the person, kept in a cookie only it
 * can read) and any `facts` it wants the agent told about them. A site that
 * signs people in sends who they are here.
 */
export async function webPass(at: At): Promise<void> {
  const { request, response, context } = at;
  const { agent, web } = channelOf(at);
  const header = request.headers.authorization ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? checkToken(header.slice(7).trim()) : null;
  if (token?.agent !== agent.id) throw new Refused(`A pass is given to a token made for ${agent.id}, and to nothing else.`, 401);
  const sent = await context.body(
    request,
    z.object({
      visitor: z.string().regex(/^[\w.@+-]{1,100}$/, "is letters, digits and . _ @ + -, at most 100").refine((one) => !/^\.+$/.test(one), "is not only dots"),
      facts: z.record(z.string().max(60), z.string().max(500)).optional(),
      origin: z.string().optional(),
    }),
  );
  const origin = sent.origin ?? web.origins[0];
  if (!web.origins.includes(origin)) throw new BadRequest(`${origin} is not one of ${agent.id}'s web channel's origins.`);
  const now_ = new Date().toISOString();
  const facts = sent.facts && JSON.stringify(Object.fromEntries(Object.entries(sent.facts).slice(0, 20).map(([k, v]) => [plain(k, 60), plain(v)])));
  db.prepare(
    `insert into visitors (agent, id, first, last, facts) values (?, ?, ?, ?, ?)
     on conflict (agent, id) do update set last = excluded.last, facts = coalesce(excluded.facts, visitors.facts)`,
  ).run(agent.id, sent.visitor, now_, now_, facts ?? null);
  const pass: Pass = { a: agent.id, o: origin, v: sent.visitor, u: now() + LASTS };
  context.json(response, {
    pass: sign(pass),
    visitor: pass.v,
    expires: new Date(pass.u * 1000).toISOString(),
    greeting: web.greeting,
    pictures: web.pictures,
  });
}

/** The visitor a request's pass is for, checked against the agent in its path and the page it came from. */
function visitorOf(at: At): { agent: Agent; web: Web; pass: Pass } {
  const { agent, web } = channelOf(at);
  const carried = at.request.headers[PASS_HEADER];
  const pass = typeof carried === "string" ? unsign(carried) : null;
  if (!pass || pass.u <= now()) throw new Refused("This chat's pass has run out. Ask for a new one.", 401);
  const origin = originOf(at.request);
  if (pass.a !== agent.id || (origin && origin !== pass.o) || !web.origins.includes(pass.o)) throw new Refused("This pass is not for this chat.");
  return { agent, web, pass };
}

/** A visitor as the runtime keeps them. */
interface Visitor {
  id: string;
  first: string;
  last: string;
  ip: string | null;
  country: string | null;
  browser: string | null;
  facts: string | null;
}

/** "Firefox on macOS" out of a browser's own description of itself, or what it said when it is not one of those. */
export function browserOf(said: string): string {
  if (!said) return "";
  const name =
    /Edg\//.test(said) ? "Edge" : /OPR\//.test(said) ? "Opera" : /Firefox\//.test(said) ? "Firefox" : /Chrome\//.test(said) ? "Chrome" : /Safari\//.test(said) ? "Safari" : "";
  const system =
    /iPhone|iPad/.test(said) ? "iOS" : /Android/.test(said) ? "Android" : /Mac OS X/.test(said) ? "macOS" : /Windows/.test(said) ? "Windows" : /Linux/.test(said) ? "Linux" : "";
  return name && system ? `${name} on ${system}` : plain(said, 120);
}

/**
 * Notes where a visitor's turn came from, and says who they are as the model
 * is shown it: when they first came, how many messages before this one, their
 * country and browser, and the site's facts. Never their address.
 */
function noted(agent: string, pass: Pass, request: IncomingMessage): Record<string, string> {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value) ?? "";
  };
  const country = /^[A-Z]{2}$/.test(header("cf-ipcountry")) ? header("cf-ipcountry") : null;
  const now_ = new Date().toISOString();
  db.prepare(
    `insert into visitors (agent, id, first, last, ip, country, browser) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (agent, id) do update set last = excluded.last, ip = excluded.ip,
       country = coalesce(excluded.country, visitors.country), browser = excluded.browser`,
  ).run(agent, pass.v, now_, now_, addressOf(request), country, browserOf(header("user-agent")) || null);
  const row = db.prepare("select * from visitors where agent = ? and id = ?").get(agent, pass.v) as unknown as Visitor;
  const before = (db.prepare("select count(*) as n from runs where agent = ? and source = 'web' and owner = ?").get(agent, `web:${pass.v}`) as { n: number }).n;
  const facts = row.facts ? (JSON.parse(row.facts) as Record<string, string>) : {};
  return {
    visitor: pass.v,
    site: pass.o,
    "first seen": row.first.slice(0, 10),
    "messages before this one": String(before),
    ...(row.country && { country: row.country }),
    ...(row.browser && { browser: row.browser }),
    ...facts,
  };
}

/** Every visitor an agent's web channel has had, newest first, for its owner. */
export function webVisitors(at: At): void {
  const { agent } = channelOf(at);
  const rows = db.prepare("select * from visitors where agent = ? order by last desc limit 200").all(agent.id) as unknown as Visitor[];
  at.context.json(at.response, rows.map(({ facts, ...rest }) => ({ ...rest, facts: facts ? JSON.parse(facts) : {}, thread: visitorThread(agent.id, rest.id) })));
}

/** One turn, answered as a stream of events. See the top of this file. */
export async function webTurn(at: At): Promise<void> {
  const { request, response, context } = at;
  const { agent, web, pass } = visitorOf(at);
  const { text, images } = await context.body(
    request,
    z.object({
      text: z.string().trim().max(LONGEST, `is longer than ${LONGEST} characters`),
      images: z.array(Picture).max(PICTURES).default([]),
    }),
    6 << 20,
  );
  if (!text && !images.length) throw new BadRequest("Say something.");
  if (images.length && !web.pictures) throw new BadRequest("This chat does not take pictures.");
  if (tooMany(`turn:${agent.id}/${pass.v}`, 6, MINUTE) || tooMany(`turn@${from(request)}`, 20, MINUTE)) {
    throw new Refused("That is a lot of messages at once. Wait a minute, then try again.", 429);
  }
  const theirs = spent(agent.id, pass.v);
  if (theirs.messages >= web.limits.perVisitor.messages || theirs.dollars >= web.limits.perVisitor.dollars) {
    throw new Refused("That is as much as this chat can answer for you today. Come back tomorrow.", 429);
  }
  if (spent(agent.id).dollars >= web.limits.perDay.dollars) throw new Refused("This chat has answered all it can for today. Come back tomorrow.", 429);

  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const event = (name: string, data: object): void => {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // A visitor who leaves stops the turn, so nobody pays for an answer nobody reads.
  const gone = new AbortController();
  response.on("close", () => response.writableFinished || gone.abort());
  // A proxy closes a response that says nothing for long enough.
  const beat = setInterval(() => !response.destroyed && !response.writableEnded && response.write(": working\n\n"), 15_000);
  event("working", {});

  const facts = noted(agent.id, pass, request);
  const name = facts.name || facts.email || `Visitor ${pass.v.slice(0, 8)}`;

  // Named for who and where, so the owner's list of conversations says so. A name somebody gave it stays.
  const thread = visitorThread(agent.id, pass.v);
  db.prepare("insert into threads (thread, label) values (?, ?) on conflict (thread) do update set label = coalesce(threads.label, excluded.label)").run(
    thread,
    `${name}, ${new URL(pass.o).host}`,
  );

  // Words already streamed are not sent again whole when the tool call they led to is known.
  let drafted = false;
  try {
    const handled = await receive(
      agent,
      {
        channel: "web",
        chat: pass.v,
        thread,
        from: { id: pass.v, name: facts.name || "a visitor" },
        context: facts,
        text,
        private: true,
        model: web.model,
        withoutTools: [...Object.keys(agent.tools ?? {}), "skillRead"].filter((one) => !web.tools.includes(one) && one !== "memoryWriteUserNotes"),
        files: images.length
          ? async () => ({ attachments: images.map(({ name, mediaType, data }) => ({ name, mediaType, data })), notes: images.map((one) => `(Attached: ${one.name})`) })
          : undefined,
        signal: gone.signal,
      },
      { chatHistory: web.chatHistory, sendWhileWorking: true, strangers: true },
      {
        send: async (words) => {
          if (!drafted) event("said", { text: words });
          drafted = false;
        },
        calling: (tool) => {
          drafted = false;
          event("step", { tool: tool.name, text: tool.title ?? "" });
        },
        writing: (delta) => {
          drafted = true;
          event("text", { delta });
        },
      },
    );
    event("done", { runId: handled?.runId, text: handled?.text ?? "", ...(handled?.buttons?.length ? { buttons: handled.buttons } : {}) });
  } catch (error) {
    console.error(`web: ${agent.id} turn failed`, error);
    event("error", { message: "Something went wrong on my end. Try that again." });
  } finally {
    clearInterval(beat);
    response.end();
  }
}

/** What a model was handed ahead of a visitor's words, which is theirs to see no more than the instructions are. */
const CONTEXT = /^<web_context>[\s\S]*?<\/web_context>\n\n/;

/** This visitor's conversation, oldest first, for a page that has just loaded. */
export function webHistory(at: At): void {
  const { agent, web, pass } = visitorOf(at);
  const rows = db
    .prepare("select role, content, at from messages where thread = ? order by id desc limit 100")
    .all(visitorThread(agent.id, pass.v)) as { role: string; content: string; at: string }[];
  at.context.json(at.response, {
    greeting: web.greeting,
    messages: rows.reverse().map(({ role, content, at }) => ({ role, text: role === "user" ? content.replace(CONTEXT, "") : content, at })),
  });
}

/** Forgets this visitor's conversation. */
export function webClear(at: At): void {
  const { agent, pass } = visitorOf(at);
  forget(visitorThread(agent.id, pass.v));
  at.context.json(at.response, { cleared: true });
}

/** What the agent's web channel allows and what has been used of it over the last 24 hours, for its owner. */
export function webUsage(at: At): void {
  const { agent, web } = channelOf(at);
  at.context.json(at.response, { origins: web.origins, tools: web.tools, limits: web.limits, lastDay: spent(agent.id) });
}

/** The chat box and its client, for a page to load. Read once. */
const files = new Map<string, Buffer>();

/** One of the files in chat/: the box a page loads, or the client it is built on. */
export async function webFile(at: At, name: "chat.js" | "client.js"): Promise<void> {
  let body = files.get(name);
  if (!body) {
    // chat/ is beside serve/ in this repo, and beside dist/serve/ once built.
    body = await readFile(new URL(`../chat/${name}`, import.meta.url));
    files.set(name, body);
  }
  at.response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=300",
    // The box imports the client from wherever it came from, which is a module
    // from another site, and a browser asks for that to be allowed.
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  at.response.end(body);
}
