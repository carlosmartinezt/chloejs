// The connection out to a dashboard.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { about, is } from "#chloe/ops/check";
import type { Agent, Job } from "./shared.ts";
import { agentFor, answer, answers, asked, codeJob, db, lastAsked, live, ownPage, sent, work } from "./shared.ts";

{
  about("the connection to a dashboard");

  const { serve } = await import("#chloe/serve/http");
  const { startDashboard } = await import("#chloe/dashboard/connect");
  type Socket = import("#chloe/dashboard/connect").Socket;
  const { settings: live } = await import("#chloe/core/settings");
  const { readFile: get } = await import("node:fs/promises");

  // A runtime to relay to, with one agent whose memory holds one file.
  const folder = `${process.env.CHLOE_STATE}/memory-through-dashboard`;
  await mkdir(folder, { recursive: true });
  await writeFile(`${folder}/note.md`, "# Kept\n");
  await writeFile(`${folder}/note.html`, '<!doctype html><link rel="stylesheet" href="/static/style.css">\n');
  const keeper: Agent = { ...agentFor(codeJob("relayed", async () => "done")), memory: { folder } };
  ownPage(true);
  const cameIn: string[] = [];
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", keeper]]),
    clock: {
      fire(_a: Agent, _j: Job, _input?: unknown, channel?: string) {
        cameIn.push(channel ?? "");
        return Promise.resolve(undefined);
      },
      running: () => [],
    } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // A dashboard that is a fake socket: what the runtime sends is kept, and the
  // case plays the dashboard's side by calling the handlers the runtime set.
  const opened: { address: string; socket: Socket; sent: any[] }[] = [];
  const fake = (address: string): Socket => {
    const socket: Socket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (text: string) => void opened.at(-1)!.sent.push(JSON.parse(text)),
      close: (code = 1000, reason = "") => void setTimeout(() => socket.onclose?.({ code, reason })),
    };
    opened.push({ address, socket, sent: [] });
    return socket;
  };
  const last = () => opened.at(-1)!;
  const tick = () => new Promise<void>((done) => setTimeout(done, 20));
  const said = (type: string) => last().sent.filter((one) => one.type === type);
  const answer = async (id: string, method: "GET" | "POST", path: string, headers: Record<string, string> = {}, body: string | null = null) => {
    last().socket.onmessage?.({ data: JSON.stringify({ type: "request", id, method, path, headers: { accept: "application/json", "x-forwarded-for": "203.0.113.5", "x-chloe-relay-user": "someone@example.com", ...headers }, body }) });
    for (let waited = 0; waited < 100; waited++) {
      const found = said("response").find((one) => one.id === id);
      if (found) return { ...found, text: Buffer.from(found.body, "base64").toString("utf8") };
      await tick();
    }
    throw new Error(`no response to ${id}`);
  };
  /** The same request straight at the port, carrying no relay secret. */
  const direct = async (method: string, path: string, headers: Record<string, string> = {}) =>
    await (await fetch(`${at}${path}`, { method, headers })).text();

  // Set rather than assumed: this suite runs from whichever repo installed the
  // runtime, and that repo's config may well name a dashboard of its own.
  live.dashboard.remote.url = "";
  live.dashboard.remote.sync = { runs: true, agents: true };
  live.dashboard.remote.allow = { read: true, chat: true, run: true, memory: false, write: false, google: false };

  // Nothing named: nothing opened.
  live.dashboard.remote.api_key = "";
  const idle = startDashboard({ agents: () => new Map([["test", keeper]]), self: at, socket: fake, backoff: { first: 10, most: 20 } });
  await tick();
  is("with no key nothing is opened", opened.length, 0);
  idle.stop();

  // Both are settings, so both are set as settings. The key's value is still
  // the box's: a config names CHLOE_DASHBOARD_REMOTE_API_KEY rather than holding the key.
  live.dashboard.remote.url = "https://remote.example/";
  live.dashboard.remote.api_key = "chl_install_test";
  const dashboard = startDashboard({ agents: () => new Map([["test", keeper]]), self: at, socket: fake, backoff: { first: 10, most: 20 }, version: "9.9.9" });
  await tick();
  is("the address is the dashboard's, on /connect, over a socket", last().address, "wss://remote.example/connect");
  last().socket.onopen?.({});
  const hello = said("hello")[0];
  is("the first message says hello, with the key inside it", [hello?.type, hello?.key, hello?.protocol, hello?.coreVersion], ["hello", "chl_install_test", 1, "9.9.9"]);
  is("and says which machine it is on", hello?.machine, hostname());
  is("and carries the agents and the routes", [hello?.agents?.[0]?.id, hello?.routes?.some((one: { path: string }) => one.path === "/api/agents")], ["test", true]);
  is("and which switches are on", hello?.allow, { read: true, chat: true, run: true, memory: false, write: false, google: false });
  is("nothing else until the dashboard answers", dashboard.connected(), false);

  last().socket.onmessage?.({ data: JSON.stringify({ type: "welcome", workspace: { name: "here", label: "Here" } }) });
  await tick();
  is("welcome makes it connected", dashboard.connected(), true);
  is("and the last runs go up in one message", said("runs").length, 1);

  // A run's row goes up as it starts and as it ends.
  const before = said("run").length;
  await work({ agent: keeper, job: keeper.jobs[0] });
  await tick();
  const rows = said("run").slice(before);
  is("a run is sent when it starts and when it ends", rows.length, 2);
  is("as the row GET /api/runs would show", [rows[0].run.agent, rows[0].run.finished, typeof rows[1].run.finished], ["test", null, "string"]);

  // A request down the socket is a request to the runtime's own port.
  const agents = await answer("1", "GET", "/api/agents");
  is("a relayed read is answered", [agents.status, JSON.parse(agents.text)[0]?.id], [200, "test"]);
  is("with the runtime's own headers, less the ones the socket owns", [agents.headers["content-type"]?.startsWith("application/json"), "set-cookie" in agents.headers, "content-length" in agents.headers], [true, false, false]);
  const list = await answer("2", "GET", "/api");
  is("the route list is answered, with each route's switch on it", JSON.parse(list.text).find((one: { path: string }) => one.path === "/api/agents/:id/memory")?.allow, "memory");

  // What is never relayed, and what a switched-off switch refuses.
  is("the way in is not answered through the dashboard", (await answer("3", "GET", "/api/account")).status, 403);
  is("nor are the tokens", (await answer("4", "GET", "/api/tokens")).status, 403);
  const shut = await answer("5", "GET", "/api/agents/test/memory");
  is("a memory is refused while its switch is off", [shut.status, JSON.parse(shut.text).error.includes("memory")], [403, true]);
  is("and so is a write", (await answer("6", "POST", "/api/agents/test/memory/file", { "content-type": "application/json" }, JSON.stringify({ path: "x.md", content: "" }))).status, 403);
  is("a session cannot be minted through it either", (await answer("7", "POST", "/api/login", { "content-type": "application/json" }, JSON.stringify({ password: "a long enough one" }))).status, 403);

  live.dashboard.remote.allow.memory = true;
  const tree = await answer("8", "GET", "/api/agents/test/memory");
  const named = (JSON.parse(tree.text) as { name: string }[]).map((one) => one.name).sort();
  is("switched on, the memory is answered", [tree.status, named], [200, ["note.html", "note.md"]]);
  const log = await get(`${process.env.CHLOE_STATE}/memory-audit/test.jsonl`, "utf8");
  is("and the audit log says who it was, through the dashboard", log.includes('"from":"203.0.113.5 via dashboard as someone@example.com"'), true);
  is("a write still needs its own switch", (await answer("9", "POST", "/api/agents/test/memory/file", { "content-type": "application/json" }, JSON.stringify({ path: "x.md", content: "" }))).status, 403);
  const pass = JSON.parse((await answer("10", "GET", "/api/agents/test/memory/pass")).text) as { at: string };
  const framed = await answer("11", "GET", `${pass.at}/note.md`, { host: "dashboard.example", "x-forwarded-proto": "https" });
  is("a memory file for the frame comes through too", [framed.status, framed.text], [200, "# Kept\n"]);
  is("with its policy naming the host the dashboard said", framed.headers["content-security-policy"]?.includes("https://dashboard.example"), true);
  // A note's own root-relative links have to come back at the address the
  // browser is at, which through a dashboard is under that workspace.
  const under = { host: "dashboard.example", "x-forwarded-proto": "https", "x-chloe-relay-under": "/workspaces/the-box" };
  const page = await answer("11b", "GET", `${pass.at}/note.html`, under);
  is("and a note's own links start where the browser is, not at the root of the dashboard", page.text.includes(`href="/workspaces/the-box${pass.at}/static/style.css"`), true);
  const forged = await direct("GET", `${pass.at}/note.html`, { "x-chloe-relay-under": "/somewhere/else" });
  is("a prefix nobody relayed is ignored", [forged.includes('href="/somewhere/else'), forged.includes(`href="${pass.at}/static/style.css"`)], [false, true]);
  live.dashboard.remote.allow.memory = false;
  is("and switching memory off stops the frame as well", (await answer("12", "GET", `${pass.at}/note.md`)).status, 403);

  // A dropped connection is opened again, and a refused key says why.
  const count = opened.length;
  last().socket.close(1006, "");
  await tick();
  await tick();
  is("a dropped socket is opened again", opened.length > count, true);
  is("and is not connected until welcomed", dashboard.connected(), false);

  // A change to the settings while connected is a new socket.
  last().socket.onopen?.({});
  last().socket.onmessage?.({ data: JSON.stringify({ type: "welcome", workspace: { name: "here", label: "Here" } }) });
  await tick();
  const again = opened.length;
  dashboard.reload();
  await tick();
  is("a reload with the same settings sends the agents up", said("agents").length, 1);
  is("and opens nothing new", opened.length, again);
  live.dashboard.remote.api_key = "chl_install_other";
  dashboard.reload();
  await tick();
  is("a new key is a new socket", opened.length, again + 1);

  // A run started from a dashboard says so in the log, rather than looking like
  // another system holding a token.
  live.dashboard.remote.allow.run = true;
  const started = await answer("13", "POST", "/api/agents/test/job/relayed", { "content-type": "application/json" }, "{}");
  is("a job can be started through the dashboard", started.status, 200);
  is("and the log says it came from the dashboard, not from a token", cameIn.at(-1), "dashboard");

  // A guest: somebody the owner invited, given switches agent by agent. The
  // runtime checks them itself, so a dashboard that got it wrong is not the
  // only thing in the way.
  is("the hello says this runtime checks guests itself", hello?.capabilities?.includes("guests"), true);
  const { remember } = await import("#chloe/model/memory");
  const asGuest = (given: Record<string, string[]>) => ({ "x-chloe-relay-user": "g@example.com", "x-chloe-relay-guest": JSON.stringify(given) });
  const chatOnly = asGuest({ test: ["chat"] });
  is("a guest sees the agents they were given", JSON.parse((await answer("g1", "GET", "/api/agents", chatOnly)).text).map((one: { id: string }) => one.id), ["test"]);
  is("and nothing of an agent they were not", JSON.parse((await answer("g2", "GET", "/api/agents", asGuest({ other: ["chat"] }))).text), []);
  is("a header that does not read is a guest who may do nothing", JSON.parse((await answer("g3", "GET", "/api/agents", { "x-chloe-relay-guest": "nonsense" })).text), []);
  is("an agent they were not given is not there", (await answer("g4", "GET", "/api/agents/test/log", asGuest({ other: ["read"] }))).status, 403);
  is("chat alone does not read its log", (await answer("g5", "GET", "/api/agents/test/log", chatOnly)).status, 403);
  is("but does say which model answers", (await answer("g6", "GET", "/api/agents/test", chatOnly)).status, 200);
  is("and its runs are not listed", JSON.parse((await answer("g7", "GET", "/api/runs", chatOnly)).text), []);
  is("given read, they are", JSON.parse((await answer("g8", "GET", "/api/runs", asGuest({ test: ["read"] }))).text).length > 0, true);
  is("a job needs run", (await answer("g9", "POST", "/api/agents/test/job/relayed", { ...chatOnly, "content-type": "application/json" }, "{}")).status, 403);
  is("and with it, starts", (await answer("g10", "POST", "/api/agents/test/job/relayed", { ...asGuest({ test: ["run"] }), "content-type": "application/json" }, "{}")).status, 200);
  live.dashboard.remote.allow.memory = true;
  live.dashboard.remote.allow.write = true;
  const everything = asGuest({ test: ["read", "chat", "run", "memory", "write"] });
  is("a guest given memory reads it", (await answer("g11", "GET", "/api/agents/test/memory", everything)).status, 200);
  is("but never writes, whatever they were given", (await answer("g12", "POST", "/api/agents/test/memory/file", { ...everything, "content-type": "application/json" }, JSON.stringify({ path: "x.md", content: "" }))).status, 403);
  is("nor picks the model", (await answer("g13", "POST", "/api/agents/test/model", { ...everything, "content-type": "application/json" }, JSON.stringify({ scope: "agent", model: "" }))).status, 403);
  is("nor reaches what belongs to no agent", (await answer("g14", "GET", "/api/google", everything)).status, 403);
  live.dashboard.remote.allow.memory = false;
  live.dashboard.remote.allow.write = false;
  is("and nothing the workspace switched off is theirs", (await answer("g15", "GET", "/api/agents/test/memory", everything)).status, 403);

  // A guest's conversation is theirs because its owner is their email, not
  // because of anything in its id.
  remember("test/web-owner", "user", "the owner's");
  remember("test/web-g", "user", "the guest's");
  remember("test/web-h", "user", "another guest's");
  db.prepare("insert into threads (thread, owner) values (?, ?), (?, ?)").run("test/web-g", "g@example.com", "test/web-h", "h@example.com");
  const conversations = (n: string, headers: Record<string, string> = {}) =>
    answer(n, "GET", "/api/agents/test/threads", headers).then((one) => JSON.parse(one.text) as { thread: string; label: string | null; archived: string | null; owner?: string | null }[]);
  const theirs = await conversations("g16", chatOnly);
  is("a guest lists their own conversations and nobody else's", theirs.map((one) => one.thread), ["test/web-g"]);
  is("without their own email on each", "owner" in theirs[0], false);
  const all = await conversations("g17");
  is("the owner lists every one, saying whose a guest's is", [all.find((one) => one.thread === "test/web-g")?.owner, all.find((one) => one.thread === "test/web-owner")?.owner], ["g@example.com", null]);
  is("a guest cannot read the owner's", (await answer("g18", "GET", `/api/threads/${encodeURIComponent("test/web-owner")}`, chatOnly)).status, 404);
  is("nor another guest's", (await answer("g19", "GET", `/api/threads/${encodeURIComponent("test/web-h")}`, chatOnly)).status, 404);
  is("but reads their own", JSON.parse((await answer("g19b", "GET", `/api/threads/${encodeURIComponent("test/web-g")}`, chatOnly)).text).map((one: { content: string }) => one.content), ["the guest's"]);
  is("a guest cannot pick the model from the chat", (await answer("g20", "POST", "/api/agents/test/chat", { ...chatOnly, "content-type": "application/json" }, JSON.stringify({ prompt: "/model x for everything" }))).status, 403);
  is("nor run a job by its command without run", (await answer("g21", "POST", "/api/agents/test/chat", { ...chatOnly, "content-type": "application/json" }, JSON.stringify({ prompt: "/relayed" }))).status, 403);
  is("nor talk in somebody else's conversation", (await answer("g21b", "POST", "/api/agents/test/chat", { ...chatOnly, "content-type": "application/json" }, JSON.stringify({ prompt: "hello", thread: "test/web-owner" }))).status, 404);
  answers.push("Hello.");
  is("a new one is theirs once they speak in it", (await answer("g21c", "POST", "/api/agents/test/chat", { ...chatOnly, "content-type": "application/json" }, JSON.stringify({ prompt: "hello", thread: "test/web-new" }))).status, 200);
  is("and is listed as theirs", (await conversations("g21d", chatOnly)).map((one) => one.thread).sort(), ["test/web-g", "test/web-new"]);
  is("named from the first thing they said, by the model that names", (await conversations("g21e", chatOnly)).find((one) => one.thread === "test/web-new")?.label, "Late orders");
  answers.push("Again.");
  await answer("g21f", "POST", "/api/agents/test/chat", { ...chatOnly, "content-type": "application/json" }, JSON.stringify({ prompt: "and now?", thread: "test/web-g" }));
  is("one that already had something said in it is not named", (await conversations("g21g", chatOnly)).find((one) => one.thread === "test/web-g")?.label, null);

  // A picture goes to the model with the turn it came with, and only the line
  // saying it was attached is kept.
  answers.push("A cat.");
  const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const pictured = await answer("p1", "POST", "/api/agents/test/chat", { "content-type": "application/json" }, JSON.stringify({ prompt: "what is this?", thread: "test/web-pic", images: [{ name: "cat.png", mediaType: "image/png", data: dot }] }));
  is("a picture is taken with a turn", pictured.status, 200);
  const shown = lastAsked.at(-1)?.content as unknown as { type: string }[];
  is("and the model is shown it", Array.isArray(shown) && shown.some((part) => part.type === "image_url"), true);
  const kept = JSON.parse((await answer("p2", "GET", `/api/threads/${encodeURIComponent("test/web-pic")}`)).text) as { content: string }[];
  is("what is kept says it was attached, without the picture", [kept[0]?.content.includes("(Attached: cat.png)"), kept.some((one) => one.content.includes(dot))], [true, false]);
  is("a file that is not a picture is refused", (await answer("p3", "POST", "/api/agents/test/chat", { "content-type": "application/json" }, JSON.stringify({ prompt: "x", images: [{ name: "a.pdf", mediaType: "application/pdf", data: dot }] }))).status, 400);
  answers.push("Hi.");
  await answer("g21h", "POST", "/api/agents/test/chat", { ...chatOnly, "x-chloe-relay-name": encodeURIComponent("Ana <b>\nÑ"), "content-type": "application/json" }, JSON.stringify({ prompt: "who am I?", thread: "test/web-g" }));
  const asked = db.prepare("select prompt from runs where prompt like '%who am I?' order by started desc limit 1").get() as { prompt: string };
  is("the page's chat tells the agent who wrote, by the name they go by, on one plain line", asked.prompt, "<chat_context>\nfrom: Ana b Ñ\naddress: g@example.com\nrole: guest\n</chat_context>\n\nwho am I?");
  live.dashboard.remote.allow.write = true;
  is("forgetting somebody else's is refused", (await answer("g22", "POST", `/api/threads/${encodeURIComponent("test/web-owner")}/forget`, { ...chatOnly, "content-type": "application/json" }, "{}")).status, 404);
  is("and leaves it", (await conversations("g23")).some((one) => one.thread === "test/web-owner"), true);
  await answer("g24", "POST", `/api/threads/${encodeURIComponent("test/web-new")}/forget`, { ...chatOnly, "content-type": "application/json" }, "{}");
  is("forgetting their own forgets it", (await conversations("g25", chatOnly)).map((one) => one.thread), ["test/web-g"]);
  is("forgetting their own keeps it theirs, so nobody else can take it up", db.prepare("select owner from threads where thread = ?").get("test/web-new"), { owner: "g@example.com" });
  live.dashboard.remote.allow.write = false;

  // A conversation can be named and archived, by whoever may chat in it.
  const post = (n: string, path: string, value: unknown, headers: Record<string, string> = {}) =>
    answer(n, "POST", path, { ...headers, "content-type": "application/json" }, JSON.stringify(value));
  const owner = `/api/threads/${encodeURIComponent("test/web-owner")}`;
  is("the owner names a conversation", (await post("t1", `${owner}/rename`, { label: "Plans" })).status, 200);
  is("and the list says so", (await conversations("t2")).find((one) => one.thread === "test/web-owner")?.label, "Plans");
  is("an empty name takes it away", (await post("t3", `${owner}/rename`, { label: " " }), (await conversations("t4")).find((one) => one.thread === "test/web-owner")?.label), null);
  await post("t5", `${owner}/archive`, { archived: true });
  is("archiving keeps it in the list, saying when", typeof (await conversations("t6")).find((one) => one.thread === "test/web-owner")?.archived, "string");
  is("a guest cannot name the owner's", (await post("t7", `${owner}/rename`, { label: "Mine" }, chatOnly)).status, 404);
  await post("t9", `/api/threads/${encodeURIComponent("test/web-g")}/rename`, { label: "Mine" }, chatOnly);
  is("but names their own, which stays theirs", (await conversations("t10", chatOnly)).find((one) => one.thread === "test/web-g")?.label, "Mine");

  // Archiving a run keeps it, says when, and tells the dashboard, so its copy of
  // the log leaves it out too. Only the owner may.
  live.dashboard.remote.allow.write = true;
  const json = { "content-type": "application/json" };
  last().socket.onmessage?.({ data: JSON.stringify({ type: "welcome", workspace: { name: "here", label: "Here" } }) });
  await tick();
  const [first] = JSON.parse((await answer("a1", "GET", "/api/runs?limit=1")).text) as { id: string }[];
  const archive = (n: string, archived: boolean, headers: Record<string, string> = {}) =>
    answer(n, "POST", `/api/runs/${first.id}/archive`, { ...json, ...headers }, JSON.stringify({ archived }));
  is("a guest cannot archive a run", (await archive("a2", true, everything)).status, 403);
  is("the owner can", (await archive("a3", true)).status, 200);
  await tick();
  const listed = (n: string) => answer(n, "GET", "/api/runs?limit=1").then((one) => JSON.parse(one.text)[0].archived);
  is("and the run is still listed, saying when", typeof (await listed("a4")), "string");
  is("the dashboard is told", typeof (said("run").at(-1) as { run: { archived: unknown } }).run.archived, "string");
  await archive("a5", false);
  is("and bringing it back clears it", await listed("a7"), null);
  is("a run that is not there is a 404", (await answer("a6", "POST", "/api/runs/nothing/archive", json, JSON.stringify({ archived: true }))).status, 404);
  live.dashboard.remote.allow.write = false;

  // A visitor through the dashboard's public address: the web routes only,
  // needing no switch, since each checks a token or a pass itself, and a turn
  // streamed up in pieces when asked for.
  const { webChannel } = await import("#chloe/channels/web");
  keeper.channels = [webChannel({ origins: ["https://myshop.com"] })];
  const fromPage = { origin: "https://myshop.com", "content-type": "application/json" };
  const { makeToken } = await import("#chloe/serve/tokens");
  const siteServer = { authorization: `Bearer ${makeToken("the shop's site", "test").secret}`, "content-type": "application/json" };
  const asking = JSON.stringify({ visitor: "through-the-dashboard" });
  is("a pass is refused without the site's token", (await answer("w1b", "POST", "/api/agents/test/web/pass", fromPage, asking)).status, 401);
  const visitor = JSON.parse((await answer("w2", "POST", "/api/agents/test/web/pass", siteServer, asking)).text) as { pass: string };
  is("and given a pass with it", typeof visitor.pass, "string");
  last().socket.onmessage?.({ data: JSON.stringify({ type: "request", id: "w3", method: "OPTIONS", path: "/api/agents/test/web/turn", headers: { origin: "https://myshop.com", "access-control-request-method": "POST" }, body: null }) });
  for (let waited = 0; waited < 50 && !said("response").some((one) => one.id === "w3"); waited++) await tick();
  is("a browser asking first is answered for the page's site", said("response").find((one) => one.id === "w3")?.status, 204);
  answers.push("Shipped today.");
  last().socket.onmessage?.({
    data: JSON.stringify({ type: "request", id: "w4", method: "POST", path: "/api/agents/test/web/turn", headers: { ...fromPage, "x-chloe-pass": visitor.pass }, body: JSON.stringify({ text: "where is my order?" }), stream: true }),
  });
  for (let waited = 0; waited < 100 && !last().sent.some((one) => one.id === "w4" && one.type === "response-end"); waited++) await tick();
  const pieces = last().sent.filter((one) => one.id === "w4");
  is("a turn goes up as it comes: a start, its pieces, an end", [pieces[0]?.type, pieces.at(-1)?.type, pieces.length > 3], ["response-start", "response-end", true]);
  const streamed = pieces.filter((one) => one.type === "response-piece").map((one) => Buffer.from(one.body, "base64").toString("utf8")).join("");
  is("and the pieces are the turn's events", streamed.includes('"text":"Shipped today."'), true);
  is("anything else is still one answer", (await answer("w5", "GET", "/api/agents/test/web/history", { origin: "https://myshop.com", "x-chloe-pass": visitor.pass })).status, 200);
  keeper.channels = [];

  // A path the client cannot put on the wire used to throw out of the relay
  // and end the process. It must come back as a 502 instead.
  const badPath = await answer("14", "GET", "/api/agents/c c/threads");
  is("a path with a space in it is a 502, not a dead process", [badPath.status, badPath.text.includes("could not be sent")], [502, true]);

  dashboard.stop();
  live.dashboard.remote.api_key = "";
  ownPage(false);
  server.close();
}
