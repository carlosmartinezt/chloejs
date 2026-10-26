// Agents that run in a machine of their own (`workspace.sandbox` in their
// agent.ts), shown on this copy's page as its own. The plugin that makes
// machines makes each one from the definition and keeps it in step; this file
// keeps where each is, and passes everything about its agent on to it.
//
// This copy keeps none of such an agent's runs, its memory or its files, and
// holds only the machine's key. A request is passed on whole, as the owner,
// with the visitor's address in `x-forwarded-for`, so the machine's lockout,
// memory passes and memory audit all see the person and not this copy. The
// owner is passed on as the owner, and a token as a token (its id, name and
// the one agent it is for, when it is for one), so the machine applies its
// own rules for tokens. Somebody invited here is nobody there.
//
// A machine that has stopped is started again when it is asked for and does
// not answer, and a minute or two before one of its jobs is due, read off the
// jobs it last said it has.
import { execFile } from "node:child_process";
import { request as plainRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as secureRequest } from "node:https";

import { db } from "#chloe/core/db";
import type { DefinedAgent } from "#chloe/load/load";
import type { MachineAddress } from "#chloe/load/plugin";
import { PLUGINS } from "#chloe/plugins/index";
import { dueWithin } from "#chloe/timer/cron";
import { from, type Caller } from "./login.ts";

/** One agent's machine, as a call to it needs it: the address and key are "" until it is first ready. */
export interface InMachine {
  agent: string;
  address: string;
  key: string;
  start: string[];
}

/** Each agent that runs in a machine: its definition, where its machine is once ready, and what went wrong when it is not. */
interface Kept {
  definition: DefinedAgent;
  at?: MachineAddress;
  making?: Promise<void>;
  again?: boolean;
  problem?: string;
}

const kept = new Map<string, Kept>();

/**
 * The agents that run in machines, as the config lists them now: each one's
 * machine is made, or made over when its definition changed, in the
 * background. One no longer listed is forgotten here; its machine is left as
 * it is. Called as chloe starts and on every reload.
 */
export function keepMachines(definitions: DefinedAgent[]): void {
  const ids = new Set(definitions.map((one) => one.id));
  for (const id of kept.keys()) if (!ids.has(id)) kept.delete(id);
  for (const definition of definitions) {
    const one = kept.get(definition.id) ?? { definition };
    one.definition = definition;
    kept.set(definition.id, one);
    makeReady(one);
  }
}

/** Has the agent's machine made ready, once at a time: a change that comes while it is being made is made after. */
function makeReady(one: Kept): void {
  if (one.making) {
    one.again = true;
    return;
  }
  one.making = (async () => {
    do {
      one.again = false;
      const id = one.definition.id;
      const machines = PLUGINS.find((plugin) => plugin.machines?.holds(one.definition))?.machines;
      try {
        if (!machines) throw new Error("No plugin here makes machines.");
        one.at = await machines.ready(one.definition);
        if (one.problem) console.log(`${id}: its machine is ready`);
        one.problem = undefined;
      } catch (error) {
        one.problem = error instanceof Error ? error.message : String(error);
        console.error(`${id}: its machine is not ready: ${one.problem}`);
      }
    } while (one.again);
  })().finally(() => (one.making = undefined));
}

/** Shows an agent as running in a machine at that address, with no definition to make it from: for a test's stand-in. */
export function showMachine(agent: string, at: MachineAddress | undefined): void {
  if (!at) return void kept.delete(agent);
  kept.set(agent, { definition: { id: agent } as DefinedAgent, at });
}

/** Waits until the agent's machine is ready, up to `ms`, and says what is wrong with it when it is not, or "". */
export async function whenReady(agent: string, ms: number): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const one = kept.get(agent);
    if (one?.at && !one.making) return "";
    if (one?.problem && !one.making) return one.problem;
    await new Promise((done) => setTimeout(done, 500));
  }
  return kept.get(agent)?.problem ?? "Its machine is still being made.";
}

/** How long a list waits for another copy before showing this copy's own without it. */
const WAIT = 5_000;

/** How long a copy that was started has to answer. */
const WAKING = 60_000;

/** The agent with that id, when it runs in a machine of its own. */
export function inMachine(agent: string): InMachine | undefined {
  const one = kept.get(agent);
  return one ? { agent, ...(one.at ?? { address: "", key: "", start: [] }) } : undefined;
}

/** When each copy last answered, by address: one that answered just now is not asked again before a call. */
const answered = new Map<string, number>();

/** The starts going on now, by address, so many calls at once start a copy once. */
const starting = new Map<string, Promise<void>>();

