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

  is("they are somebody invited, not the owner", (await call("GET", "/api/me", jenny)).body, { owner: false, email: "jenny@example.com", name: "Jenny", given: { test: ["chat"] }, viewed: null });
  is("the owner is the owner", (await call("GET", "/api/me", owner)).body, { owner: true, name: (await import("#chloe/core/settings")).settings.ownerName });
  is("they see the agent they were let in to and no other", (await call("GET", "/api/agents", jenny)).body.map((one: { id: string }) => one.id), ["test"]);
  is("another agent is not there", (await call("GET", "/api/agents/other", jenny)).status, 404);
  is("chat alone does not read its log", (await call("GET", "/api/agents/test/log", jenny)).status, 403);
  is("nor list its runs", (await call("GET", "/api/runs", jenny)).body, []);
  is("only what is theirs is running", (await call("GET", "/api/health", jenny)).body.running, []);
  is("they never write to a memory", (await call("POST", "/api/agents/test/memory/file", jenny, { path: "x.md", content: "" })).status, 403);
  is("nor read one", (await call("GET", "/api/agents/test/memory", jenny)).status, 403);
  is("nor pick a model the owner did not name", (await call("POST", "/api/agents/test/model", jenny, { scope: "chat:test/web-jenny", model: "someone/else" })).status, 400);
  is("nor read what its commands are", (await call("GET", "/api/agents/test/commands", jenny)).status, 403);
  is("nor reach the tokens", (await call("GET", "/api/tokens", jenny)).status, 403);
  is("nor the people", (await call("GET", "/api/people", jenny)).status, 403);
  is("nor what belongs to no agent", (await call("GET", "/api/config", jenny)).status, 403);
  is("nor count as the owner to a proxy", (await call("GET", "/api/check", jenny)).status, 403);
  is("nor start a job without run", (await call("POST", "/api/agents/test/job/wake", jenny, {})).status, 403);

  answers.push("Hello Jenny.");
  const said = await call("POST", "/api/agents/test/chat", jenny, { prompt: "Hi", thread: "test/web-jenny" });
  is("they chat with it", [said.status, said.body.text], [200, "Hello Jenny."]);
  is("and the agent is told who wrote, as somebody invited", lastAsked.at(-1)?.content.includes("role: member") && lastAsked.at(-1)?.content.includes("jenny@example.com"), true);
  const told = lastAsked.find((one) => one.role === "system")?.content ?? "";
  is("and who it works with, each with their address", told.includes("The people you work with") && told.includes("Jenny, invited by your owner: jenny@example.com"), true);
  is("the conversation is theirs", (db.prepare("select owner from threads where thread = 'test/web-jenny'").get() as { owner: string }).owner, "jenny@example.com");
  is("a model picked in the chat is not theirs to pick", (await call("POST", "/api/agents/test/chat", jenny, { prompt: "/model x", thread: "test/web-jenny" })).status, 403);

  const read = async (thread: string) => (await call("GET", `/api/threads/${encodeURIComponent(thread)}`, jenny)).body as { id: number; role: string; content: string }[];
  is("the turn says which messages it kept, and the conversation reads back with the same ids", said.body.kept, (await read("test/web-jenny")).map(({ id, role }) => ({ id, role })));
  const forked = await call("POST", `/api/threads/${encodeURIComponent("test/web-jenny")}/fork`, jenny, { through: said.body.kept[1].id });
  is("they fork it into a new conversation, with what was said so far", (await read(forked.body.thread)).map((one) => one.role), ["user", "assistant"]);
  is("which is theirs too", (db.prepare("select owner from threads where thread = ?").get(forked.body.thread) as { owner: string }).owner, "jenny@example.com");
  is("a message from another conversation does not fork", (await call("POST", `/api/threads/${encodeURIComponent("test/web-jenny")}/fork`, jenny, { through: -1 })).status, 400);
  const first = (await read(forked.body.thread))[0].id;
  is("a reply is not theirs to edit", (await call("POST", "/api/agents/test/chat", jenny, { prompt: "x", thread: forked.body.thread, replaces: first + 1 })).status, 400);
  answers.push("Hello again.");
  const edited = await call("POST", "/api/agents/test/chat", jenny, { prompt: "Hello", thread: forked.body.thread, replaces: first });
  const after = await read(forked.body.thread);
  is("what they wrote is changed, and what came after it taken back", [edited.status, after.length, after.at(-1)?.content], [200, 2, "Hello again."]);
  is("and the conversation it came from goes on as it was", (await read("test/web-jenny")).map((one) => one.content).at(-1), "Hello Jenny.");

  remember("test/web-owner", "user", "the owner's");
  // Their own on any channel: an email conversation with them is theirs too.
  const listed = (await call("GET", "/api/agents/test/threads", jenny)).body.map((one: { thread: string }) => one.thread) as string[];
  is("they list their own conversations and not the owner's", [listed.includes("test/web-jenny"), listed.includes("test/web-owner")], [true, false]);
  is("the owner's is not there to read", (await call("GET", `/api/threads/${encodeURIComponent("test/web-owner")}`, jenny)).status, 404);
  is("nor to forget", (await call("POST", `/api/threads/${encodeURIComponent("test/web-owner")}/forget`, jenny, {})).status, 404);
  is("nor to land in by naming it", (await call("POST", "/api/agents/test/chat", jenny, { prompt: "Hi", thread: "test/web-owner" })).status, 404);

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
  // A plugin's route too, where it is there, and not there at all where it is not.
  is("nor the web visitors, whatever they were given", [403, 404].includes((await call("GET", "/api/agents/test/web/visitors", jenny)).status), true);

  // What somebody invited says is theirs, and the owner sees it only by viewing as them.
  {
    const hersThread = encodeURIComponent("test/web-jenny");
    const owns = (await call("GET", "/api/agents/test/threads", owner)).body.map((one: { thread: string }) => one.thread);
    is("the owner's list leaves out somebody invited's conversations", [owns.includes("test/web-jenny"), owns.includes("test/web-owner")], [false, true]);
    is("and the owner cannot open one", (await call("GET", `/api/threads/${hersThread}`, owner)).status, 404);
    is("or write in one", (await call("POST", "/api/agents/test/chat", owner, { thread: "test/web-jenny", prompt: "hello" })).status, 404);
    const herRun = said.body.runId as string;
    is("or read their run", (await call("GET", `/api/runs/${herRun}`, owner)).status, 404);
    is("which the log leaves out too", ((await call("GET", "/api/runs", owner)).body as { id: string }[]).some((one) => one.id === herRun), false);
    is("and the agent's log", ((await call("GET", "/api/agents/test/log", owner)).body as { id: string }[]).some((one) => one.id === herRun), false);

    {
      const { mkdir, writeFile, readFile: read, stat } = await import("node:fs/promises");
      const { STATE } = await import("#chloe/core/paths");
      const { forget, cut, branch } = await import("#chloe/model/memory");
      const { keepChatFile, typeOfFile } = await import("#chloe/services/chatFilesService");
      const fileAt = (shows: string) => /\(file:test\/([\w-]+)\)/.exec(shows)?.[1] ?? "";
      const png = Buffer.from("89504e470d0a1a0a00", "hex");

      is("a file's type is its first bytes", [typeOfFile(png), typeOfFile(Buffer.from("%PDF-1.7")), typeOfFile(Buffer.from("<svg onload=x>")), typeOfFile(Buffer.from("<html>"))], ["image/png", "application/pdf", "application/octet-stream", "application/octet-stream"]);

      // A reply on the page, as they asked for it, handing over a file from the agent's memory.
      await mkdir(test.memory.folder, { recursive: true });
      await writeFile(`${test.memory.folder}/fox.png`, png);
      answers.push({ tool_calls: [{ id: "1", type: "function", function: { name: "chatSendFile", arguments: '{"path":"fox.png"}' } }] }, "Here it is.");
      const reply = await call("POST", "/api/agents/test/chat", jenny, { thread: "test/web-jenny", prompt: "a picture please" });
      is("a reply on the page shows the file inside itself", /^Here it is\.\n\n!\[fox\]\(file:test\/[\w-]+\)$/.test(reply.body.text), true);
      const id = fileAt(reply.body.text);
      const address = `/api/agents/test/chat/files/${id}`;
      const got = await fetch(`${at}${address}`, { headers: jenny });
      is("whoever asked gets it, as what its bytes say it is", [got.status, got.headers.get("content-type"), got.headers.get("x-content-type-options")], [200, "image/png", "nosniff"]);
      is("nobody else does, the owner included", (await call("GET", address, owner)).status, 404);
      is("and with no session, nobody", (await call("GET", address)).status, 401);
      is("nor through another agent's address", (await call("GET", `/api/agents/other/chat/files/${id}`, owner)).status, 404);
      const audit = await read(`${STATE}/memory-audit/test.jsonl`, "utf8");
      is("one from a memory is in the audit log", audit.split("\n").some((line) => line.includes('"serve"') && line.includes("fox.png") && line.includes('"chat"')), true);

      const page = await keepChatFile("test", "test/web-jenny", "member:jenny@example.com", { path: `${test.memory.folder}/fox.png`, name: "](evil)\n.html" });
      is("a name cannot change the line that shows it", page.includes("\n") || page.includes("(evil"), false);
      await writeFile(`${test.memory.folder}/page.html`, "<script>alert(1)</script>");
      const script = await keepChatFile("test", "test/web-jenny", "member:jenny@example.com", { path: `${test.memory.folder}/page.html`, name: "page.png" });
      const opened = await fetch(`${at}/api/agents/test/chat/files/${fileAt(script)}`, { headers: jenny });
      is(
        "a page named as a picture only downloads, and in a sandbox",
        [script.startsWith("!"), opened.headers.get("content-type"), opened.headers.get("content-disposition")?.startsWith("attachment"), opened.headers.get("content-security-policy")?.startsWith("sandbox")],
        [false, "application/octet-stream", true, true],
      );

      const there = (one: string) => stat(`${STATE}/chat-files/${one}`).then(() => true, () => false);
      remember("test/web-files", "user", "two files");
      const first = await keepChatFile("test", "test/web-files", "owner", { path: `${test.memory.folder}/fox.png`, name: "one.png" });
      remember("test/web-files", "assistant", first);
      const cutFrom = (db.prepare("select max(id) as id from messages where thread = 'test/web-files'").get() as { id: number }).id;
      remember("test/web-files", "user", "and more");
      const second = await keepChatFile("test", "test/web-files", "owner", { path: `${test.memory.folder}/fox.png`, name: "two.png" });
      remember("test/web-files", "assistant", second);
      cut("test/web-files", cutFrom + 1);
      is("taking a message back takes its file, and leaves the one before", [await there(fileAt(first)), await there(fileAt(second))], [true, false]);
      branch("test/web-files", cutFrom, "test/web-fork");
      forget("test/web-files");
      is("a fork keeps a file its first conversation has lost", await there(fileAt(first)), true);
      forget("test/web-fork");
      db.prepare("update chat_files set at = '2020-01-01T00:00:00Z' where id = ?").run(fileAt(first));
      await keepChatFile("test", "test/web-other", "owner", { path: `${test.memory.folder}/fox.png`, name: "three.png" });
      is("and once nothing names it, it goes", await there(fileAt(first)), false);
    }

    is("somebody invited cannot view as anybody", (await call("POST", "/api/people/view", jenny, { email: "jenny@example.com" })).status, 403);
    is("nobody can be viewed who was not invited", (await call("POST", "/api/people/view", owner, { email: "nobody@example.com" })).status, 404);
    const started = await call("POST", "/api/people/view", owner, { email: "jenny@example.com" });
    const viewCookie = started.cookie.split(";")[0];
    const viewing = { cookie: `${owner.cookie}; ${viewCookie}` };
    const me = (await call("GET", "/api/me", viewing)).body;
    is("viewing as them, the page is told so", [me.owner, me.email, me.viewing], [false, "jenny@example.com", true]);
    const before = (db.prepare("select count(*) as n from views where person = 'jenny@example.com'").get() as { n: number }).n;
    is("it opens their conversation", (await call("GET", `/api/threads/${hersThread}`, viewing)).status, 200);
    const listedThere = (await call("GET", "/api/agents/test/threads", viewing)).body.map((one: { thread: string }) => one.thread);
    is("and lists what they see and no more", [listedThere.includes("test/web-jenny"), listedThere.includes("test/web-owner")], [true, false]);
    const hers = db.prepare("select id from chat_files where asker = 'member:jenny@example.com' and type = 'image/png' limit 1").get() as { id: string };
    is("a file of theirs opens", (await call("GET", `/api/agents/test/chat/files/${hers.id}`, viewing)).status, 200);
    is("each thing read is recorded", (db.prepare("select count(*) as n from views where person = 'jenny@example.com'").get() as { n: number }).n > before, true);
    is("it cannot send", (await call("POST", "/api/agents/test/chat", viewing, { thread: "test/web-jenny", prompt: "hello" })).status, 403);
    is("nor start a reply", (await call("POST", "/api/agents/test/chat/start", viewing, { prompt: "hello" })).status, 403);
    is("nor collect one of theirs", (await call("GET", "/api/agents/test/chat/answers/anything", viewing)).status, 403);
    is("nor change anything", (await call("POST", `/api/threads/${hersThread}/pin`, viewing, { pinned: true })).status, 403);
    is("nor pick a model", (await call("POST", "/api/agents/test/model", viewing, { scope: "chat:test/web-jenny", model: "" })).status, 403);
    is("nor reach what is the owner's", (await call("GET", "/api/people", viewing)).status, 403);
    is("the cookie alone is nothing, without the owner's session", (await call("GET", "/api/me", { cookie: viewCookie })).status, 401);
    is("nor with theirs does it make them anything more", (await call("GET", "/api/me", { cookie: `${jenny.cookie}; ${viewCookie}` })).body.viewing, undefined);
    is("they can see when they were last viewed", typeof (await call("GET", "/api/me", jenny)).body.viewed, "string");
    is("and so can the owner", typeof ((await call("GET", "/api/people", owner)).body.people as { viewed: string | null }[])[0].viewed, "string");
    const stopped = await call("POST", "/api/people/view/stop", viewing, {});
    is("stopping takes the cookie away", [stopped.status, stopped.cookie.includes("Max-Age=0")], [200, true]);
  }

  // Groups and the order of a list are each person's own.
  {
    const ownersGroup = (await call("POST", "/api/agents/test/groups", owner, { name: "Owner's" })).body.id;
    const hers = (await call("POST", "/api/agents/test/groups", jenny, { name: "Hers" })).body.id;
    is("each person sees only their own groups", (await call("GET", "/api/agents/test/groups", jenny)).body, [{ id: hers, name: "Hers" }]);
    is("and the owner's", (await call("GET", "/api/agents/test/groups", owner)).body, [{ id: ownersGroup, name: "Owner's" }]);
    is("somebody cannot rename another's", (await call("POST", `/api/agents/test/groups/${ownersGroup}/rename`, jenny, { name: "x" })).status, 404);
    is("or delete it", (await call("POST", `/api/agents/test/groups/${ownersGroup}/delete`, jenny, {})).status, 404);
    const a = "test/55555555-1111-4111-8111-111111111111";
    const b = "test/66666666-1111-4111-8111-111111111111";
    const other = "test/77777777-1111-4111-8111-111111111111";
    for (const thread of [a, b]) {
      db.prepare("insert into threads (thread, owner) values (?, ?) on conflict (thread) do update set owner = excluded.owner").run(thread, "jenny@example.com");
      remember(thread, "user", "hello");
    }
    remember(other, "user", "the owner's own");
    const grouped = (thread: string, group: number) => call("POST", `/api/threads/${encodeURIComponent(thread)}/group`, jenny, { group });
    is("they file their own conversation under their own group", (await grouped(a, hers)).status, 200);
    is("not under another's", (await grouped(b, ownersGroup)).status, 404);
    is("and not somebody else's conversation", (await grouped(other, hers)).status, 404);
    const order = (who: Record<string, string>, threads: string[]) => call("POST", "/api/agents/test/order", who, { threads });
    is("they put their own in order", (await order(jenny, [b, a])).status, 200);
    const places = (await call("GET", "/api/agents/test/threads", jenny)).body as { thread: string; place: number | null }[];
    is("which is kept", [places.find((one) => one.thread === b)?.place, places.find((one) => one.thread === a)?.place], [0, 1]);
    is("somebody else's they cannot", (await order(jenny, [other])).status, 404);
    is("nor another agent's", (await order(jenny, ["other/one"])).status, 404);
    await grouped(a, hers);
    is("filing it again starts its place over", ((await call("GET", "/api/agents/test/threads", jenny)).body as { thread: string; place: number | null }[]).find((one) => one.thread === a)?.place, null);
    await call("POST", `/api/agents/test/groups/${hers}/delete`, jenny, {});
    await call("POST", `/api/agents/test/groups/${ownersGroup}/delete`, owner, {});
  }

  // One form for everybody: the email says who.
  is("the owner signs in on the same form, and with no name of their own any address does", (await call("POST", "/api/login", {}, { email: "me@example.com", password: "a long enough one" })).status, 200);
  const refusedWords = (await call("POST", "/api/login", {}, { email: "nobody@example.com", password: "a long enough one wrong" })).body.error;
  is("a refusal does not say whose it was", refusedWords, "Wrong email or password.");

  // A model for a conversation of their own, from what the owner named.
  {
    const { settings } = await import("#chloe/core/settings");
    const { chosen } = await import("#chloe/model/choices");
    const was = settings.model.models;
    const reachable = (await call("GET", "/api/models?agent=test", owner)).body as { model: string; short?: boolean }[];
    const named = reachable[0]?.model ?? "";
    (settings.model as { models: string[] }).models = [named];
    const pickFor = (who: Record<string, string>, scope: string, model: string) => call("POST", "/api/agents/test/model", who, { scope, model });
    is("somebody invited is offered only what the owner named", (await call("GET", "/api/models?agent=test", jenny)).body.map((one: { model: string }) => one.model), [named]);
    const mine = "test/33333333-1111-4111-8111-111111111111";
    is("and may pick it for a conversation of their own", (await pickFor(jenny, `chat:${mine}`, named)).status, 200);
    is("which their new chats then start on", (await call("GET", "/api/agents/test", jenny)).body.mine, named);
    is("and nobody else's", (await call("GET", "/api/agents/test", owner)).body.mine, undefined);
    is("nothing else", (await pickFor(jenny, `chat:${mine}`, "someone/else")).status, 400);
    is("and never a job's", (await pickFor(jenny, "job:wake", named)).status, 400);
    is("so a job keeps its model", chosen("test", "job:wake"), undefined);
    const theirs = "test/44444444-1111-4111-8111-111111111111";
    remember(theirs, "user", "the owner's own");
    await pickFor(owner, `chat:${theirs}`, named);
    is("and never in somebody else's conversation", (await pickFor(jenny, `chat:${theirs}`, named)).status, 404);
    is("they do not see the picks of anybody else's", (await call("GET", "/api/agents/test", jenny)).body.chosen.map((one: { scope: string }) => one.scope), [`chat:${mine}`]);
    await pickFor(owner, `chat:${theirs}`, "");
    await pickFor(jenny, `chat:${mine}`, "");
    is("an empty pick takes it back", (await call("GET", "/api/agents/test", jenny)).body.mine, undefined);
    (settings.model as { models: string[] }).models = was;
  }

  is("they sign in again with their email", (await call("POST", "/api/login", {}, { email: "JENNY@example.com", password: "jenny's own password" })).status, 200);
  is("a wrong password says nothing about whether the address is somebody's", (await call("POST", "/api/login", {}, { email: "jenny@example.com", password: "wrong one" })).body.error, "Wrong email or password.");
  is("and neither does an address nobody has", (await call("POST", "/api/login", {}, { email: "nobody@example.com", password: "wrong one" })).body.error, "Wrong email or password.");

  const again = (await call("POST", "/api/people", owner, { email: "jenny@example.com", agent: "other", given: ["chat"] })).body.code as string;
  is("an invitation to somebody already in says so", (await call("GET", `/api/invitations/${again}`)).body.known, true);
  is("and takes the password they have, not a new one", (await call("POST", `/api/invitations/${again}/accept`, {}, { password: "a new password entirely" })).status, 401);
  is("with it, the second agent is theirs as well", (await call("POST", `/api/invitations/${again}/accept`, {}, { password: "jenny's own password" })).status, 200);
  is("both are listed for them", Object.keys((await call("GET", "/api/me", jenny)).body.given).sort(), ["other", "test"]);

  const reset = await call("POST", "/api/people/password", owner, { email: "Jenny@example.com" });
  is("the owner makes a password link for somebody in", [reset.status, reset.body.path.startsWith("/password/")], [200, true]);
  is("but not for an address nobody has", (await call("POST", "/api/people/password", owner, { email: "nobody@example.com" })).status, 400);
  is("somebody invited cannot make one", (await call("POST", "/api/people/password", jenny, { email: "jenny@example.com" })).status, 403);
  is("whoever holds it sees whose it is, with no session", (await call("GET", `/api/passwords/${reset.body.code}`)).body, { email: "jenny@example.com", name: "Jenny" });
  is("a made-up one is not there", (await call("GET", "/api/passwords/made-up")).status, 404);
  is("a short new password is refused", (await call("POST", `/api/passwords/${reset.body.code}`, {}, { password: "short" })).status, 401);
  const renewed = await call("POST", `/api/passwords/${reset.body.code}`, {}, { password: "jenny's new password" });
  is("taking it sets the new password and signs them in", [renewed.status, renewed.cookie.includes(cookieName())], [200, true]);
  is("and it works once", (await call("POST", `/api/passwords/${reset.body.code}`, {}, { password: "another one again" })).status, 401);
  is("the old password no longer signs in", (await call("POST", "/api/login", {}, { email: "jenny@example.com", password: "jenny's own password" })).status, 401);
  is("the new one does", (await call("POST", "/api/login", {}, { email: "jenny@example.com", password: "jenny's new password" })).status, 200);
  const earlier = (await call("POST", "/api/people/password", owner, { email: "jenny@example.com" })).body.code as string;
  await call("POST", "/api/people/password", owner, { email: "jenny@example.com" });
  is("a second link stops the first", (await call("GET", `/api/passwords/${earlier}`)).status, 404);

  db.prepare("delete from password_links").run();
  is("with nothing to mail from, the sign-in page is told it cannot mail a link", (await call("GET", "/api/password/forgotten")).body, { mails: false });
  is("and asking says so", (await call("POST", "/api/password/forgotten", {}, { email: "jenny@example.com" })).status, 400);
  // A stand-in for the plugin that sends the runtime's own mail, first in the list so it is the one asked.
  const { settings } = await import("#chloe/core/settings");
  const { PLUGINS } = await import("#chloe/plugins/index");
  const urlBefore = settings.serve.url;
  settings.serve.url = "https://chloe.example.com/";
  const mailed: { to: string; body: string }[] = [];
  PLUGINS.unshift({
    name: "stand-in-mail",
    alerts: { say: () => "on", send: async () => {}, toPerson: { ready: () => true, send: async (to, _subject, body) => void mailed.push({ to, body }) } },
  });
  try {
    is("with a way to mail, it can", (await call("GET", "/api/password/forgotten")).body, { mails: true });
    const forgot = await call("POST", "/api/password/forgotten", {}, { email: "Jenny@example.com" });
    for (let tries = 0; tries < 50 && !mailed.length; tries++) await new Promise((done) => setTimeout(done, 10));
    const mailedLink = /https:\/\/chloe\.example\.com\/password\/([\w-]+)/.exec(mailed[0]?.body ?? "");
    is("asking mails them a link to the page that sets a new one", [forgot.status, mailed[0]?.to, Boolean(mailedLink)], [200, "jenny@example.com", true]);
    const nobody = await call("POST", "/api/password/forgotten", {}, { email: "nobody@example.com" });
    await call("POST", "/api/password/forgotten", {}, { email: "jenny@example.com" });
    await new Promise((done) => setTimeout(done, 50));
    is("an address nobody has gets the same answer and no mail, and nor does asking again within ten minutes", [nobody.status, nobody.body, mailed.length], [200, { ok: true }, 1]);
    is("the mailed link sets the new password", (await call("POST", `/api/passwords/${mailedLink?.[1]}`, {}, { password: "jenny's mailed password" })).status, 200);
  } finally {
    PLUGINS.shift();
    settings.serve.url = urlBefore;
  }

  await call("POST", "/api/people/remove", owner, { email: "jenny@example.com", agent: "other" });
  is("taken off one agent, they keep the other", Object.keys((await call("GET", "/api/me", jenny)).body.given), ["test"]);
  const gone = await call("POST", "/api/people/remove", owner, { email: "jenny@example.com", agent: "test" });
  is("taken off the last, they are removed", gone.body.people, []);
  is("and signed out at once", (await call("GET", "/api/me", jenny)).status, 401);
  is("the owner is still in", (await call("GET", "/api/me", owner)).status, 200);

  server.close();
}
