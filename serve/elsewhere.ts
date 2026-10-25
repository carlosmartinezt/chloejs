// Agents that run in another copy of chloe, shown on this copy's page as its
// own: `serve.elsewhere` names each by id, with the address of that copy and
// its owner key.
//
// Everything about such an agent is asked of the copy it runs in: this copy
// keeps none of its runs, its memory or its files, and holds only the key. A
// request is passed on whole, as the owner, with the visitor's address in
// `x-forwarded-for`, so that copy's lockout, memory passes and memory audit
// all see the person and not this copy. Only the owner is passed on: a token
// or somebody invited here is nobody there.
import { request as plainRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as secureRequest } from "node:https";

import { db } from "#chloe/core/db";
import { settings } from "#chloe/core/settings";
import { from } from "./login.ts";

/** Where one agent runs, and the key that copy takes as its owner. */
export interface Elsewhere {
  agent: string;
  address: string;
  key: string;
}

/** How long a list waits for another copy before showing this copy's own without it. */
const WAIT = 5_000;

/** The agent with that id, when it runs in another copy. */
export function elsewhere(agent: string): Elsewhere | undefined {
  const found = Object.hasOwn(settings.serve.elsewhere, agent) ? settings.serve.elsewhere[agent] : undefined;
  return found?.address ? { agent, address: found.address.replace(/\/+$/, ""), key: found.key } : undefined;
}

/** Every agent that runs in another copy. */
export function allElsewhere(): Elsewhere[] {
  return Object.keys(settings.serve.elsewhere).flatMap((agent) => elsewhere(agent) ?? []);
}

/**
 * Which copy an API call belongs to, or nothing when it is this one's.
 *
 * By the agent its path names: `/api/agents/<id>/...`, a conversation, which
 * is `<agent>/...`, and `?agent=` on the list of models. A run is named by its
 * id only, so one this copy has not got is looked for in the others. The pass
 * for a memory's frame is this copy's to make, because the frame is served
 * from here (`framedElsewhere`).
 */
export async function whereElse(path: string, url: URL): Promise<Elsewhere | undefined> {
  if (!Object.keys(settings.serve.elsewhere).length) return undefined;
  const parts = path.split("/").filter(Boolean);
  if (parts[1] === "agents" && parts[2]) {
    if (parts.length === 5 && parts[3] === "memory" && parts[4] === "pass") return undefined;
    return elsewhere(decodeURIComponent(parts[2]));
  }
  if (parts[1] === "threads" && parts[2]) return elsewhere(decodeURIComponent(parts[2]).split("/")[0]);
  if (parts[1] === "models" && parts.length === 2) return elsewhere(url.searchParams.get("agent") ?? "");
  if (parts[1] === "runs" && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    if (db.prepare("select 1 from runs where id = ?").get(id)) return undefined;
    for (const one of byAddress()) {
      const found = await ask<{ agent?: string }>(one, `/api/runs/${encodeURIComponent(id)}`).catch(() => undefined);
      if (found?.agent && elsewhere(found.agent)?.address === one.address) return elsewhere(found.agent);
    }
    return undefined;
  }
  return undefined;
}

/** One entry per copy, for asking a copy that runs several of the agents. */
function byAddress(): Elsewhere[] {
  const seen = new Map<string, Elsewhere>();
  for (const one of allElsewhere()) if (!seen.has(one.address)) seen.set(one.address, one);
  return [...seen.values()];
}

/** The headers every call to another copy carries: the owner key, and who is really asking. */
function headersFor(where: Elsewhere, request?: IncomingMessage): Record<string, string> {
  return {
    authorization: `Bearer ${where.key}`,
    ...(request ? { "x-forwarded-for": from(request) } : {}),
  };
}

/** One call to another copy, as the owner, answered as JSON. Throws when it does not answer, or answers with an error. */
export async function ask<T>(where: Elsewhere, path: string, request?: IncomingMessage): Promise<T> {
  const answer = await fetch(`${where.address}${path}`, { headers: headersFor(where, request), signal: AbortSignal.timeout(WAIT) });
  if (!answer.ok) {
    const said = (await answer.json().catch(() => ({}))) as { error?: string };
    throw new Error(said.error ?? `${answer.status}`);
  }
  return (await answer.json()) as T;
}

/**
 * Passes one API call on to the copy that runs its agent, and its answer back,
 * both streamed and neither cut short: a chat turn answers when it is done,
 * however long that is.
 */
