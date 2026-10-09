// An agent's memory served over the port, the log of it, and the page.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";
import type { Agent } from "./shared.ts";
import { agentFor, answer, codeJob, work } from "./shared.ts";

{
  about("an agent's memory, and the log of what was served");

  const { mkdir: makeDir, writeFile: put, readFile: get } = await import("node:fs/promises");
  const { serve } = await import("#chloe/serve/http");
  const { makeToken, forgetTokens } = await import("#chloe/serve/tokens");
  const { memoryFolder } = await import("#chloe/load/load");
  const { MEMORIES } = await import("#chloe/core/paths");

  const folder = `${process.env.CHLOE_STATE}/memory-under-test`;
  await makeDir(`${folder}/01_projects`, { recursive: true });
  await makeDir(`${folder}/static`, { recursive: true });
  await makeDir(`${folder}/.git`, { recursive: true });
  await put(
    `${folder}/01_projects/move.html`,
    '<!doctype html><link rel="stylesheet" href="/static/style.css"><a href="//elsewhere.example/x">x</a><h1>A project</h1>',
  );
  await put(`${folder}/static/style.css`, "h1 { color: red }");
  await put(`${folder}/.git/config`, "[core]");
  // An agent's own state folder can hold its credentials, and one here does.
  await makeDir(`${folder}/secrets`, { recursive: true });
  await put(`${folder}/secrets/key.txt`, "never shown");

  // Every agent has a memory. Unsaid, it is memory/ in the agent's own folder.
  is("unsaid, an agent's memory is its own folder in memory/", memoryFolder("tempo"), `${MEMORIES}/tempo`);
  is("said, it is wherever the agent says", memoryFolder("chloe", { folder: "/somewhere" }), "/somewhere");

  const keeper: Agent = { ...agentFor(codeJob("unused", async () => ({}))), memory: { folder, label: "Private" } };
  const other: Agent = {
    ...agentFor(codeJob("unused", async () => ({}))),
    id: "other",
    memory: { folder: `${process.env.CHLOE_STATE}/other-has-never-written` },
  };

  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", keeper], ["other", other]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const { token } = (await (
    await fetch(`${at}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a long enough one" }),
    })
  ).json()) as { token: string };
  const as = { cookie: `${(await import("#chloe/serve/login")).cookieName()}=${token}` };
  const file = (path: string, who = "test") =>
    fetch(`${at}/api/agents/${who}/memory/file?path=${encodeURIComponent(path)}`, { headers: as });

  // secrets/ is there and is left out, and the tree still comes back. It used
  // to stop the whole listing, which made a memory with credentials in it show
  // as a 500 and nothing else.
  is("the tree is what is in the folder, less what can never be opened", ((await (await fetch(`${at}/api/agents/test/memory`, { headers: as })).json()) as { name: string }[]).map((one) => one.name), ["01_projects", "static"]);
  is("a file reads back for editing", ((await (await file("01_projects/move.html")).json()) as { content: string }).content.includes("A project"), true);
  is("an agent says what it calls its memory", ((await (await fetch(`${at}/api/agents/test`, { headers: as })).json()) as { memory: string }).memory, "Private");
  is("and one that says nothing calls it Memory", ((await (await fetch(`${at}/api/agents/other`, { headers: as })).json()) as { memory: string }).memory, "Memory");
  is("an agent that has never written anything has an empty memory, not an error", await (await fetch(`${at}/api/agents/other/memory`, { headers: as })).json(), []);

  // A path that tries to leave is answered exactly like one that is not there.
  const out = await file("../../../etc/passwd");
  is("a path out of the folder is refused", out.status, 404);
  is("and says nothing about where the folder is", ((await out.json()) as { error: string }).error.includes(folder), false);
  is("the same for .git inside it", (await file(".git/config")).status, 404);
  is("and for secrets/, by name as well", (await file("secrets/key.txt")).status, 404);

  forgetTokens();
  const { secret } = makeToken("for a test");
  is("a token cannot read a memory at all", (await fetch(`${at}/api/agents/test/memory`, { headers: { authorization: `Bearer ${secret}` } })).status, 403);
  is("nor get a pass to one", (await fetch(`${at}/api/agents/test/memory/pass`, { headers: { authorization: `Bearer ${secret}` } })).status, 403);
  is("nor read what changed in it", (await fetch(`${at}/api/agents/test/changes`, { headers: { authorization: `Bearer ${secret}` } })).status, 403);

  // The frame. This is the part the whole viewer's safety rests on.
  const { at: under } = (await (await fetch(`${at}/api/agents/test/memory/pass`, { headers: as })).json()) as { at: string };
  const shown = await fetch(`${at}${under}/01_projects/move.html`);
  const policy = shown.headers.get("content-security-policy") ?? "";
  const html = await shown.text();
  is("a pass shows the file with no cookie at all", shown.status, 200);
  is("sandboxed, so its script cannot reach the page or the API", policy.startsWith("sandbox allow-scripts"), true);
  is("and it cannot open a connection to send anything out", policy.includes("connect-src 'none'"), true);
  is("only this site may frame it", policy.includes("frame-ancestors 'self'"), true);
  is("and nothing sniffs it into something it is not", shown.headers.get("x-content-type-options"), "nosniff");
  is("a root-relative link means the top of the memory, under the same pass", html.includes(`href="${under}/static/style.css"`), true);
  is("but a link to another host is left alone", html.includes('href="//elsewhere.example/x"'), true);
  is("which is where the stylesheet it links really is", (await (await fetch(`${at}${under}/static/style.css`)).text()), "h1 { color: red }");

  is("a made-up pass is refused", (await fetch(`${at}/memory/not-a-pass/01_projects/move.html`)).status, 403);
  const theirs = (await (await fetch(`${at}/api/agents/other/memory/pass`, { headers: as })).json()) as { at: string };
  is("and one agent's pass does not open another's memory", (await fetch(`${at}${theirs.at}/01_projects/move.html`)).status, 404);
  // Sent as raw HTTP, because fetch resolves ".." itself before sending and
  // would ask for a different address altogether. Encoded dots are what an
  // attacker actually sends, since they arrive at the server intact.
  await put(`${process.env.CHLOE_STATE}/NOT-IN-MEMORY.txt`, "never shown");
  const { request: send } = await import("node:http");
  const port = (server.address() as { port: number }).port;
  const rawly = (path: string) =>
    new Promise<{ status: number; body: string }>((done) => {
      send({ host: "127.0.0.1", port, path }, (answer) => {
        let body = "";
        answer.on("data", (chunk) => (body += chunk));
        answer.on("end", () => done({ status: answer.statusCode ?? 0, body }));
      }).end();
    });
  for (const walk of ["%2e%2e%2fNOT-IN-MEMORY.txt", "..%2fNOT-IN-MEMORY.txt", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
    const tried = await rawly(`${under}/${walk}`);
    is(`a pass does not walk out of the folder: ${walk}`, [tried.status, tried.body.includes("never shown")], [404, false]);
  }

  // What was served is written down, before it is served. That includes what a
  // frame loaded, not only what somebody clicked.
  const log = (await (await fetch(`${at}/api/agents/test/memory/log`, { headers: as })).json()) as { what: string; path: string }[];
  is("every file read or served is in the log", log.filter((one) => one.what === "serve").map((one) => one.path), ["static/style.css", "01_projects/move.html"]);
  is("and a refused path put nothing in it", log.some((one) => one.path.includes("passwd")), false);
  is("the log is kept outside the memory it records", (await get(`${process.env.CHLOE_STATE}/memory-audit/test.jsonl`, "utf8")).length > 0, true);

  // Moving and deleting stay inside too.
  await fetch(`${at}/api/agents/test/memory/rename`, {
    method: "POST",
    headers: { ...as, "content-type": "application/json" },
    body: JSON.stringify({ from: "01_projects/move.html", to: "04_archive/move.html" }),
  });
  is("a rename moves the file", (await file("04_archive/move.html")).status, 200);
  const escape = await fetch(`${at}/api/agents/test/memory/rename`, {
    method: "POST",
    headers: { ...as, "content-type": "application/json" },
    body: JSON.stringify({ from: "04_archive/move.html", to: "../../gone.html" }),
  });
  is("but not out of the folder", escape.status, 400);
  const whole = await fetch(`${at}/api/agents/test/memory/delete`, {
    method: "POST",
    headers: { ...as, "content-type": "application/json" },
    body: JSON.stringify({ path: "." }),
  });
  is("and the memory itself cannot be deleted from here", whole.status, 400);

  // Source control. A memory that sits inside somebody else's repository is
  // not a repository itself, whatever git says when asked from inside it.
  const { execFileSync } = await import("node:child_process");
  const outer = `${process.env.CHLOE_STATE}/outer-repo`;
  await makeDir(`${outer}/agents`, { recursive: true });
  await makeDir(`${outer}/data/tempo`, { recursive: true });
  const quiet = { cwd: outer, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q", "-b", "main"], quiet);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], quiet);
  await put(`${outer}/agents/someone-elses-work.ts`, "half done");
  await put(`${outer}/data/tempo/journal.md`, "a day");

  const inside: Agent = { ...agentFor(codeJob("unused", async () => ({}))), id: "inside", memory: { folder: `${outer}/data/tempo` } };
  const { memoryGit, memoryCommit } = await import("#chloe/serve/memory");
  is("a memory inside another repo is not a repo", (await memoryGit(inside)).repo, false);
  const tried = await memoryCommit(inside, "tidy up", "test").then(() => "committed", (error: Error) => error.message);
  is("so commit refuses rather than committing that repo's work", tried, "This memory is not a git repository.");
  is("and nothing was committed in the other repo", execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: outer, encoding: "utf8" }).trim(), "1");
  is("whose work is still sitting there uncommitted", execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: outer, encoding: "utf8" }).includes("agents/someone-elses-work.ts"), true);

  // One that is the top of its own repository is one.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: `${outer}/data/tempo`, stdio: "ignore" });
  is("a memory that is the top of its own repo is one", (await memoryGit(inside)).repo, true);

  server.close();
}

{
  about("the page");

  // What it serves. A file that is there is the file. Everything else is one of
  // the page's own addresses, including one with a dot in it: an address inside
  // the page can name a file that lives somewhere else entirely.
  const { servePage, noteHead } = await import("#chloe/serve/page");
  const served = async (path: string) => {
    let type = "";
    let body = "";
    const response = {
      writeHead: (_status: number, headers: Record<string, string>) => ((type = headers["content-type"]), response),
      end: (chunk: Buffer | string) => void (body = String(chunk)),
    };
    await servePage(response as never, path);
    return { type, page: body.includes('id="app"') };
  };
  is("its own script is its own script", (await served("/page.js")).type.startsWith("text/javascript"), true);
  is("an address of the page's is the page", (await served("/agents/chloe/log")).page, true);
  is("and so is one that names a file somewhere else", (await served("/agents/chloe/memory/02_areas/chess/curriculum.html")).page, true);
  is("but it will not hand out a file from outside its folder", (await served("/../../package.json")).page, true);
  is("a note is given the page's stylesheet for notes", noteHead().includes("/notes.css"), true);
}

{
  about("what the page adds to a note");

  const { withHead } = await import("#chloe/serve/memory");
  const add = '<link rel="stylesheet" href="/notes.css">';
  is("first inside the note's own head", withHead("<html><head><title>x</title></head></html>", add), `<html><head>\n${add}<title>x</title></head></html>`);
  is("not inside a header that is not a head", withHead("<!doctype html><header>h</header>", add), `<!doctype html>\n${add}<header>h</header>`);
  is("a head of its own when there is html and no head", withHead('<html lang="en"><p>x</p></html>', add), `<html lang="en">\n<head>${add}</head><p>x</p></html>`);
  is("and nothing at all when the page adds nothing", withHead("<p>x</p>", ""), "<p>x</p>");
}
