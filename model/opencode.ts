// Asking the model through opencode rather than from the provider itself.
//
// Like claude.ts and codex.ts this exists for the credential: opencode signs in
// to whatever accounts a person has given it, and those are not API keys. The
// route "opencode" in settings picks it.
//
// Unlike the other two it is not one provider's program. What it can run is
// whatever it is signed in to, which it will say, so `opencodeModels()` asks it
// rather than this file deciding.
//
// Each call starts a server of its own, `opencode serve --stdio`, on loopback
// with a password made for the call, in an empty folder whose config names one
// agent, and talks to it over its HTTP API. A turn's tools are handed over as
// real ones through `toolServer.ts`, which runs nothing: opencode asks before it
// runs one, chloe refuses every time, and opencode stops after the model's first
// answer, so the calls are read from its events as data. Its own tools are all
// refused, so the model never sees them.
//
// `opencode run` cannot do this. It sends the first request before the tool
// server has connected, so the model answers with no tools, and when it is
// refused a tool it carries on and asks the model again.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { settings } from "#chloe/core/settings";

import { asText, TOOL_SERVER } from "./cli.ts";
import { type Answer, type Ask, type Message, type ToolCall, type ToolSpec, UsageLimit } from "./model.ts";

/** The CLI names a model provider first, the same way chloe does, so nothing is rewritten. */
export function opencodeModel(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}

/** The agent written into the config, and the tool server's name, which opencode puts in front of each of its tools. */
const AGENT = "chloe";
const PREFIX = `${AGENT}_`;

/**
 * Every tool refused but the tool server's, and each of those asked about
 * before it runs, which chloe answers no to: that is what stops opencode after
 * the model's first answer. A later rule wins, so these go on the agent and on
 * the session, after anything the person's own opencode config allows.
 */
const RULES = [
  { action: "*", resource: "*", effect: "deny" },
  { action: `${PREFIX}*`, resource: "*", effect: "ask" },
];

/**
 * How long after the tool server connects its tools are offered. opencode lists
 * them 100ms after it connects and says nothing when it has, and a request made
 * before then has no tools at all.
 */
const LISTED = 300;

/**
 * The folder's config, in opencode 2's own shape: the agent with the request's
 * instructions, the tool server when there are tools, each offered as itself
 * rather than through opencode's `execute`, and no session titles, which it
 * would ask the model for on every call. No `$schema` line: opencode fetches
 * the URL in one, and a box with no way out then hangs instead of answering.
 */
function config(system: string, specs?: string): string {
  return JSON.stringify({
    snapshots: false,
    ...(specs && { mcp: { servers: { [AGENT]: { type: "local", command: [process.execPath, TOOL_SERVER, specs], codemode: false } } } }),
    agents: {
      [AGENT]: {
        description: "Answers for chloe, whose tools chloe runs.",
        mode: "primary",
        system: system || "Answer the conversation below.",
        permissions: RULES,
      },
      title: { disabled: true },
    },
  });
}

/** One event from the server's stream. Only the fields read here are named. */
interface Event {
  type?: string;
  data?: {
    sessionID?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
    finish?: string;
    cost?: number;
    tokens?: { input?: number; output?: number };
    error?: { type?: string; message?: string };
    reason?: string;
  };
}

