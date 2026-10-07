// The web channel: a chat box on a page, for strangers.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { tool } from "ai";
import { z } from "zod";

import { about, is } from "#chloe/ops/check";
import { agentFor, answers, asked, codeJob, lastAsked, lastTools, row } from "./shared.ts";

{
  about("the web channel");

  const { webChannel } = await import("#chloe/channels/web");
  const { serve } = await import("#chloe/serve/http");
  const { makeToken } = await import("#chloe/serve/tokens");
  const { deliver } = await import("#chloe/model/ask");

  const refusal = (make: () => unknown): string => {
    try {
      make();
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("it needs the sites that may show it", refusal(() => webChannel({ origins: [] })).includes("needs origins"), true);
  is("and a site is a scheme and a host, no path", refusal(() => webChannel({ origins: ["https://myshop.com/chat"] })).includes("no path"), true);

  let jobRan = false;
  const agent = agentFor(codeJob("nightly", async () => ((jobRan = true), {})));
  agent.tools = {
    readCv: tool({ title: "Reading the CV", description: "The CV.", inputSchema: z.object({}), execute: async () => "Meta, 2019 to 2024." }),
    secret: tool({ description: "Something private.", inputSchema: z.object({}), execute: async () => "private" }),
    memoryReadFile: tool({ description: "Its memory.", inputSchema: z.object({}), execute: async () => "notes" }),
  };
  const site = "https://myshop.com";
  const make = (options: Partial<Parameters<typeof webChannel>[0]> = {}) => {
    const channel = webChannel({ origins: [site], tools: ["readCv"], greeting: "Hi there.", ...options });
    agent.channels = [channel];
    return channel;
  };
  const channel = make();

  // Checked as the agent loads, so a mistake stops it there rather than in front of a visitor.
  is("naming a tool it has is fine", refusal(() => channel.check!(agent)), "");
  is("naming its memory is refused", refusal(() => webChannel({ origins: [site], tools: ["memoryReadFile"] }).check!(agent)).includes("not theirs"), true);
  is("a tool it does not have is said in the log and left out, like a connection that did not answer", refusal(() => webChannel({ origins: [site], tools: ["getOrders"] }).check!(agent)), "");

  const closed = { ...agentFor(codeJob("nightly", async () => ({}))), id: "closed" };
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", agent], ["closed", closed]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${at}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: site, ...headers }, body: JSON.stringify(body) });
  // The site's own server, with a token made for this agent and no other.
  const { secret } = makeToken("the site", "test");
  const server_ = (path: string, body: object, token = secret) =>
    fetch(`${at}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let visitors = 0;
  const passFor = async (visitor = `v-${++visitors}`, facts?: Record<string, string>) =>
    (await (await server_("/api/agents/test/web/pass", { visitor, facts })).json()) as { pass: string; visitor: string; greeting: string; error?: string };
  const events = (raw: string) =>
    raw
      .split("\n\n")
      .filter((block) => block.startsWith("event:"))
      .map((block) => {
        const [event, data] = block.split("\n");
        return { event: event.slice(7), data: JSON.parse(data.slice(6)) as Record<string, unknown> };
      });
  const turn = async (pass: string, text: string, headers: Record<string, string> = {}) => {
    const answer = await post("/api/agents/test/web/turn", { text }, { "x-chloe-pass": pass, ...headers });
    return { status: answer.status, events: answer.headers.get("content-type")?.startsWith("text/event-stream") ? events(await answer.text()) : [], body: answer.ok ? null : await answer.json() };
  };

  // A browser asks first, from another site, and is told yes only for the sites named.
  const ask = (origin: string) =>
    fetch(`${at}/api/agents/test/web/turn`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
  const yes = await ask(site);
  is("a page on a named site may call it", [yes.status, yes.headers.get("access-control-allow-origin")], [204, site]);
  is("and is told it may send its pass", yes.headers.get("access-control-allow-headers")?.includes("x-chloe-pass"), true);
  is("a page anywhere else may not", (await ask("https://elsewhere.com")).status, 403);

  const first = await passFor();
  is("the site's own server gets a pass for its visitor, and the greeting", [typeof first.pass, first.visitor, first.greeting], ["string", "v-1", "Hi there."]);
  is("a page asking by itself gets none", (await post("/api/agents/test/web/pass", { visitor: "v-9" })).status, 401);
  const { secret: wide } = makeToken("everything");
  is("nor does a token that is not this agent's own", (await server_("/api/agents/test/web/pass", { visitor: "v-9" }, wide)).status, 401);
  const { secret: theirs_ } = makeToken("the other one", "closed");
  is("nor one made for another agent", (await server_("/api/agents/test/web/pass", { visitor: "v-9" }, theirs_)).status, 403);
  is("and a token for one agent reaches nothing else", (await fetch(`${at}/api/agents`, { headers: { authorization: `Bearer ${secret}` } })).status, 403);
  is("asked again, the same visitor keeps their conversation", (await passFor("v-1")).visitor, "v-1");

  // One turn: the words as they are written, the tool it started, then the answer whole.
  answers.push({ content: "Let me look.", tool_calls: [{ id: "c1", type: "function", function: { name: "readCv", arguments: "{}" } }] });
  answers.push("He was at Meta from 2019.");
  const one = await turn(first.pass, "Where did he work?", { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Gecko/20100101 Firefox/131.0", "cf-ipcountry": "GB", "x-forwarded-for": "203.0.113.7" });
  const said = one.events;
  is("a turn answers as a stream", one.status, 200);
  is("of words as they are written, then the tool it started, then the answer", said.map((one) => one.event), ["working", "text", "text", "step", "text", "text", "done"]);
  is("the step says what it is doing", said.find((one) => one.event === "step")?.data, { tool: "readCv", text: "Reading the CV" });
  is("and the answer comes whole at the end", said.at(-1)?.data.text, "He was at Meta from 2019.");
  is("the model is offered the tools the channel names, and only those", lastTools, ["readCv"]);
  const run = row(said.at(-1)?.data.runId as string);
  is("the run says it came from the web, and which visitor", [run.source, run.owner], ["web", `web:${first.visitor}`]);
  const told = lastAsked.find((one) => one.content.includes("<web_context>"))?.content ?? "";
  is(
    "and the model was told who it was talking to: the site, when they came, their country and browser",
    ["visitor: v-1", `site: ${site}`, "first seen:", "country: GB", "browser: Firefox on macOS"].every((line) => told.includes(line)),
    true,
  );
  is("but never their address", told.includes("203.0.113.7"), false);
  const kept = (await (await fetch(`${at}/api/agents/test/web/visitors`, { headers: { authorization: `Bearer ${secret}` } })).json()) as { id: string; ip: string }[];
  is("which is kept for the owner", kept.find((one) => one.id === "v-1")?.ip, "203.0.113.7");

  const history = (await (await fetch(`${at}/api/agents/test/web/history`, { headers: { "x-chloe-pass": first.pass, origin: site } })).json()) as {
    messages: { role: string; text: string }[];
  };
  is(
    "the conversation is there for a page that reloads, without what the model was told about the visitor",
    history.messages.map((one) => one.text),
    ["Where did he work?", "Let me look.", "He was at Meta from 2019."],
  );

  // A visitor is a stranger: a slash is only text.
  const before = asked;
  answers.push("I cannot run anything.");
  await turn(first.pass, "/nightly");
  is("a visitor cannot start a job", [jobRan, asked - before], [false, 1]);
  const picking = asked;
  answers.push("No.");
  await turn(first.pass, "/model openai/gpt-5");
  is("nor pick the model", asked - picking, 1);

  // Nor finish a sign-in, or be sent one: a code a visitor pastes would sign
  // the agent in to the visitor's own account.
  let finished = false;
  let started = false;
  const google = {
    name: "google",
    does: "",
    settings: [],
    missing: async () => [],
    signIn: {
      start: async () => ((started = true), { say: "Sign in here.", link: "https://accounts.example" }),
      answers: (text: string) => text.startsWith("4/0"),
      finish: async () => ((finished = true), "Signed in."),
    },
  };
  const { NeedsSignIn } = await import("#chloe/connections/connection");
  agent.tools.readCv = Object.assign(
    tool({ title: "Reading the CV", description: "The CV.", inputSchema: z.object({}), execute: async (): Promise<string> => { throw new NeedsSignIn("google", "Google needs signing in again."); } }),
    { needs: google },
  );
  answers.push("That is not something I can use.");
  await turn(first.pass, "4/0AbCdEf");
  is("a visitor's code never finishes a sign-in", finished, false);
  answers.push({ content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "readCv", arguments: "{}" } }] });
  const needing = await turn(first.pass, "Where did he work?");
  is("and a tool that needs one never starts one for a visitor", [started, JSON.stringify(needing.events.at(-1)?.data).includes("accounts.example")], [false, false]);
  agent.tools.readCv = tool({ title: "Reading the CV", description: "The CV.", inputSchema: z.object({}), execute: async () => "Meta, 2019 to 2024." });

  // Threads never cross.
  const other = await passFor();
  is("a second visitor is somebody else", other.visitor === first.visitor, false);
  const theirs = (await (await fetch(`${at}/api/agents/test/web/history`, { headers: { "x-chloe-pass": other.pass, origin: site } })).json()) as { messages: unknown[] };
  is("with a conversation of their own", theirs.messages, []);
  is("a pass used from another site is refused", (await turn(first.pass, "hello", { origin: "https://elsewhere.com" })).status, 403);

  // A pass is only what it says.
  const key = Buffer.from(readFileSync(`${process.env.CHLOE_STATE}/web-pass.key`, "utf8"), "base64url");
  const forge = (pass: object) => {
    const body = Buffer.from(JSON.stringify(pass)).toString("base64url");
    return `${body}.${createHmac("sha256", key).update(`web-pass:${body}`).digest("base64url")}`;
  };
  const now = Math.floor(Date.now() / 1000);
  is("a pass that has run out is refused", (await turn(forge({ a: "test", o: site, v: "x", u: now - 1 }), "hello")).status, 401);
  is("and one for another agent", (await turn(forge({ a: "closed", o: site, v: "x", u: now + 60 }), "hello")).status, 403);
  is("and one somebody wrote themselves", (await turn(`${first.pass.split(".")[0]}.forged`, "hello")).status, 401);
  is("and none at all", (await turn("", "hello")).status, 401);

  // Forgetting is the visitor's own.
  await post("/api/agents/test/web/clear", {}, { "x-chloe-pass": first.pass });
  const cleared = (await (await fetch(`${at}/api/agents/test/web/history`, { headers: { "x-chloe-pass": first.pass, origin: site } })).json()) as { messages: unknown[] };
  is("a visitor can forget their conversation", cleared.messages, []);

  // A job that asks a visitor leaves the question in their conversation.
  const running = channel.start(() => agent);
  await deliver(`web:${other.visitor}`, "Which size?", "test", ["Small", "Large"]);
  const waiting = (await (await fetch(`${at}/api/agents/test/web/history`, { headers: { "x-chloe-pass": other.pass, origin: site } })).json()) as {
    messages: { text: string }[];
  };
  is("a job's question waits in the visitor's conversation", waiting.messages.map((one) => one.text), ["Which size?\n\n- Small\n- Large"]);
  running.stop();

  // What a visitor may spend, read off the run record.
  make({ limits: { perVisitor: { messages: 1 } } });
  const fresh = await passFor();
  answers.push("One.");
  is("a visitor under their limit is answered", (await turn(fresh.pass, "one")).status, 200);
  const over = await turn(fresh.pass, "two");
  is("and one over it is told, politely", [over.status, (over.body as { error: string }).error.includes("Come back tomorrow")], [429, true]);
  make({ limits: { perDay: { dollars: 0.0001 } } });
  is("everybody together has a limit too", (await turn((await passFor()).pass, "hello")).status, 429);

  // What the site knows about somebody, it says, and the agent is told.
  make();
  const vouched = await passFor("user-42", { name: "Ada <script>", plan: "pro" });
  answers.push("Hello Ada.");
  is("a pass with facts is used like any other", (await turn(vouched.pass, "hi")).status, 200);
  is("and the model is told them, as plain words", lastAsked.some((one) => one.content.includes("name: Ada script") && one.content.includes("plan: pro")), true);

  // A note per user, which only the runtime chooses.
  const { userNotesTools, userNotesFile } = await import("#chloe/model/tools/memory");
  agent.tools.memoryWriteUserNotes = userNotesTools()().memoryWriteUserNotes;
  answers.push({ content: "", tool_calls: [{ id: "n1", type: "function", function: { name: "memoryWriteUserNotes", arguments: JSON.stringify({ notes: "Asked about Meta." }) } }] });
  answers.push("Noted.");
  await turn(vouched.pass, "remember I asked about Meta");
  is("a visitor's turn has the note tool without the channel naming it", lastTools.includes("memoryWriteUserNotes"), true);
  is("and the note is kept as theirs, on the web", existsSync(userNotesFile(agent.memory.folder, "web:user-42")), true);
  answers.push("Yes.");
  await turn(vouched.pass, "do you remember?");
  is("the next turn starts out with what it noted", lastAsked[0].content.includes("## Your note on them\n\nAsked about Meta."), true);
  answers.push("No notes.");
  await turn(first.pass, "and me?");
  is("which no other visitor is shown", lastAsked.some((one) => one.content.includes("Asked about Meta")), false);

  // The same on any channel: a note per person, as that channel names them.
  const { receive } = await import("#chloe/channels/shared");
  const fromTelegram = (text: string) => receive(agent, { channel: "telegram", chat: "42", thread: "test/telegram-42", from: { id: "42", name: "Jenny" }, text, private: true });
  answers.push({ content: "", tool_calls: [{ id: "n2", type: "function", function: { name: "memoryWriteUserNotes", arguments: JSON.stringify({ notes: "Likes short answers." }) } }] });
  answers.push("Noted.");
  await fromTelegram("keep it short from now on");
  answers.push("Sure.");
  await fromTelegram("what do I like?");
  is("somebody on another channel has a note of their own", lastAsked[0].content.includes("Likes short answers.") && !lastAsked[0].content.includes("Asked about Meta"), true);
  delete agent.tools.memoryWriteUserNotes;

  is("the chat box is served for a page to load", (await fetch(`${at}/api/web/chat.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  const usage = (await (await fetch(`${at}/api/agents/test/web`, { headers: { authorization: `Bearer ${secret}` } })).json()) as { lastDay: { visitors: number } };
  is("its owner sees how many visitors the last day had", usage.lastDay.visitors >= 3, true);
  const { channelsOf } = await import("#chloe/serve/inside");
  is("and the channel says so where the agent's ways in are listed", channelsOf(agent)[0].does.includes("The last 24 hours:"), true);
  const { db } = await import("#chloe/core/db");
  const named = db.prepare("select label from threads where thread = ?").get(`test/visitor-${vouched.visitor}`) as { label: string };
  is("a visitor's conversation is named for who and where", named.label, "Ada script, myshop.com");

  server.close();
}
