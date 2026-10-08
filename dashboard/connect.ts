// The connection to the remote dashboard: a dashboard somewhere else that shows this
// runtime, reached by this runtime connecting out to it and nothing else.
//
// One WebSocket, opened here, kept open, opened again when it drops. The first
// message says which workspace this is (the key rides inside the encrypted
// connection, never in the address or a header, so no proxy logs it) and what
// the runtime has: its version, the machine it runs on, its routes, its agents,
// and which switches in `dashboard.remote.allow` are on. After that two things happen on
// it:
//
//   up      a run's facts when a run starts or ends (its words only with
//           `upload.replies`), and the agents when they reload, each only if
//           `dashboard.remote.upload` says so
//   down    a request, which is an ordinary HTTP request to this runtime's own
//           API carried in a message. It is made against the one port with a
//           secret only this process knows, so `caller()` in serve/login.ts
//           knows it came through the dashboard, and api() in serve/http.ts
//           decides whether that route, with the switches this workspace
//           has on, may be answered. The answer goes back whole, with the
//           same id. The dashboard is for the owner and the people they
//           invite: it never carries a visitor's request to the web
//           channel, which reaches this runtime through the owner's own
//           server or not at all.
//
// Nothing here changes how a job runs. With no dashboard.remote.api_key there is no
// connection, and the only line this file writes is saying so once.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { db } from "#chloe/core/db";
import { events } from "#chloe/core/events";
import { settings, whereKeyGoes } from "#chloe/core/settings";
import type { Agent } from "#chloe/load/load";
import { ownAddress, routeList, summary } from "#chloe/serve/http";
import { RELAY, RELAY_GUEST, RELAY_NAME, RELAY_SECRET, RELAY_UNDER, RELAY_USER } from "#chloe/serve/login";

/** The version of what is said on the socket. The dashboard refuses one it does not speak. */
export const PROTOCOL = 1;

/** What the runtime opens: Node's own WebSocket, or whatever a test hands in. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DashboardOptions {
  agents: () => Map<string, Agent>;
  /** Where this runtime answers, for a relayed request. The one port, unless a test says otherwise. */
  self?: string;
  /** Opens a socket to an address. Node's own WebSocket unless a test hands in another. */
  socket?: (address: string) => Socket;
  /** How long to wait before connecting again, the first time and at most, in milliseconds. */
  backoff?: { first: number; most: number };
  /** What this runtime says it is. The package's own version unless given. */
  version?: string;
  /**
   * Where a line about the connection goes, as it changes. console.log unless
   * the caller wants it somewhere else: the server holds the first one back so
   * it can print it in among everything else it says at startup.
   */
  says?: (line: string) => void;
}

/** The connection, as the server holds it. */
export interface Dashboard {
  /** The settings or the agents changed: send the agents up, and connect again if the address or the key changed. */
  reload(): void;
  /** Whether the dashboard has said welcome on the socket that is open now. */
  connected(): boolean;
  stop(): void;
}

/** The only two things a dashboard may ask for: the API, and a memory file for its frame. */
const RELAYED = /^\/(api|memory)(\/|$|\?)/;

/** What a request from the dashboard has to look like. Anything else is dropped. */
const Request = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  method: z.enum(["GET", "POST", "OPTIONS"]),
  path: z.string().startsWith("/").regex(RELAYED, "only /api and /memory are relayed"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().nullable().default(null),
});

/** The headers a relayed request keeps. Everything else the browser sent stayed with the dashboard. */
const CARRIED = [
  "accept",
  "content-type",
  "host",
  "x-forwarded-proto",
  "x-forwarded-for",
  RELAY_USER,
  RELAY_UNDER,
  RELAY_GUEST,
  RELAY_NAME,
];

/** The headers an answer does not carry back: a session is never set through the dashboard, and the rest are the socket's own. */
const KEPT_BACK = new Set(["set-cookie", "connection", "transfer-encoding", "content-length", "keep-alive"]);

/** How many runs go up when the connection opens, so the dashboard has a history to show while this runtime is offline. */
const CATCH_UP = 200;

/** What goes up of every run: what happened, never what was said. */
const SENT = "id, agent, started, finished, source, job, model, steps, cost, error, archived";

/** A dashboard that takes the socket and does not say welcome is not one: the socket is closed and tried again. */
const WELCOME_WITHIN = 15_000;

/**
 * The biggest body relayed either way. A memory file with pictures in it is
 * one message, and base64 makes it a third bigger again, so a file past this
 * is refused here with a 413 rather than closing the socket at the far end.
 */
const LARGEST = 32 * 1024 * 1024;