export function passOn(request: IncomingMessage, response: ServerResponse, where: Elsewhere, path: string): Promise<void> {
  return new Promise((done) => {
    const target = new URL(path, where.address);
    const send = target.protocol === "https:" ? secureRequest : plainRequest;
    const headers: Record<string, string> = headersFor(where, request);
    for (const name of ["content-type", "content-length", "x-chloe-channel"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const out = send(target, { method: request.method, headers }, (answer) => {
      const kept: Record<string, string> = {};
      for (const name of ["content-type", "content-length", "cache-control"]) {
        const value = answer.headers[name];
        if (typeof value === "string") kept[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, kept);
      answer.pipe(response);
      answer.on("end", done);
      answer.on("error", () => (response.destroy(), done()));
    });
    out.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: `${where.agent} runs at ${where.address}, which did not answer: ${error.message}` }));
      } else response.destroy();
      done();
    });
    request.pipe(out);
  });
}

/**
 * The summary of every agent that runs elsewhere, as its own copy gives it.
 * One that does not answer is still listed, saying why, so it does not vanish
 * from the page while its machine is down.
 */
export async function summariesElsewhere(request: IncomingMessage): Promise<Record<string, unknown>[]> {
  return Promise.all(
    allElsewhere().map((one) =>
      ask<Record<string, unknown>>(one, `/api/agents/${encodeURIComponent(one.agent)}`, request).catch((error: Error) => ({
        id: one.agent,
        identity: `Runs at ${one.address}, which is not answering: ${error.message}`,
        model: "",
        declaredModel: "",
        chosen: [],
        channels: [],
        api: false,
        memory: "Memory",
        tools: [],
        skills: [],
        jobs: [],
      })),
    ),
  );
}

/**
 * What every other copy answers for a list (runs, waiting jobs), cut to the
 * agents this copy shows from it. A copy that does not answer adds nothing.
 */
export async function listsElsewhere<Row extends { agent: string }>(path: string, request: IncomingMessage, agent?: string): Promise<Row[]> {
  const wanted = agent ? allElsewhere().filter((one) => one.agent === agent) : allElsewhere();
  const copies = new Map<string, string[]>();
  for (const one of wanted) copies.set(one.address, [...(copies.get(one.address) ?? []), one.agent]);
  const lists = await Promise.all(
    [...copies].map(async ([address, agents]) => {
      const one = wanted.find((each) => each.address === address)!;
      const rows = await ask<Row[]>(one, path, request).catch(() => []);
      return rows.filter((row) => agents.includes(row.agent));
    }),
  );
  return lists.flat();
}

/** Which jobs are running right now in the other copies, as `<agent>/<job>`. */
export async function runningElsewhere(request: IncomingMessage): Promise<{ agents: string[]; running: string[] }> {
  const answers = await Promise.all(
    byAddress().map((one) => ask<{ agents: string[]; running: string[] }>(one, "/api/health", request).catch(() => undefined)),
  );
  const shown = new Set(allElsewhere().map((one) => one.agent));
  return {
    agents: [...new Set(answers.flatMap((one) => one?.agents ?? []))].filter((one) => shown.has(one)),
    running: [...new Set(answers.flatMap((one) => one?.running ?? []))].filter((one) => shown.has(one.split("/")[0])),
  };
}

/**
 * A file from the memory of an agent that runs elsewhere, for the frame this
 * copy shows it in. That copy is asked for a pass of its own, made for the
 * visitor's address, and then for the file, so it records the read in its own
 * memory audit before it hands it over, as it would for a frame of its own.
 * Its pass in the file's links is swapped for this copy's, which is the one the
 * frame's address carries.
 */
export async function framedElsewhere(
  where: Elsewhere,
  path: string,
  request: IncomingMessage,
  under: string,
): Promise<{ body: Buffer; type: string } | null> {
  const { pass } = await ask<{ pass: string }>(where, `/api/agents/${encodeURIComponent(where.agent)}/memory/pass`, request);
  const theirs = `/memory/${encodeURIComponent(pass)}`;
  const answer = await fetch(`${where.address}${theirs}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: headersFor(where, request),
    signal: AbortSignal.timeout(WAIT),
  });
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Error(`${where.agent}'s memory runs at ${where.address}, which answered ${answer.status}.`);
  const type = answer.headers.get("content-type") ?? "application/octet-stream";
  let body: Buffer = Buffer.from(await answer.arrayBuffer());
  if (type.startsWith("text/html")) body = Buffer.from(body.toString("utf8").split(`${theirs}/`).join(`${under}/`));
  return { body, type };
}
