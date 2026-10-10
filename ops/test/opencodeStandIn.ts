// A stand-in for the opencode command, for ops/test/routes.ts, so no case ever
// reaches somebody's opencode account. `models` lists two models. `serve
// --stdio` answers the part of opencode 2's API the opencode route uses: it
// starts the tool server the folder's config names and asks it what it lists,
// as opencode does, and answers a prompt with the events the session's model
// asks for. Everything it is sent goes into the file named first, one JSON line
// each. Run as its own program: `node opencodeStandIn.ts <log> <command...>`.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";

const [log, command, ...rest] = process.argv.slice(2);
const note = (what: string, detail: Record<string, unknown> = {}) => appendFileSync(log, `${JSON.stringify({ what, ...detail })}\n`);

if (command === "models") {
  console.log("deepseek/deepseek-v4-pro\nopenai/gpt-5.5");
  process.exit(0);
}
if (command !== "serve" || !rest.includes("--stdio")) {
  console.error("This stand-in answers models and serve --stdio, and nothing else.");
  process.exit(2);
}

const config = JSON.parse(readFileSync("opencode.json", "utf8"));
note("config", { config, cwd: process.cwd(), pwd: process.env.PWD });
const password = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`;

// The tool server, started and asked as opencode starts and asks it.
let listed: string[] | undefined;
let tools: ChildProcess | undefined;
function startTools(): void {
  const server = config.mcp?.servers?.chloe;
  if (!server || tools) return;
  const [program, ...args] = server.command as string[];
  tools = spawn(program, args, { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: tools.stdout! }).on("line", (line) => {
    const answer = JSON.parse(line);
    if (answer.id !== 2) return;
    listed = answer.result.tools.map((one: { name: string }) => one.name);
    note("listed", { tools: listed });
  });
  for (const asked of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]) {
    tools.stdin!.write(`${JSON.stringify(asked)}\n`);
  }
}

const streams: ServerResponse[] = [];
const send = (type: string, data: Record<string, unknown>) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ id: `evt_${Date.now()}`, type, data })}\n\n`);
};
const ours = "ses_standin";
let model = "";
let interrupted = false;

/** What each model answers a prompt with, one event at a time. */
function answer(): void {
  const mine = { sessionID: ours, assistantMessageID: "msg_1" };
  send("session.execution.started", { sessionID: ours });
  send("session.step.started", { ...mine, agent: "chloe" });
  if (model === "words") {
    send("session.text.ended", { ...mine, ordinal: 0, text: "Five." });
    send("session.step.ended", { ...mine, finish: "stop", cost: 0.004, tokens: { input: 58, output: 5 } });
    send("session.execution.succeeded", { sessionID: ours });
  }
  if (model === "calls") {
    send("session.text.ended", { ...mine, ordinal: 0, text: "Looking." });
    send("session.text.ended", { sessionID: "ses_other", assistantMessageID: "msg_9", ordinal: 0, text: "Not mine." });
    send("session.tool.input.started", { ...mine, id: "c1", name: "chloe_gmailReadEmail" });
    send("session.tool.called", { ...mine, id: "c1", input: { days: 7 }, executed: false });
    send("session.tool.input.started", { ...mine, id: "c2", name: "shell" });
    send("session.tool.called", { ...mine, id: "c2", input: { command: "ls" }, executed: false });
    send("session.tool.input.started", { ...mine, id: "c3", name: "chloe_gmailReadEmail" });
    send("session.tool.called", { ...mine, id: "c3", input: { days: 7 }, executed: false });
    send("session.step.streamed", mine);
    send("permission.asked", { id: "per_1", sessionID: ours, action: "chloe_gmailReadEmail", resources: ["*"], source: { type: "tool", id: "c1" } });
    send("permission.asked", { id: "per_2", sessionID: ours, action: "chloe_gmailReadEmail", resources: ["*"], source: { type: "tool", id: "c3" } });
  }
  if (model === "stray") {
    send("session.text.ended", { ...mine, ordinal: 0, text: "Hm." });
    send("session.tool.input.started", { ...mine, id: "c1", name: "shell" });
    send("session.tool.called", { ...mine, id: "c1", input: {}, executed: false });
    send("session.tool.failed", { ...mine, id: "c1", error: { type: "tool.execution", message: 'No tool named "shell" is currently available.' } });
    send("session.step.ended", { ...mine, finish: "tool-calls", cost: 0.001, tokens: { input: 40, output: 3 } });
    // What opencode does next when nothing stops it: asks the model again.
    setTimeout(() => {
      if (interrupted) return;
      send("session.step.started", { sessionID: ours, assistantMessageID: "msg_2", agent: "chloe" });
      send("session.text.ended", { sessionID: ours, assistantMessageID: "msg_2", ordinal: 0, text: "Asked again." });
      send("session.step.ended", { sessionID: ours, assistantMessageID: "msg_2", finish: "stop", cost: 0.001, tokens: { input: 40, output: 3 } });
      send("session.execution.succeeded", { sessionID: ours });
    }, 300);
  }
  if (model === "limit") {
    send("session.step.failed", { ...mine, error: { type: "provider.quota", message: "You have hit your usage limit", status: 429 } });
    send("session.execution.failed", { sessionID: ours, error: { type: "provider.quota", message: "You have hit your usage limit", status: 429 } });
  }
  if (model === "missing") {
    send("session.execution.failed", { sessionID: ours, error: { type: "provider.no-route", message: "Model unavailable: opencode-go/missing" } });
  }
}