/**
 * Opens the connection to the dashboard named in settings and keeps it open.
 * Returns at once; connecting happens behind it. With no `dashboard.remote.url` it says so
 * once and waits for `reload()` to bring one.
 */
export function startDashboard(options: DashboardOptions): Dashboard {
  const self = new URL(options.self ?? ownAddress());
  const make = options.socket ?? ((address: string) => new WebSocket(address) as unknown as Socket);
  const backoff = options.backoff ?? { first: 1000, most: 60_000 };
  const version = options.version ?? ownVersion();

  let socket: Socket | undefined;
  let welcomed = false;
  let stopped = false;
  let wait = backoff.first;
  let timer: NodeJS.Timeout | undefined;
  /** What the open socket was opened with, so a change to either is noticed. */
  let using = { url: "", key: "" };
  /** The last line written, so a dashboard that is down is one line and not one a second. */
  let said = "";

  function where(): { url: string; key: string } {
    return {
      url: settings.dashboard.remote.url.trim().replace(/\/+$/, ""),
      key: settings.dashboard.remote.api_key.trim(),
    };
  }

  const tell = options.says ?? ((line: string) => console.log(`dashboard: ${line}`));

  function say(line: string): void {
    if (line === said) return;
    said = line;
    tell(line);
  }

  function send(one: Socket, message: unknown): void {
    try {
      one.send(JSON.stringify(message));
    } catch (error) {
      // A socket that closed between the check and the send. The close event
      // is on its way and will connect again.
      say(`could not send: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function agentList() {
    return [...options.agents().values()].map(summary);
  }

  function hello(key: string) {
    return {
      type: "hello",
      protocol: PROTOCOL,
      key,
      coreVersion: version,
      nodeVersion: process.version,
      // Read here rather than written down, so the dashboard can say which
      // machine of yours this is. It is whatever the box calls itself, which
      // on a laptop is usually its owner's name.
      machine: hostname(),
      // "guests": this runtime checks what an invited person may do itself, so
      // the dashboard may relay their requests here.
      capabilities: ["relay", "runs", "agents", "guests"],
      upload: settings.dashboard.remote.upload,
      allow: settings.dashboard.remote.allow,
      routes: routeList(),
      agents: settings.dashboard.remote.upload.agents ? agentList() : [],
    };
  }

  function connect(): void {
    clearTimeout(timer);
    if (stopped) return;
    const want = where();
    using = want;
    if (!want.key) return say(`not connected: no dashboard.remote.api_key. Make a workspace on the dashboard and put its key ${whereKeyGoes(["dashboard", "remote", "api_key"])}.`);
    if (!want.url) return say("not connected: dashboard.remote.url in settings is empty.");

    const address = `${want.url.replace(/^http/, "ws")}/connect`;
    let one: Socket;
    try {
      one = make(address);
    } catch (error) {
      say(`could not open ${address}: ${error instanceof Error ? error.message : String(error)}`);
      return again();
    }
    socket = one;
    welcomed = false;
    one.onopen = () => {
      send(one, hello(want.key));
      // Nothing else is sent until the dashboard answers, so a dashboard that never
      // does is closed rather than held.
      const waiting = setTimeout(() => {
        if (socket === one && !welcomed) {
          say(`${want.url} took the connection and did not say welcome`);
          one.close(1002, "no welcome");
        }
      }, WELCOME_WITHIN);
      waiting.unref();
    };
    one.onmessage = (event) =>
      void receive(one, String(event.data)).catch((error) => {
        // One message from the dashboard must not end the process: a line is
        // enough. The request it was carrying is left unanswered, and the
        // dashboard times it out and shows the error.
        say(`a message failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    // An error is always followed by a close, which is where it is dealt with.
    one.onerror = () => {};
    one.onclose = (event) => {
      if (socket !== one) return;
      socket = undefined;
      welcomed = false;
      say(
        event.code === 4001
          ? `refused by ${want.url}: ${event.reason || "no reason given"}`
          : `disconnected from ${want.url} (${event.code}${event.reason ? `, ${event.reason}` : ""}), trying again`,
      );
      again();
    };
  }

  function again(): void {
    if (stopped) return;
    clearTimeout(timer);
    // With some jitter, so many runtimes coming back after the dashboard does do not
    // all knock at once.
    timer = setTimeout(connect, wait + Math.floor(Math.random() * wait * 0.5));
    timer.unref();
    wait = Math.min(wait * 2, backoff.most);
  }

  async function receive(one: Socket, text: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const kind = (message as { type?: unknown })?.type;

    if (kind === "welcome") {
      welcomed = true;
      wait = backoff.first;
      const said = (message as { workspace?: { name?: string; label?: string } }).workspace;
      say(`connected to ${using.url} as ${said?.label ?? said?.name ?? "a workspace"}`);
      if (settings.dashboard.remote.upload.runs) send(one, { type: "runs", runs: recentRuns() });
      return;
    }

    if (kind === "request") {
      const asked = Request.safeParse(message);
      if (!asked.success) return;
      const { id } = asked.data;
      const answer = await relay(asked.data);
      if (answer && socket === one) send(one, { type: "response", id, ...answer });
    }
  }

  /**
   * One request from the dashboard, made against this runtime's own port. Only the
   * headers in CARRIED come through, plus the secret that says it was relayed,
   * so a dashboard cannot hand over a cookie or a token it happens to hold.
   */
  function relay(asked: z.infer<typeof Request>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((done) => {
      const headers: Record<string, string> = {};
      for (const name of CARRIED) {
        const value = asked.headers[name];
        if (value) headers[name] = value;
      }
      headers[RELAY] = RELAY_SECRET;
      // So a run somebody started from the dashboard says so in the log,
      // rather than looking like another system holding a token.
      headers["x-chloe-channel"] = "dashboard";
      const body = asked.body === null ? undefined : Buffer.from(asked.body, "utf8");
      if (body && body.length > LARGEST) {
        return done({
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: Buffer.from(JSON.stringify({ error: "That is too large to send through the dashboard." })).toString("base64"),
        });
      }
      if (body) headers["content-length"] = String(body.length);

      const failed = (why: string) =>
        done({
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: Buffer.from(JSON.stringify({ error: `The runtime did not answer: ${why}` })).toString("base64"),
        });

      try {
        const sent = httpRequest(
          { host: self.hostname, port: self.port, method: asked.method, path: asked.path, headers },
          (response) => {
            const back: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined || KEPT_BACK.has(name)) continue;
              back[name] = Array.isArray(value) ? value.join(", ") : value;
            }
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", (error) => failed(error.message));
            response.on("end", () => {
              const whole = Buffer.concat(chunks);
              if (whole.length > LARGEST) {
                return failed(`that answer is ${Math.round(whole.length / 1e6)}MB, which is too large to send through the dashboard`);
              }
              done({ status: response.statusCode ?? 502, headers: back, body: whole.toString("base64") });
            });
          },
        );
        sent.on("error", (error) => failed(error.message));
        if (body) sent.write(body);
        sent.end();
      } catch (error) {
        // A path or a header Node's client will not send throws here, before
        // anything is on the wire. That must be a 502 and never a dead
        // process: the dashboard gets the answer it knows what to do with.
        return failed(`a path or a header could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  // A run's facts, and its words only when the owner said so. Sent with
  // nulls rather than left out, so a row sent again blanks the copy kept.
  function sent(): string {
    return settings.dashboard.remote.upload.replies ? `${SENT}, reply, summary` : `${SENT}, null as reply, null as summary`;
  }

  function recentRuns(): unknown[] {
    return db.prepare(`select ${sent()} from runs order by started desc limit ?`).all(CATCH_UP);
  }

  const onRun = (id: string): void => {
    if (!socket || !welcomed || !settings.dashboard.remote.upload.runs) return;
    const row = db.prepare(`select ${sent()} from runs where id = ?`).get(id);
    if (row) send(socket, { type: "run", run: row });
  };
  events.on("run", onRun);

  connect();

  return {
    reload() {
      const want = where();
      if (want.url !== using.url || want.key !== using.key) {
        const open = socket;
        socket = undefined;
        open?.close(1000, "settings changed");
        wait = backoff.first;
        return connect();
      }
      // The switches go with it, so what the dashboard shows about this
       // workspace follows a settings change without a reconnect. The
       // runtime enforces them from the live settings either way.
      if (socket && welcomed && settings.dashboard.remote.upload.agents) {
        send(socket, { type: "agents", agents: agentList(), upload: settings.dashboard.remote.upload, allow: settings.dashboard.remote.allow });
      }
    },
    connected: () => Boolean(socket) && welcomed,
    stop() {
      stopped = true;
      clearTimeout(timer);
      events.off("run", onRun);
      const open = socket;
      socket = undefined;
      open?.close(1000, "stopping");
    },
  };
}

/**
 * The version in this package's package.json, which is what the runtime
 * reports. The nearest one above this file, because it is a folder deeper when
 * the package is installed (dist/dashboard/) than when it is the source (dashboard/),
 * and reading only the folder above gives an installed copy nothing to report.
 */
function ownVersion(): string {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    try {
      const said = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { version?: string };
      if (said.version) return said.version;
    } catch {
      // Not a package folder. Try the one above.
    }
    const above = dirname(folder);
    if (above === folder) break;
    folder = above;
  }
  return "0";
}
