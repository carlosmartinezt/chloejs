// The Slack channel.

import { createServer } from "node:http";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import { agentFor, answer, answers, codeJob, db, row, work } from "./shared.ts";

{
  about("slack");
  const { listen } = await import("#chloe/channels/slack");
  const { createHash } = await import("node:crypto");

  // A stand-in Slack: its web methods over HTTP, and one socket that hands
  // chloe envelopes. Everything the bot sends and acknowledges is written down.
  const calls: { method: string; body: any }[] = [];
  const acked: string[] = [];
  let socket: import("node:stream").Duplex | undefined;
  const frame = (text: string) => {
    const data = Buffer.from(text);
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    return Buffer.concat([head, data]);
  };
  const slack = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const method = request.url!.split("/").pop()!;
      const body = request.headers["content-type"]?.startsWith("application/json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      const port = (slack.address() as { port: number }).port;
      const result =
        method === "auth.test" ? { user_id: "UBOT" }
        : method === "apps.connections.open" ? { url: `ws://127.0.0.1:${port}/socket` }
        : method === "users.info" ? { user: { name: body.user === "U7" ? "me" : "stranger" } }
        : method === "conversations.info" ? { channel: { name: "friends" } }
        : {};
      response.end(JSON.stringify({ ok: true, ...result }));
    });
  });
  slack.on("upgrade", (request, sock) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket = sock;
    let buffered = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      // Frames from a client are masked, and these are all short.
      while (buffered.length >= 6) {
        const opcode = buffered[0] & 15;
        const length = buffered[1] & 127;
        if (buffered.length < 6 + length) break;
        const mask = buffered.subarray(2, 6);
        const data = Buffer.from(buffered.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]));
        buffered = buffered.subarray(6 + length);
        if (opcode === 8) return void sock.end(Buffer.from([0x88, 0]));
        acked.push(JSON.parse(data.toString()).envelope_id);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((done) => slack.listen(0, "127.0.0.1", done));
  const api = `http://127.0.0.1:${(slack.address() as { port: number }).port}`;
  const said = () => calls.filter((c) => c.method === "chat.postMessage").map((c) => `${c.body.channel}${c.body.thread_ts ? `/${c.body.thread_ts}` : ""}: ${c.body.text}`);
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await pause(20);
    await pause(50);
  };
  const settle = (count: number) => until(() => said().length >= count);
  let envelopes = 0;
  const push = (type: string, payload: object) => socket!.write(frame(JSON.stringify({ envelope_id: `e${++envelopes}`, type, payload })));
  const event = (event: object) => push("events_api", { event });
  const direct = (user: string, text: string, ts: string) => event({ type: "message", channel: "D1", channel_type: "im", user, text, ts });
  const inChannel = (user: string, text: string, ts: string, more: object = {}) => event({ type: "message", channel: "C1", channel_type: "channel", user, text, ts, ...more });

  const agent = agentFor(codeJob("unused", async () => ({})));

  const first = listen({ agentId: "test", token: "b", appToken: "a", api, agent: () => agent });
  await until(() => !!socket);
  direct("U9", "hi", "1.1");
  await settle(1);
  first.stop();
  await pause(50);
  is("it opens its connection with the app token", calls.some((c) => c.method === "apps.connections.open"), true);
  is("with nobody allowed yet, a direct message is told its member id", said()[0]?.startsWith("D1: Your Slack user id is U9."), true);
  is("every envelope is acknowledged, or Slack sends it again", acked, ["e1"]);

  calls.length = 0;
  socket = undefined;
  answers.push("hello from the agent", "seen in the channel", "in the thread");
  const second = listen({ agentId: "test", token: "b", appToken: "a", api, allowFrom: ["U7"], agent: () => agent });
  await until(() => !!socket);
  direct("U9", "let me in", "2.1");
  direct("U7", "hi", "2.2");
  await settle(1);
  inChannel("U7", "just chatting", "2.3");
  inChannel("U7", "<@UBOT> what now", "2.4");
  // The same mention, as Slack also sends it.
  event({ type: "app_mention", channel: "C1", channel_type: "channel", user: "U7", text: "<@UBOT> what now", ts: "2.4" });
  await settle(2);
  inChannel("U7", "and this?", "2.6", { thread_ts: "2.5", parent_user_id: "UBOT" });
  await settle(3);
  second.stop();
  await pause(50);
  is(
    "an allowed user is answered in a direct message, in a channel that mentions the bot, and in the bot's thread, and a stranger by nobody",
    said(),
    ["D1: hello from the agent", "C1: seen in the channel", "C1/2.5: in the thread"],
  );
  is("a message Slack sends twice is answered once", said().length, 3);
  const turns = db.prepare("select prompt from runs where source = 'slack' order by started").all() as { prompt: string }[];
  is("the agent is told where the message came from", turns.at(-1)?.prompt.includes("<slack_context>"), true);
  is("and is not shown its own mention", turns.some((t) => t.prompt.includes("<@UBOT>")), false);
  is("while it works, the message is marked", calls.some((c) => c.method === "reactions.add" && c.body.timestamp === "2.2"), true);

  // A job's question with answers that can be listed arrives as buttons, and a press answers it.
  calls.length = 0;
  socket = undefined;
  const asking = codeJob("buttons", async ({ ask }) => ({ go: await ask("go?", { question: "Go?", answer: z.boolean(), who: "slack:U7" }) }));
  const withJob = agentFor(asking);
  const third = listen({ agentId: "test", token: "b", appToken: "a", api, allowFrom: ["U7"], agent: () => withJob });
  await until(() => !!socket);
  const parked = await work({ agent: withJob, job: asking });
  const question = calls.find((c) => c.method === "chat.postMessage");
  is("a question goes to the person's direct message", question?.body.channel, "U7");
  is("a yes or no question comes with two buttons", question?.body.blocks?.[1]?.elements?.map((b: { value: string }) => b.value), ["yes", "no"]);
  push("interactive", { type: "block_actions", user: { id: "U7" }, channel: { id: "D1" }, message: { ts: "3.1", text: "Go?" }, actions: [{ value: "yes" }] });
  await until(() => calls.some((c) => c.method === "chat.update"));
  third.stop();
  await pause(50);
  is("pressing one answers the job", JSON.parse(row(parked.runId).reply), { go: true });
  is("and the buttons are taken away", calls.find((c) => c.method === "chat.update")?.body.text, "Go?\n\n→ yes");

  // A slash command runs the job it names, and is answered where it was typed.
  calls.length = 0;
  socket = undefined;
  const { startClock } = await import("#chloe/core/clock");
  const handed: string[] = [];
  const noted = codeJob("note-it", async ({ input }) => (handed.push(input.text), { ok: true }), undefined, () => "Noted.");
  delete noted.cron;
  const noter = agentFor(noted);
  const ticking = startClock(() => new Map([["test", noter]]));
  const replies: string[] = [];
  const hook = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => (replies.push(JSON.parse(raw).text), response.end()));
  });
  await new Promise<void>((done) => hook.listen(0, "127.0.0.1", done));
  const fourth = listen({ agentId: "test", token: "b", appToken: "a", api, allowFrom: ["U7"], agent: () => noter });
  await until(() => !!socket);
  push("slash_commands", { command: "/note_it", text: "buy milk", user_id: "U7", channel_id: "C1", response_url: `http://127.0.0.1:${(hook.address() as { port: number }).port}/` });
  await until(() => replies.length > 0);
  fourth.stop();
  ticking.stop();
  hook.close();
  is("a slash command runs the job it names, with the rest as its text", handed, ["buy milk"]);
  is("and is answered where it was typed", replies, ["Noted."]);
  slack.close();
  slack.closeAllConnections();
}