const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const path = request.url ?? "";
    note("asked", { method: request.method, path, body, listed: Boolean(listed) });
    const reply = (status: number, value?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (request.headers.authorization !== password) return reply(401, { _tag: "UnauthorizedError" });
    if (request.method === "GET" && path === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n: heartbeat\n\n`);
      streams.push(response);
      return;
    }
    if (request.method === "GET" && path.startsWith("/api/mcp?")) {
      startTools();
      const status = listed ? "connected" : "pending";
      return reply(200, { location: { directory: process.cwd() }, data: tools ? [{ name: "chloe", status: { status } }] : [] });
    }
    if (request.method === "POST" && path === "/api/session") {
      model = body.model.id;
      return reply(200, { data: { id: ours, agent: body.agent, model: body.model } });
    }
    if (request.method === "POST" && path === `/api/session/${ours}/prompt`) {
      reply(200, { data: { id: "msg_0", sessionID: ours, type: "user" } });
      setTimeout(answer, 20);
      return;
    }
    if (request.method === "POST" && path.startsWith(`/api/session/${ours}/permission/`)) {
      if (path.includes("per_2")) return reply(404, { _tag: "PermissionNotFoundError" });
      reply(204);
      const mine = { sessionID: ours, assistantMessageID: "msg_1" };
      if (body.decision === "reject" && !body.message) {
        send("permission.replied", { sessionID: ours, requestID: "per_1", reply: "reject" });
        send("session.tool.failed", { ...mine, id: "c1", error: { type: "aborted", message: "The user declined this tool call" } });
        send("session.step.failed", { ...mine, error: { type: "aborted", message: "Step interrupted" }, cost: 0.002, tokens: { input: 50, output: 7 } });
        send("session.execution.interrupted", { sessionID: ours, reason: "shutdown" });
      } else {
        // A refusal with a message, or a yes, is one opencode carries on from.
        send("session.step.ended", { ...mine, finish: "tool-calls", cost: 0.002, tokens: { input: 50, output: 7 } });
      }
      return;
    }
    if (request.method === "POST" && path === `/api/session/${ours}/interrupt`) {
      interrupted = true;
      return reply(200, { interrupted: true });
    }
    if (request.method === "DELETE" && path === `/api/session/${ours}`) return reply(204);
    reply(404, { _tag: "NotFound" });
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
});

// As opencode does with --stdio: it stops when its input closes.
process.stdin.resume();
process.stdin.on("end", () => {
  note("stopped");
  tools?.kill();
  process.exit(0);
});
