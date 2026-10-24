// The Discord channel.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, db, row, work } from "#chloe/ops/test/shared";

{
  about("discord");
  const { listen } = await import("./discord.ts");

  // A stand-in Discord: its API over HTTP, and a gateway that says hello,
  // is ready when told who the bot is, and hands over messages. Everything
  // the bot sends either way is written down.
  const calls: { method: string; path: string; body: any }[] = [];
  const sent: { op: number; d: any }[] = [];
  let socket: Duplex | undefined;
  let sequence = 0;
  const frame = (text: string) => {
    const data = Buffer.from(text);
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    return Buffer.concat([head, data]);
  };
  const packet = (op: number, d: unknown, t?: string) => socket!.write(frame(JSON.stringify({ op, d, s: t ? ++sequence : null, t: t ?? null })));
  const discord = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url!.replace(/^\/api/, "");
      const body = raw && request.headers["content-type"]?.startsWith("application/json") ? JSON.parse(raw) : raw;
      calls.push({ method: request.method!, path, body });
      const port = (discord.address() as { port: number }).port;
      if (path.endsWith("/typing") || path.includes("/interactions/")) return void response.writeHead(204).end();
      const result =
        path === "/gateway/bot" ? { url: `ws://127.0.0.1:${port}` }
        : path === "/users/@me/channels" ? { id: `dm-${body.recipient_id}` }
        : request.method === "GET" && path.startsWith("/channels/") ? { name: "general" }
        : { id: "m" };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
  discord.on("upgrade", (request, sock) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket = sock;
    let buffered = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      // Frames from a client are masked, and none of these is over 64 KB.
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        const short = buffered[1] & 127;
        const at = short === 126 ? 4 : 2;
        const length = short === 126 ? buffered.readUInt16BE(2) : short;
        if (buffered.length < at + 4 + length) break;
        const mask = buffered.subarray(at, at + 4);
        const data = Buffer.from(buffered.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffered = buffered.subarray(at + 4 + length);
        if (opcode === 8) return void sock.end(Buffer.from([0x88, 0]));
        const said = JSON.parse(data.toString());
        sent.push(said);
        if (said.op === 2) packet(0, { user: { id: "100", username: "bot" }, session_id: "s1", resume_gateway_url: `ws://127.0.0.1:${(discord.address() as { port: number }).port}` }, "READY");
        if (said.op === 6) packet(0, {}, "RESUMED");
      }
    });
    sock.on("error", () => {});
    packet(10, { heartbeat_interval: 60_000 });
  });
  await new Promise<void>((done) => discord.listen(0, "127.0.0.1", done));
  const api = `http://127.0.0.1:${(discord.address() as { port: number }).port}/api`;
  const said = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).map((c) => `${c.path.split("/")[2]}: ${c.body.content}`);
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await pause(20);
    await pause(50);
  };
  const ready = () => until(() => sent.some((one) => one.op === 2 || one.op === 6));
  const settle = (count: number) => until(() => said().length >= count);
  let ids = 0;
  const message = (author: string, content: string, more: object = {}) =>
    packet(0, { id: `${++ids}`, type: 0, channel_id: "dm-room", author: { id: author, username: author === "700" ? "me" : "stranger" }, content, mentions: [], ...more }, "MESSAGE_CREATE");
  const inServer = (author: string, content: string, more: object = {}) => message(author, content, { channel_id: "general-room", guild_id: "g1", ...more });

  const agent = agentFor(codeJob("unused", async () => ({})));

  const first = listen({ agentId: "test", token: "t", api, agent: () => agent });
  await ready();
  message("900", "hi");
  await settle(1);
  first.stop();
  await pause(50);
  const identify = sent.find((one) => one.op === 2);
  is("it says who it is with the bot token", identify?.d.token, "t");
  is("and asks for direct messages, server messages and what they say", (identify?.d.intents & (1 << 9)) && (identify?.d.intents & (1 << 12)) && (identify?.d.intents & (1 << 15)) ? true : false, true);
  is("with nobody allowed yet, a direct message is told its user id", said()[0]?.startsWith("dm-room: Your Discord user id is 900."), true);

  calls.length = 0;
  sent.length = 0;
  socket = undefined;
  answers.push("hello from the agent", "seen in the server", "seen in the reply");
  const second = listen({ agentId: "test", token: "t", api, allowFrom: ["700"], agent: () => agent });
  await ready();
  message("900", "let me in");
  message("700", "hi");
  await settle(1);
  inServer("700", "just chatting");
  inServer("700", "<@100> what now", { mentions: [{ id: "100" }] });
  await settle(2);
  // The same message again, as a connection taken up again can hand over.
  packet(0, { id: `${ids}`, type: 0, channel_id: "general-room", guild_id: "g1", author: { id: "700" }, content: "<@100> what now", mentions: [{ id: "100" }] }, "MESSAGE_CREATE");
  inServer("700", "and this?", { type: 19, referenced_message: { author: { id: "100" }, content: "seen in the server" } });
  await settle(3);
  is(
    "an allowed user is answered in a direct message, in a server when the bot is mentioned or replied to, and a stranger by nobody",
    said(),
    ["dm-room: hello from the agent", "general-room: seen in the server", "general-room: seen in the reply"],
  );
  is("a message handed over twice is answered once", said().length, 3);
  const posted = calls.filter((c) => c.path.endsWith("/messages"));
  is("nothing it sends pings anybody", posted.every((c) => c.body.allowed_mentions?.parse?.length === 0), true);
  is("in a server it answers as a reply to the message", posted[1]?.body.message_reference?.message_id, "5");
  const turns = db.prepare("select prompt from runs where source = 'discord' order by started").all() as { prompt: string }[];
  is("the agent is told where the message came from", turns.at(-1)?.prompt.includes("<discord_context>"), true);
  is("and is not shown its own mention", turns.some((t) => t.prompt.includes("<@100>")), false);
  is("while it works, the chat shows it typing", calls.some((c) => c.path === "/channels/dm-room/typing"), true);

  // Discord asks for a new connection, and the next one takes the session up again.
  const reached = sequence;
  packet(7, null);
  await until(() => sent.some((one) => one.op === 6));
  second.stop();
  await pause(50);
  is("a new connection takes the last one up, from where it got to", [sent.find((one) => one.op === 6)?.d.session_id, sent.find((one) => one.op === 6)?.d.seq], ["s1", reached]);

  // A job's question with answers that can be listed arrives as buttons, and a press answers it.
  calls.length = 0;
  sent.length = 0;
  socket = undefined;
  const asking = codeJob("buttons", async ({ ask }) => ({ go: await ask("go?", { question: "Go?", answer: z.boolean(), who: "discord:700" }) }));
  const withJob = agentFor(asking);
  const third = listen({ agentId: "test", token: "t", api, allowFrom: ["700"], agent: () => withJob });
  await ready();
  const parked = await work({ agent: withJob, job: asking });
  const question = calls.find((c) => c.path.endsWith("/messages"));
  is("a question goes to the person's direct message", question?.path, "/channels/dm-700/messages");
  const buttons = question?.body.components?.[0]?.components ?? [];
  is("a yes or no question comes with two buttons", buttons.map((b: { label: string }) => b.label), ["yes", "no"]);
  packet(
    0,
    { id: "i1", token: "it", type: 3, channel_id: "dm-700", user: { id: "700" }, message: { id: "q", channel_id: "dm-700", content: "Go?", author: { id: "100" }, components: question?.body.components }, data: { custom_id: buttons[0]?.custom_id } },
    "INTERACTION_CREATE",
  );
  await until(() => !!row(parked.runId).reply);
  third.stop();
  await pause(50);
  is("pressing one answers the job", JSON.parse(row(parked.runId).reply), { go: true });
  const callback = calls.find((c) => c.path.includes("/interactions/"));
  is("and the buttons are taken away, saying what was chosen", [callback?.body.type, callback?.body.data?.content, callback?.body.data?.components], [7, "Go?\n\n→ yes", []]);

  // A question that takes several answers is a menu that takes several.
  calls.length = 0;
  sent.length = 0;
  socket = undefined;
  const several = codeJob("ticks", async ({ ask }) => ({ picked: await ask("which?", { question: "Which?", answer: z.array(z.enum(["cheese", "ham"])), who: "discord:700" }) }));
  const withTicks = agentFor(several);
  const boxed = listen({ agentId: "test", token: "t", api, allowFrom: ["700"], agent: () => withTicks });
  await ready();
  const toppings = await work({ agent: withTicks, job: several });
  const asked = calls.find((c) => c.path.endsWith("/messages"));
  const menu = asked?.body.components?.[0]?.components?.[0];
  is("each answer is in one menu, and any number may be picked", [menu?.type, menu?.options?.map((o: { value: string }) => o.value), menu?.max_values], [3, ["cheese", "ham"], 2]);
  packet(
    0,
    { id: "i2", token: "it", type: 3, channel_id: "dm-700", user: { id: "700" }, message: { id: "q2", channel_id: "dm-700", content: "Which?", author: { id: "100" }, components: asked?.body.components }, data: { custom_id: "m", values: ["cheese", "ham"] } },
    "INTERACTION_CREATE",
  );
  await until(() => !!row(toppings.runId).reply);
  boxed.stop();
  await pause(50);
  is("closing it answers with every one picked", JSON.parse(row(toppings.runId).reply), { picked: ["cheese", "ham"] });
  discord.close();
  discord.closeAllConnections();
}
