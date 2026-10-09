// The people the owner invites: an invitation and its link, taking it, signing
// in with an email, and what somebody invited may and may not reach.

import { about, is } from "#chloe/ops/check";
import type { Agent } from "./shared.ts";
import { agentFor, answers, codeJob, db, lastAsked } from "./shared.ts";

{
  about("inviting people");

  const { serve } = await import("#chloe/serve/http");
  const { cookieName } = await import("#chloe/serve/login");
  const { remember } = await import("#chloe/model/memory");

  const test: Agent = agentFor(codeJob("wake", async () => ({})));
  const other: Agent = { ...agentFor(codeJob("unused", async () => ({}))), id: "other" };
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", test], ["other", other]]),
    clock: { fire() {}, running: () => ["test/wake", "other/unused"] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const call = async (method: string, path: string, headers: Record<string, string> = {}, sent?: unknown) => {
    const response = await fetch(`${at}${path}`, {
      method,
      headers: { ...headers, ...(sent === undefined ? {} : { "content-type": "application/json" }) },
      body: sent === undefined ? undefined : JSON.stringify(sent),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any, cookie: response.headers.get("set-cookie") ?? "" };
  };
  const session = (token: string) => ({ cookie: `${cookieName()}=${token}` });
  const owner = session((await call("POST", "/api/login", {}, { password: "a long enough one" })).body.token);

  const made = await call("POST", "/api/people", owner, { email: " Jenny@Example.com ", name: "Jenny", agent: "test", given: ["chat"] });
  is("the owner invites somebody to one agent and gets a link's code back", [made.status, made.body.path.startsWith("/invitation/")], [200, true]);
  const code = made.body.code as string;
  is("the invitation is listed, by its address, until it is taken", (await call("GET", "/api/people", owner)).body.invitations.map((one: { email: string }) => one.email), ["jenny@example.com"]);
  is("an agent that does not exist is refused", (await call("POST", "/api/people", owner, { email: "a@b.co", agent: "nobody" })).status, 404);
  is("and so is an address that is not one", (await call("POST", "/api/people", owner, { email: "jenny", agent: "test" })).status, 400);
  const kept = db.prepare("select hash from invitations where email = 'jenny@example.com'").get() as { hash: string };
  is("the code is kept only as a hash", kept.hash === code, false);

  const shown = await call("GET", `/api/invitations/${code}`);
  is("whoever holds the link sees what it is for, with no session", [shown.status, shown.body.email, shown.body.agent, shown.body.given, shown.body.known], [200, "jenny@example.com", "test", ["chat"], false]);
  is("a made-up code is not there", (await call("GET", "/api/invitations/made-up")).status, 404);
  is("a short password is refused", (await call("POST", `/api/invitations/${code}/accept`, {}, { password: "short" })).status, 401);
  const taken = await call("POST", `/api/invitations/${code}/accept`, {}, { password: "jenny's own password" });
  is("taking it signs them in", [taken.status, taken.cookie.includes(cookieName())], [200, true]);
  is("and it works once", (await call("POST", `/api/invitations/${code}/accept`, {}, { password: "jenny's own password" })).status, 401);
  const jenny = session(taken.body.token);

  is("they are somebody invited, not the owner", (await call("GET", "/api/me", jenny)).body, { owner: false, email: "jenny@example.com", name: "Jenny", given: { test: ["chat"] } });
  is("the owner is the owner", (await call("GET", "/api/me", owner)).body, { owner: true });
  is("they see the agent they were let in to and no other", (await call("GET", "/api/agents", jenny)).body.map((one: { id: string }) => one.id), ["test"]);
  is("another agent is not there", (await call("GET", "/api/agents/other", jenny)).status, 404);
  is("chat alone does not read its log", (await call("GET", "/api/agents/test/log", jenny)).status, 403);
  is("nor list its runs", (await call("GET", "/api/runs", jenny)).body, []);
  is("only what is theirs is running", (await call("GET", "/api/health", jenny)).body.running, []);
  is("they never write to a memory", (await call("POST", "/api/agents/test/memory/file", jenny, { path: "x.md", content: "" })).status, 403);
  is("nor read one", (await call("GET", "/api/agents/test/memory", jenny)).status, 403);
  is("nor pick the model", (await call("POST", "/api/agents/test/model", jenny, { scope: "agent", model: "" })).status, 403);
  is("nor reach the tokens", (await call("GET", "/api/tokens", jenny)).status, 403);
  is("nor the people", (await call("GET", "/api/people", jenny)).status, 403);
  is("nor what belongs to no agent", (await call("GET", "/api/google", jenny)).status, 403);
  is("nor count as the owner to a proxy", (await call("GET", "/api/check", jenny)).status, 403);
  is("nor start a job without run", (await call("POST", "/api/agents/test/job/wake", jenny, {})).status, 403);

  answers.push("Hello Jenny.");
  const said = await call("POST", "/api/agents/test/chat", jenny, { prompt: "Hi", thread: "test/web-jenny" });
  is("they chat with it", [said.status, said.body.text], [200, "Hello Jenny."]);
  is("and the agent is told who wrote, as somebody invited", lastAsked.at(-1)?.content.includes("role: guest") && lastAsked.at(-1)?.content.includes("jenny@example.com"), true);
  is("the conversation is theirs", (db.prepare("select owner from threads where thread = 'test/web-jenny'").get() as { owner: string }).owner, "jenny@example.com");
  is("a model picked in the chat is not theirs to pick", (await call("POST", "/api/agents/test/chat", jenny, { prompt: "/model x", thread: "test/web-jenny" })).status, 403);

  remember("test/web-owner", "user", "the owner's");
  // Their own on any channel: an email conversation with them is theirs too.
  const listed = (await call("GET", "/api/agents/test/threads", jenny)).body.map((one: { thread: string }) => one.thread) as string[];
  is("they list their own conversations and not the owner's", [listed.includes("test/web-jenny"), listed.includes("test/web-owner")], [true, false]);
  is("the owner's is not there to read", (await call("GET", `/api/threads/${encodeURIComponent("test/web-owner")}`, jenny)).status, 404);
  is("nor to forget", (await call("POST", `/api/threads/${encodeURIComponent("test/web-owner")}/forget`, jenny, {})).status, 404);
  is("nor to land in by naming it", (await call("POST", "/api/agents/test/chat", jenny, { prompt: "Hi", thread: "test/web-owner" })).status, 404);
  is("the owner lists every one, saying whose", (await call("GET", "/api/agents/test/threads", owner)).body.find((one: { thread: string }) => one.thread === "test/web-jenny")?.owner, "jenny@example.com");

  const changed = await call("POST", "/api/people/change", owner, { email: "jenny@example.com", agent: "test", given: ["chat", "read", "run"] });
  is("the owner changes what they may do", changed.body.people[0].given, { test: ["chat", "read", "run"] });
  is("which counts at once: with run, a job starts", (await call("POST", "/api/agents/test/job/wake", jenny, {})).status, 200);
  const turn = db.prepare("insert into runs (id, agent, started, source, model, prompt, reply, context, trace, owner, thread) values (?, 'test', ?, 'chat', 'm', ?, ?, 'the context', '[1]', ?, ?)");
  turn.run("run-jenny", new Date().toISOString(), "the instructions and her words", "to jenny", "chat:Jenny@Example.com", "test/web-jenny");
  turn.run("run-someone", new Date().toISOString(), "somebody's words", "to somebody", "chat:someone@example.com", "test/web-someone");
  const ids = (rows: { id: string }[]) => rows.map((one) => one.id);
  is("with read, they list their own runs and nobody else's", ids((await call("GET", "/api/runs", jenny)).body).includes("run-someone"), false);
  is("the log is only theirs too", ids((await call("GET", "/api/agents/test/log", jenny)).body).every((one) => one === "run-jenny" || !one.startsWith("run-")), true);
  is("somebody else's run is not there", (await call("GET", "/api/runs/run-someone", jenny)).status, 404);
  const own = (await call("GET", "/api/runs/run-jenny", jenny)).body;
  is("their own comes without the prompt, the context or the steps", [own.reply, own.prompt, own.context, own.trace], ["to jenny", undefined, undefined, []]);
  is("nor the web visitors, whatever they were given", (await call("GET", "/api/agents/test/web/visitors", jenny)).status, 403);

  is("they sign in again with their email", (await call("POST", "/api/login", {}, { email: "JENNY@example.com", password: "jenny's own password" })).status, 200);
  is("a wrong password says nothing about whether the address is somebody's", (await call("POST", "/api/login", {}, { email: "jenny@example.com", password: "wrong one" })).body.error, "Wrong email or password.");
  is("and neither does an address nobody has", (await call("POST", "/api/login", {}, { email: "nobody@example.com", password: "wrong one" })).body.error, "Wrong email or password.");

  const again = (await call("POST", "/api/people", owner, { email: "jenny@example.com", agent: "other", given: ["chat"] })).body.code as string;
  is("an invitation to somebody already in says so", (await call("GET", `/api/invitations/${again}`)).body.known, true);
  is("and takes the password they have, not a new one", (await call("POST", `/api/invitations/${again}/accept`, {}, { password: "a new password entirely" })).status, 401);
  is("with it, the second agent is theirs as well", (await call("POST", `/api/invitations/${again}/accept`, {}, { password: "jenny's own password" })).status, 200);
  is("both are listed for them", Object.keys((await call("GET", "/api/me", jenny)).body.given).sort(), ["other", "test"]);

  await call("POST", "/api/people/remove", owner, { email: "jenny@example.com", agent: "other" });
  is("taken off one agent, they keep the other", Object.keys((await call("GET", "/api/me", jenny)).body.given), ["test"]);
  const gone = await call("POST", "/api/people/remove", owner, { email: "jenny@example.com", agent: "test" });
  is("taken off the last, they are removed", gone.body.people, []);
  is("and signed out at once", (await call("GET", "/api/me", jenny)).status, 401);
  is("the owner is still in", (await call("GET", "/api/me", owner)).status, 200);

  server.close();
}
