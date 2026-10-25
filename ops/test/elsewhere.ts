// An agent that runs in another copy of chloe, shown on this copy's page: what
// is passed on, as whom, and what the lists add. The other copy is a stand-in
// that answers the few routes asked of it and writes down what it was sent.

import { createServer, type IncomingMessage } from "node:http";
import { about, is } from "#chloe/ops/check";
import { agentFor, codeJob } from "./shared.ts";

{
  about("an agent that runs elsewhere");

  const { serve } = await import("#chloe/serve/http");
  const { makeToken, forgetTokens } = await import("#chloe/serve/tokens");
  const { cookieName } = await import("#chloe/serve/login");
  const { settings } = await import("#chloe/core/settings");

  const KEY = "the other copy's owner key, long enough";
  const seen: { method: string; path: string; authorization?: string; forwarded?: string; cookie?: string; body: string }[] = [];
  const reply = (request: IncomingMessage): [number, unknown, string?] => {
    const path = request.url ?? "";
    if (request.headers.authorization !== `Bearer ${KEY}`) return [401, { error: "Sign in first." }];
    if (path === "/api/agents/far") return [200, { id: "far", name: "Far", identity: "Runs in its own machine.", jobs: [] }];
    if (path === "/api/agents/far/threads") return [200, [{ thread: "far/one" }]];
    if (path === "/api/agents/far/chat") return [200, { runId: "r-far", text: "from far away" }];
    if (path.startsWith("/api/runs?")) {
      return [200, [
        { id: "r-far", agent: "far", started: "2099-01-02T00:00:00.000Z" },
        { id: "r-hidden", agent: "not-shown-here", started: "2099-01-03T00:00:00.000Z" },
      ]];
    }
    if (path === "/api/runs/r-far") return [200, { id: "r-far", agent: "far", trace: [] }];
    if (path === "/api/threads/far%2Fone") return [200, [{ role: "user", content: "hello" }]];
    if (path === "/api/parked") return [200, []];
    if (path === "/api/health") return [200, { ok: true, agents: ["far"], running: ["far/nightly"] }];
    if (path === "/api/agents/far/memory/pass") return [200, { pass: "P1", at: "/memory/P1" }];
    if (path === "/memory/P1/note.html") return [200, '<link rel="stylesheet" href="/memory/P1/style.css"><h1>A note</h1>', "text/html; charset=utf-8"];
    return [404, { error: "Not here." }];
  };
  const other = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        forwarded: request.headers["x-forwarded-for"] as string | undefined,
        cookie: request.headers.cookie,
        body,
      });
      const [status, value, type] = reply(request);
      response.writeHead(status, { "content-type": type ?? "application/json" });
      response.end(typeof value === "string" ? value : JSON.stringify(value));
    });
  }).listen(0, "127.0.0.1");
  await new Promise<void>((done) => other.once("listening", done));
  const otherAt = `http://127.0.0.1:${(other.address() as { port: number }).port}`;

  const before = settings.serve;
  settings.serve = { ...before, elsewhere: { far: { address: otherAt, key: KEY } } };

  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", agentFor(codeJob("unused", async () => ({})))]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = (await (
    await fetch(`${at}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a long enough one" }) })
  ).json()) as { token: string };
  const as = { cookie: `${cookieName()}=${token}` };
  const last = () => seen.at(-1)!;

  const listed = (await (await fetch(`${at}/api/agents`, { headers: as })).json()) as { id: string; name?: string }[];
  is("the owner's list has this copy's agents and the one elsewhere", listed.map((one) => one.id), ["test", "far"]);
  is("the one elsewhere as its own copy describes it", listed[1].name, "Far");

  const threads = await fetch(`${at}/api/agents/far/threads`, { headers: as });
  is("a route about it is answered by its own copy", await threads.json(), [{ thread: "far/one" }]);
  is("asked as the owner, with that copy's key", last().authorization, `Bearer ${KEY}`);
  is("and never with this copy's cookie", last().cookie, undefined);
  is("saying who is really asking, for that copy's lockout and audit", last().forwarded, "127.0.0.1");

  const said = await fetch(`${at}/api/agents/far/chat`, {
    method: "POST",
    headers: { ...as, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", thread: "far/one" }),
  });
  is("a chat turn goes there and its answer comes back", ((await said.json()) as { text: string }).text, "from far away");
  is("with what was said in it", JSON.parse(last().body), { prompt: "hello", thread: "far/one" });

  is("a conversation is found by the agent it names", await (await fetch(`${at}/api/threads/${encodeURIComponent("far/one")}`, { headers: as })).json(), [{ role: "user", content: "hello" }]);
  is("a run this copy has not got is found in the copy that has it", ((await (await fetch(`${at}/api/runs/r-far`, { headers: as })).json()) as { agent: string }).agent, "far");

  const runs = (await (await fetch(`${at}/api/runs?limit=50`, { headers: as })).json()) as { id: string }[];
  is("the list of runs has its runs too, newest first", runs[0]?.id, "r-far");
  is("but not those of an agent that copy runs and this one does not show", runs.some((one) => one.id === "r-hidden"), false);
  const health = (await (await fetch(`${at}/api/health`, { headers: as })).json()) as { agents: string[]; running: string[] };
  is("health says it is loaded", health.agents.includes("far"), true);
  is("and what it is running", health.running, ["far/nightly"]);

  forgetTokens();
  const { secret } = makeToken("for a test");
  const bearer = { authorization: `Bearer ${secret}` };
  is("a token here is nobody there", (await fetch(`${at}/api/agents/far/threads`, { headers: bearer })).status, 403);
  is("so its list has none of them", ((await (await fetch(`${at}/api/agents`, { headers: bearer })).json()) as { id: string }[]).map((one) => one.id), ["test"]);
  is("and nobody signed in is asked to", (await fetch(`${at}/api/agents/far/threads`)).status, 401);

  // The frame is served from here, with this copy's pass, so the policy that
  // keeps a note's script in its box is this copy's own.
  const { at: under } = (await (await fetch(`${at}/api/agents/far/memory/pass`, { headers: as })).json()) as { at: string };
  is("the pass for its memory is this copy's", under.startsWith("/memory/") && under !== "/memory/P1", true);
  const shown = await fetch(`${at}${under}/note.html`);
  const html = await shown.text();
  is("a file from its memory is shown", shown.status, 200);
  is("sandboxed like any memory file", (shown.headers.get("content-security-policy") ?? "").startsWith("sandbox allow-scripts"), true);
  is("asked of its copy with a pass made there for the same visitor", seen.at(-2)!.path, "/api/agents/far/memory/pass");
  is("so that copy records the read itself", last().path, "/memory/P1/note.html");
  is("and its links carry this copy's pass", html.includes(`href="${under}/style.css"`), true);

  other.close();
  await new Promise((done) => setTimeout(done, 50));
  const down = (await (await fetch(`${at}/api/agents`, { headers: as })).json()) as { id: string; identity: string }[];
  is("when its copy is down it is still listed, saying so", down[1]?.identity.includes("not answering"), true);
  is("and a call about it says which copy did not answer", (await fetch(`${at}/api/agents/far/threads`, { headers: as })).status, 502);

  // The other half: a copy that takes a key as its owner.
  settings.serve = { ...before, ownerKey: KEY };
  is("a copy with an owner key takes it as the owner", (await fetch(`${at}/api/tokens`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
  is("and nothing else as one", (await fetch(`${at}/api/tokens`, { headers: { authorization: "Bearer not the key" } })).status, 401);
  settings.serve = before;
  is("a copy without one takes no key at all", (await fetch(`${at}/api/tokens`, { headers: { authorization: `Bearer ${KEY}` } })).status, 401);
  is("not even an empty one", (await fetch(`${at}/api/tokens`, { headers: { authorization: "Bearer " } })).status, 401);

  server.close();
}