/** What the model said, asked for and spent, read from the events of its answer. The cost is left out when opencode names none. */
interface Reading {
  said: string[];
  calls: { name: string; input: Record<string, unknown> }[];
  cost?: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Reads the events of one answer, refusing each tool as opencode asks about it,
 * until the answer is over: a step that ends, or one that fails because its
 * tools were refused. `reply` answers opencode, and `events` are the server's,
 * of every session. Throws the error a failed step or session gives, and a
 * provider's usage limit as `UsageLimit`.
 */
async function readAnswer(
  events: AsyncIterable<Event>,
  session: string,
  reply: (path: string, body?: unknown) => Promise<unknown>,
): Promise<Reading> {
  const read: Reading = { said: [], calls: [], tokensIn: 0, tokensOut: 0 };
  const named = new Map<string, string>();
  const spent = (data: NonNullable<Event["data"]>) => {
    if (typeof data.cost === "number") read.cost = (read.cost ?? 0) + data.cost;
    read.tokensIn += data.tokens?.input ?? 0;
    read.tokensOut += data.tokens?.output ?? 0;
  };
  for await (const { type, data = {} } of events) {
    if (data.sessionID !== session) continue;
    if (type === "session.text.ended" && data.text?.trim()) read.said.push(data.text.trim());
    if (type === "session.tool.input.started" && data.id) named.set(data.id, data.name ?? "");
    if (type === "session.tool.called" && data.id) read.calls.push({ name: named.get(data.id) ?? "", input: data.input ?? {} });
    // A refusal with no message is one opencode does not carry on from.
    if (type === "permission.asked" && data.id) await reply(`/permission/${data.id}/reply`, { decision: "reject" });
    if (type === "session.step.ended") {
      spent(data);
      // Calls that failed before asking, such as one to a tool it does not
      // have, leave nothing waiting, and opencode would ask the model again.
      if (read.calls.length) await reply("/interrupt");
      return read;
    }
    if (type === "session.step.failed") {
      spent(data);
      if (read.calls.length && data.error?.type === "aborted") return read;
      throw failure(data.error);
    }
    if (type === "session.execution.failed") throw failure(data.error);
    if (type === "session.execution.interrupted") throw failure({ message: `it stopped the answer (${data.reason ?? "no reason given"})` });
    if (type === "session.execution.succeeded") return read;
  }
  throw new Error("Model call refused: opencode stopped before the answer was over.");
}

function failure(error: { type?: string; message?: string } = {}): Error {
  const why = (error.message ?? error.type ?? "no reason given").slice(0, 500);
  if (error.type === "provider.quota") {
    return new UsageLimit(`I have hit a usage limit on the account opencode reaches this model through, so I cannot answer until it is lifted. It says: ${why}`);
  }
  return new Error(`Model call refused: opencode: ${why}`);
}

/** The calls a model asked for, as tools it was handed. A call to any other tool does not count, and the same call twice counts once. */
function handed(asked: Reading["calls"], tools: ToolSpec[] = []): ToolCall[] {
  // opencode lists a tool with anything but a letter, digit, _ or - made a _.
  const byName = new Map(tools.flatMap((one) => [[`${PREFIX}${one.name.replace(/[^\w-]/g, "_")}`, one.name], [one.name, one.name]]));
  const calls: ToolCall[] = [];
  for (const call of asked) {
    const name = byName.get(call.name);
    const args = JSON.stringify(call.input);
    if (!name || calls.some((one) => one.function.name === name && one.function.arguments === args)) continue;
    calls.push({ id: randomUUID(), type: "function", function: { name, arguments: args } });
  }
  return calls;
}

/** A server of opencode's own for one call, and what reaching it takes. */
interface Server {
  url: string;
  headers: Record<string, string>;
  child: ChildProcess;
}

/**
 * Starts `opencode serve` in the folder, on loopback, with a password made for
 * this call, and waits for the address it prints. It stops when its input
 * closes, so it cannot outlive this process.
 */
async function start(folder: string, signal?: AbortSignal): Promise<Server> {
  const cli = settings.model.program.opencode;
  const password = randomBytes(24).toString("base64url");
  const child = spawn(cli, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: folder,
    // The CLI reads PWD rather than asking the system where it is, and a
    // spawned process keeps its parent's PWD whatever its working folder.
    env: { ...process.env, PWD: folder, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_FILEWATCHER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => (said = (said + chunk.toString()).slice(-2000)));
  // Read until the first line, which is the address, and drained after.
  let out: string | undefined = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    const url = await new Promise<string>((done, fail) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (out === undefined) return;
        out += chunk.toString();
        const line = out.split("\n").find((one) => one.trim().startsWith("{"));
        let address: unknown;
        try {
          address = line && (JSON.parse(line) as { url?: unknown }).url;
        } catch {}
        if (typeof address === "string") done(address);
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        fail(error.code === "ENOENT" ? new Error(`The opencode route needs ${JSON.stringify(cli)} on the path. Install opencode, or put it on the path.`) : error),
      );
      child.on("exit", (code) =>
        fail(new Error(`Model call refused: opencode serve exited ${code} before it listened: ${said.trim().slice(-500) || "it said nothing"}. The opencode route needs opencode 2 or later.`)),
      );
      signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
      timer = setTimeout(() => fail(new Error("Model call refused: opencode serve did not start within 30 seconds.")), 30_000);
    });
    return { url, child, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    out = undefined;
    clearTimeout(timer);
  }
}