/** Whether that copy answers now. */
async function answers(where: InMachine): Promise<boolean> {
  if (Date.now() - (answered.get(where.address) ?? 0) < 20_000) return true;
  try {
    await fetch(`${where.address}/api/health`, { headers: { authorization: `Bearer ${where.key}` }, signal: AbortSignal.timeout(1_500) });
    answered.set(where.address, Date.now());
    return true;
  } catch {
    answered.delete(where.address);
    return false;
  }
}

/**
 * Makes sure the agent's machine is up: waits for it to be made the first
 * time, and when it does not answer, starts it and waits until it answers.
 * Throws, saying why, when it has never been ready.
 */
export async function awake(where: InMachine): Promise<void> {
  if (!where.address) {
    const one = kept.get(where.agent);
    if (one?.making && !one.at) await one.making;
    if (one?.at) Object.assign(where, one.at);
    if (!where.address) throw new Error(one?.problem ? `its machine is not ready: ${one.problem}` : "its machine is not ready yet");
  }
  if (!where.start.length || (await answers(where))) return;
  const going = starting.get(where.address);
  if (going) return going;
  const started = (async () => {
    console.log(`${where.agent}: starting it (${where.start.join(" ")})`);
    await new Promise<void>((done) =>
      execFile(where.start[0], where.start.slice(1), { timeout: 30_000 }, (error, _out, said) => {
        if (error) console.error(`${where.agent}: ${where.start.join(" ")} failed: ${said.trim() || error.message}`);
        done();
      }),
    );
    const until = Date.now() + WAKING;
    while (Date.now() < until && !(await answers(where))) await new Promise((done) => setTimeout(done, 500));
  })().finally(() => starting.delete(where.address));
  starting.set(where.address, started);
  return started;
}

/** The jobs each agent in a machine last said it has, by agent, for waking it before one is due. */
const jobsOf = new Map<string, { cron?: string; timezone?: string }[]>();

/**
 * Wakes each copy that sleeps a minute or two before one of its agent's jobs
 * is due, so the job runs on time there. At the start a copy whose jobs are
 * not known yet is woken once to say what they are; it goes back to sleep on
 * its own.
 */
export function keepOnTime(): void {
  const look = async () => {
    for (const one of allInMachines()) {
      if (!one.start.length) continue;
      if (!jobsOf.has(one.agent)) {
        await ask<{ jobs?: { cron?: string; timezone?: string }[] }>(one, `/api/agents/${encodeURIComponent(one.agent)}`).catch(() => undefined);
        continue;
      }
      if (jobsOf.get(one.agent)!.some((job) => job.cron && dueWithin(job.cron, 2, job.timezone))) await awake(one).catch(() => undefined);
    }
  };
  void look();
  setInterval(() => void look(), 60_000).unref();
}

/** Every agent that runs in a machine of its own. */
export function allInMachines(): InMachine[] {
  return [...kept.keys()].flatMap((agent) => inMachine(agent) ?? []);
}

/**
 * Which copy an API call belongs to, or nothing when it is this one's.
 *
 * By the agent its path names: `/api/agents/<id>/...`, a conversation, which
 * is `<agent>/...`, and `?agent=` on the list of models. A run is named by its
 * id only, so one this copy has not got is looked for in the others. The pass
 * for a memory's frame is this copy's to make, because the frame is served
 * from here (`framedInMachine`).
 */
export async function whichMachine(path: string, url: URL): Promise<InMachine | undefined> {
  if (!kept.size) return undefined;
  const parts = path.split("/").filter(Boolean);
  if (parts[1] === "agents" && parts[2]) {
    if (parts.length === 5 && parts[3] === "memory" && parts[4] === "pass") return undefined;
    return inMachine(decodeURIComponent(parts[2]));
  }
  if (parts[1] === "threads" && parts[2]) return inMachine(decodeURIComponent(parts[2]).split("/")[0]);
  if (parts[1] === "models" && parts.length === 2) return inMachine(url.searchParams.get("agent") ?? "");
  if (parts[1] === "runs" && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    if (db.prepare("select 1 from runs where id = ?").get(id)) return undefined;
    for (const one of byAddress()) {
      const found = await ask<{ agent?: string }>(one, `/api/runs/${encodeURIComponent(id)}`).catch(() => undefined);
      if (found?.agent && inMachine(found.agent)?.address === one.address) return inMachine(found.agent);
    }
    return undefined;
  }
  return undefined;
}

/**
 * The agents in machines this caller may see: every one for the owner and for a
 * token made for no one agent, the one a token was made for, and none for
 * somebody invited, who is nobody in another copy.
 */