/** One request to the server, answered as JSON. A status in `fine` is not an error. */
async function call<T = unknown>(server: Server, method: string, path: string, body?: unknown, signal?: AbortSignal, fine: number[] = []): Promise<T> {
  const response = await fetch(server.url + path, {
    method,
    headers: body === undefined ? server.headers : { ...server.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok && !fine.includes(response.status)) {
    throw new Error(`Model call refused: opencode answered ${method} ${path.split("?")[0]} with ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

/** The server's events as they come, one object each, from a stream already opened. */
async function* events(response: Response): AsyncGenerator<Event> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let held = "";
  try {
    for await (const chunk of response.body) {
      held += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
        const data = held
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        held = held.slice(end + 2);
        let event: Event | undefined;
        try {
          event = data ? (JSON.parse(data) as Event) : undefined;
        } catch {}
        if (event) yield event;
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(`Model call refused: opencode stopped answering: ${(error as Error).message}`);
  }
}

/**
 * Waits for the tool server to be connected, then for opencode to offer its
 * tools. Asking is what starts it: opencode starts a folder's servers the first
 * time anything is asked about that folder.
 */
async function connected(server: Server, folder: string, signal?: AbortSignal): Promise<void> {
  const where = new URLSearchParams({ "location[directory]": folder });
  const until = Date.now() + 30_000;
  for (;;) {
    const { data = [] } = await call<{ data?: { name?: string; status?: { status?: string; error?: string } }[] }>(server, "GET", `/api/mcp?${where}`, undefined, signal);
    const status = data.find((one) => one.name === AGENT)?.status;
    if (status?.status === "connected") break;
    if (status && status.status !== "pending") throw new Error(`Model call refused: opencode could not start chloe's tool server: ${status.error ?? status.status}`);
    if (Date.now() > until) throw new Error("Model call refused: opencode did not start chloe's tool server within 30 seconds.");
    await sleep(50, undefined, { signal });
  }
  await sleep(LISTED, undefined, { signal });
}

/** A photo or a PDF goes with the prompt as a file. Anything else is named in the prompt, so the model knows it was sent. */
function attached(messages: Message[]): { files: { uri: string; name?: string }[]; notes: string[] } {
  const files: { uri: string; name?: string }[] = [];
  const notes: string[] = [];
  for (const file of messages.flatMap((m) => m.attachments ?? [])) {
    if (file.mediaType.startsWith("image/") || file.mediaType === "application/pdf") {
      files.push({ uri: `data:${file.mediaType};base64,${file.data}`, ...(file.filename && { name: file.filename }) });
    } else {
      notes.push(`(A file called ${file.filename ?? "file"}, a ${file.mediaType}, was sent, and this route cannot read it.)`);
    }
  }
  return { files, notes };
}

/** Closes the session and the server, which takes the tool server with it, killing it when it does not go within three seconds. */
async function stop(server: Server, session?: string): Promise<void> {
  if (session) await call(server, "DELETE", `/api/session/${session}`, undefined, AbortSignal.timeout(2_000)).catch(() => {});
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<boolean>((done) => child.once("exit", () => done(true)));
  child.stdin?.end();
  if (!(await Promise.race([gone, sleep(3_000, false)]))) child.kill("SIGKILL");
}

export async function viaOpencode({ model, messages, tools, signal }: Ask): Promise<Answer> {
  const { system, transcript } = asText({ messages, tools, native: PREFIX });
  const folder = await mkdtemp(join(tmpdir(), "chloe-opencode-"));
  const quit = new AbortController();
  const stopping = signal ? AbortSignal.any([signal, quit.signal]) : quit.signal;
  let server: Server | undefined;
  let session: string | undefined;
  try {
    const specs = tools?.length ? join(folder, "tools.json") : undefined;
    if (specs) await writeFile(specs, JSON.stringify(tools));
    await writeFile(join(folder, "opencode.json"), config(system, specs));
    server = await start(folder, signal);
    const live = server;
    // Opened before the prompt, so no event of the answer is missed.
    const stream = await fetch(`${live.url}/api/event`, { headers: { ...live.headers, accept: "text/event-stream" }, signal: stopping });
    if (!stream.ok) throw new Error(`Model call refused: opencode answered its event stream with ${stream.status}.`);
    if (specs) await connected(live, folder, signal);
    const named = opencodeModel(model);
    const at = named.indexOf("/");
    const made = await call<{ data?: { id?: string } }>(live, "POST", "/api/session", {
      agent: AGENT,
      model: { providerID: named.slice(0, at), id: named.slice(at + 1) },
      location: { directory: folder },
      permissions: RULES,
    }, signal);
    session = made.data?.id;
    if (!session) throw new Error("Model call refused: opencode made no session.");
    const { files, notes } = attached(messages);
    await call(live, "POST", `/api/session/${session}/prompt`, { text: [transcript, ...notes].join("\n\n"), ...(files.length && { files }) }, signal);
    const read = await readAnswer(events(stream), session, (path, body) => call(live, "POST", `/api/session/${session}${path}`, body, signal, [404]));
    return { text: read.said.join("\n\n"), toolCalls: handed(read.calls, tools), cost: read.cost ?? 0, tokensIn: read.tokensIn, tokensOut: read.tokensOut };
  } finally {
    quit.abort();
    if (server) await stop(server, session);
    await rm(folder, { recursive: true, force: true });
  }
}

let known: string[] | undefined;

/**
 * The models opencode is signed in to, provider first, as it reports them. Asked
 * rather than written down, because what it can run is whoever a person has
 * given it credentials for.
 *
 * Read once and kept, because `routeFor()` needs it to decide and cannot wait:
 * asking takes about two seconds, so the first call pays that and a restart is
 * what picks up a credential added since. An empty list is a CLI that is not
 * there or has nobody signed in, and then nothing routes here.
 */
export function opencodeModels(): string[] {
  if (known) return known;
  const cli = settings.model.program.opencode;
  // Now and then it prints nothing and exits as if it had answered, so an
  // empty list is asked for again before it is believed.
  for (let tries = 0; tries < 3; tries++) {
    const done = spawnSync(cli, ["models"], { encoding: "utf8", timeout: 20_000 });
    if (done.status !== 0) break;
    known = done.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+\/[\w.:-]+$/.test(line));
    if (known.length) return known;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  known = [];
  return known;
}

/** Ask again, for a reload rather than a restart. */
export function forgetOpencodeModels(): void {
  known = undefined;
}