export function seenBy(who: Caller): InMachine[] {
  if (who?.kind === "account") return allInMachines();
  if (who?.kind === "token") return allInMachines().filter((one) => !who.token.agent || one.agent === who.token.agent);
  return [];
}

/** One entry per copy, for asking a copy that runs several of the agents. */
function byAddress(): InMachine[] {
  const seen = new Map<string, InMachine>();
  for (const one of allInMachines()) if (one.address && !seen.has(one.address)) seen.set(one.address, one);
  return [...seen.values()];
}

/** The headers every call to another copy carries: the owner key, where the caller is, and whether it is a token. */
function headersFor(where: InMachine, request?: IncomingMessage, who?: Caller): Record<string, string> {
  return {
    authorization: `Bearer ${where.key}`,
    ...(request ? { "x-forwarded-for": from(request) } : {}),
    ...(who?.kind === "token"
      ? { "x-chloe-caller": "token", "x-chloe-token-id": who.token.id, "x-chloe-token-name": who.token.name, "x-chloe-token-agent": who.token.agent ?? "" }
      : {}),
  };
}

/** One call to another copy, as the owner, answered as JSON. Throws when it does not answer, or answers with an error. */
export async function ask<T>(where: InMachine, path: string, request?: IncomingMessage, who?: Caller): Promise<T> {
  await awake(where);
  const once = () => fetch(`${where.address}${path}`, { headers: headersFor(where, request, who), signal: AbortSignal.timeout(WAIT) });
  const answer = await once().catch(async (error: Error) => {
    // It may have gone to sleep since it last answered.
    answered.delete(where.address);
    if (!where.start.length) throw error;
    await awake(where);
    return once();
  });
  if (!answer.ok) {
    const said = (await answer.json().catch(() => ({}))) as { error?: string };
    throw new Error(said.error ?? `${answer.status}`);
  }
  answered.set(where.address, Date.now());
  const value = (await answer.json()) as T;
  // An agent's own summary says its jobs, which is what waking it on time needs.
  if (path === `/api/agents/${encodeURIComponent(where.agent)}`) jobsOf.set(where.agent, (value as { jobs?: { cron?: string; timezone?: string }[] }).jobs ?? []);
  return value;
}

/** The most a call passed on may carry: a chat turn with its pictures fits well inside. */
const MOST = 25_000_000;

/**
 * Passes one API call on to the copy that runs its agent, and its answer back,
 * streamed and never cut short: a chat turn answers when it is done, however
 * long that is. The call is read first, so that when the copy turns out to be
 * down it can be started and the same call sent once more.
 */
export async function passOn(request: IncomingMessage, response: ServerResponse, where: InMachine, path: string, who: Caller): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MOST) {
      response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      return void response.end(JSON.stringify({ error: "That is too much to pass on." }));
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  try {
    await awake(where);
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    return void response.end(JSON.stringify({ error: `${where.agent} runs in a machine of its own, and ${(error as Error).message}.` }));
  }
  const refused = await sendOnce(request, response, where, path, body, who);
  if (!refused) return;
  // It answered a moment ago and not now: it may have gone to sleep since.
  answered.delete(where.address);
  if (where.start.length) {
    await awake(where);
    if (!(await sendOnce(request, response, where, path, body, who))) return;
  }
  response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: `${where.agent} runs at ${where.address}, which did not answer: ${refused.message}` }));
}

/** One try at passing a call on. Resolves with the error when the copy could not be reached, before anything was answered. */
function sendOnce(request: IncomingMessage, response: ServerResponse, where: InMachine, path: string, body: Buffer, who: Caller): Promise<Error | undefined> {
  return new Promise((done) => {
    const target = new URL(path, where.address);
    const send = target.protocol === "https:" ? secureRequest : plainRequest;
    const headers: Record<string, string> = { ...headersFor(where, request, who), "content-length": String(body.length) };
    for (const name of ["content-type", "x-chloe-channel"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const out = send(target, { method: request.method, headers }, (answer) => {
      answered.set(where.address, Date.now());
      const passed: Record<string, string> = {};
      for (const name of ["content-type", "content-length", "cache-control"]) {
        const value = answer.headers[name];
        if (typeof value === "string") passed[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, passed);
      answer.pipe(response);
      answer.on("end", () => done(undefined));
      answer.on("error", () => (response.destroy(), done(undefined)));
    });
    out.on("error", (error) => {
      if (!response.headersSent) return done(error);
      response.destroy();
      done(undefined);
    });
    out.end(body);
  });
}

/**
 * The summary of every agent that runs in a machine, as its machine gives it,
 * with the machine's address as `address`. One whose machine is not ready or
 * does not answer is still listed, saying why, so it does not vanish from the
 * page while its machine is being made or is down.
 */
export async function summariesInMachines(request: IncomingMessage, who: Caller): Promise<Record<string, unknown>[]> {
  const unanswered = (one: InMachine, why: string) => ({
    address: one.address,
    id: one.agent,
    identity: why,
    model: "",
    declaredModel: "",
    chosen: [],
    channels: [],
    api: false,
    memory: "Memory",
    tools: [],
    skills: [],
    jobs: [],
  });
  return Promise.all(
    seenBy(who).map((one) => {
      if (!one.address) {
        const problem = kept.get(one.agent)?.problem;
        return unanswered(one, problem ? `Its machine is not ready: ${problem}` : "Its machine is being made.");
      }
      return ask<Record<string, unknown>>(one, `/api/agents/${encodeURIComponent(one.agent)}`, request, who).then(
        (got) => ({ ...got, address: one.address }),
        (error: Error) => unanswered(one, `Runs at ${one.address}, which is not answering: ${error.message}`),
      );
    }),
  );
}

/**
 * What every other copy answers for a list (runs, waiting jobs), cut to the
 * agents this copy shows from it. A copy that does not answer adds nothing.
 */
export async function listsInMachines<Row extends { agent: string }>(path: string, request: IncomingMessage, who: Caller, agent?: string): Promise<Row[]> {
  const wanted = seenBy(who).filter((one) => one.address && (!agent || one.agent === agent));
  const copies = new Map<string, string[]>();
  for (const one of wanted) copies.set(one.address, [...(copies.get(one.address) ?? []), one.agent]);
  const lists = await Promise.all(
    [...copies].map(async ([address, agents]) => {
      const one = wanted.find((each) => each.address === address)!;
      const rows = await ask<Row[]>(one, path, request, who).catch(() => []);
      return rows.filter((row) => agents.includes(row.agent));
    }),
  );
  return lists.flat();
}

/** Which jobs are running right now in the other copies, as `<agent>/<job>`. */
export async function runningInMachines(request: IncomingMessage, who: Caller): Promise<{ agents: string[]; running: string[] }> {
  const shown = new Set(seenBy(who).map((one) => one.agent));
  const answers = await Promise.all(
    byAddress()
      .filter((one) => shown.has(one.agent))
      .map((one) => ask<{ agents: string[]; running: string[] }>(one, "/api/health", request, who).catch(() => undefined)),
  );
  return {
    agents: [...new Set(answers.flatMap((one) => one?.agents ?? []))].filter((one) => shown.has(one)),
    running: [...new Set(answers.flatMap((one) => one?.running ?? []))].filter((one) => shown.has(one.split("/")[0])),
  };
}

/**
 * A file from the memory of an agent that runs in a machine, for the frame this
 * copy shows it in. That copy is asked for a pass of its own, made for the
 * visitor's address, and then for the file, so it records the read in its own
 * memory audit before it hands it over, as it would for a frame of its own.
 * Its pass in the file's links is swapped for this copy's, which is the one the
 * frame's address carries.
 */
export async function framedInMachine(
  where: InMachine,
  path: string,
  request: IncomingMessage,
  under: string,
): Promise<{ body: Buffer; type: string } | null> {
  // A segment that walks up would leave the memory once the address is read,
  // so it is refused here rather than trusted to the other copy.
  const segments = path.split("/");
  if (segments.some((one) => one === "" || one === "." || one === "..")) return null;
  const { pass } = await ask<{ pass: string }>(where, `/api/agents/${encodeURIComponent(where.agent)}/memory/pass`, request);
  const theirs = `/memory/${encodeURIComponent(pass)}`;
  const target = new URL(`${theirs}/${segments.map(encodeURIComponent).join("/")}`, where.address);
  if (!target.pathname.startsWith(`${theirs}/`)) return null;
  // The pass is all a frame needs, so the file is asked for without the owner key.
  const answer = await fetch(target, { headers: { "x-forwarded-for": from(request) }, signal: AbortSignal.timeout(WAIT) });
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Error(`${where.agent}'s memory runs at ${where.address}, which answered ${answer.status}.`);
  const type = answer.headers.get("content-type") ?? "application/octet-stream";
  let body: Buffer = Buffer.from(await answer.arrayBuffer());
  if (type.startsWith("text/html")) body = Buffer.from(body.toString("utf8").split(`${theirs}/`).join(`${under}/`));
  return { body, type };
}
