// What the page does away from a browser: reading a markdown file into blocks
// that can be written back, painting code, and what a call does when the
// runtime says there is no session.
//
// On node:test rather than the runtime's `about`/`is`, because the page runs in
// a browser and imports nothing of the runtime's. `npm run test` runs it after
// the runtime's own suite.
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

import { api, frameUnder, NeedsSignIn, serverAt, servesFrom } from "./lib/api.ts";
import { href, read } from "./lib/route.ts";
import { allowed, landing } from "./lib/given.ts";
import type { Way } from "./lib/types.ts";
import { parts, sourceAt } from "./lib/blocks.ts";
import { languageOf, tokens } from "./lib/code.ts";

describe("a markdown file, written in place", () => {
  const file = "---\ncron: every.day\n---\n\n# Title\n\nOne line\nand its next.\n\n```sh\n\necho hi\n```\n";
  const blocks = parts(file);

  test("frontmatter, heading, paragraph and fence, one block each", () => {
    deepStrictEqual(blocks.map((block) => block.source), [
      "---\ncron: every.day\n---",
      "# Title",
      "One line\nand its next.",
      "```sh\n\necho hi\n```",
    ]);
  });

  // A block is written back by its place in the file, so everything around it
  // has to stay exactly as it was, blank lines and all.
  test("a block put back where it came from leaves the rest alone", () => {
    const third = blocks[2];
    strictEqual(file.slice(0, third.from) + third.source + file.slice(third.to), file);
  });

  test("what is after the last block is kept", () => strictEqual(file.slice(blocks[3].to), "\n"));
  test("nothing to cut", () => deepStrictEqual(parts(""), []));

  // What a reader sees is the source with its marks taken out.
  test("a click lands where the words are", () => strictEqual(sourceAt("**Who** you are", "Who you"), 11));
  test("and past the end is the end", () => strictEqual(sourceAt("hi", "hi there"), 2));
});

describe("code, painted", () => {
  test("a file says what it is written in", () => {
    deepStrictEqual(
      [languageOf("jobs/briefing.ts"), languageOf("bash"), languageOf("settings.json"), languageOf("notes.txt")],
      ["ts", "sh", "json", "plain"],
    );
  });

  test("a comment, a string and a keyword, and an address inside a string is still the string", () => {
    const line = 'const url = "http://x"; // and 42\n';
    deepStrictEqual(tokens(line, "ts").map((piece) => [piece.kind, piece.text]), [
      ["keyword", "const"],
      ["plain", " url = "],
      ["string", '"http://x"'],
      ["plain", "; "],
      ["comment", "// and 42"],
      ["plain", "\n"],
    ]);
  });

  // Whatever no rule claims is plain, so the file always comes back whole.
  const file = readFileSync(`${import.meta.dirname}/lib/blocks.ts`, "utf8");
  test("the pieces joined back are the file", () => {
    strictEqual(tokens(file, "ts").map((piece) => piece.text).join(""), file);
  });
  test("and a language nothing is known about is left alone", () => {
    deepStrictEqual(tokens(file, "plain"), [{ kind: "plain", text: file }]);
  });
});

describe("where the page is, as an address", () => {
  test("an address reads back as itself", () => {
    for (const path of ["/", "/agents/cc", "/agents/cc/config", "/agents/cc/log", "/agents/chloe/memory/01_projects/x.html", "/log", "/tokens", "/settings", "/people"]) {
      strictEqual(href(read(path, "")), path, path);
    }
    deepStrictEqual(read("/agents/cc/log", ""), { at: "log", agent: "cc", run: undefined });
    // An agent's own address is its chat; its overview is config.
    deepStrictEqual(read("/agents/cc", ""), { at: "chat", agent: "cc", thread: undefined });
    deepStrictEqual(read("/agents/cc/config", ""), { at: "agent", agent: "cc" });
    deepStrictEqual(read("/agents/cc/chat", ""), { at: "chat", agent: "cc", thread: undefined });
  });

  test("a conversation is in the address, and read back from it", () => {
    const at = href({ at: "chat", agent: "chloe", thread: "chloe/telegram-1" });
    strictEqual(at, "/agents/chloe/chat/telegram-1");
    deepStrictEqual(read(at, ""), { at: "chat", agent: "chloe", thread: "chloe/telegram-1" });
    // One not under its agent's id keeps the whole of it.
    deepStrictEqual(read(href({ at: "chat", agent: "chloe", thread: "cc/x" }), ""), { at: "chat", agent: "chloe", thread: "cc/x" });
    // The address it used to have still opens it.
    deepStrictEqual(read("/agents/chloe/chat", "?thread=chloe%2Fweb-1"), { at: "chat", agent: "chloe", thread: "chloe/web-1" });
  });

  test("an invitation's link opens its own page, code and all", () => {
    strictEqual(href({ at: "invitation", code: "abc123" }), "/invitation/abc123");
    deepStrictEqual(read("/invitation/abc123", ""), { at: "invitation", code: "abc123" });
    deepStrictEqual(read(href({ at: "invitation", code: "a b/c" }), ""), { at: "invitation", code: "a b/c" });
    // With no code it is nothing to open.
    deepStrictEqual(read("/invitation", ""), { at: "home" });
  });

  test("the way in: signing in, or opening a copy that has no password yet", () => {
    strictEqual(href({ at: "signin", making: false }), "/login");
    strictEqual(href({ at: "signin", making: true }), "/setup");
    deepStrictEqual(read("/login", ""), { at: "signin", making: false });
    deepStrictEqual(read("/setup", ""), { at: "signin", making: true });
  });

  // A memory file is shown in a frame from the address the runtime handed out,
  // which hangs off wherever that runtime's API is.
  test("a frame hangs off the same place the API does", () => {
    strictEqual(frameUnder("/api", "/memory/p"), "/memory/p");
    strictEqual(frameUnder("https://agents.example.com/api", "/memory/p"), "https://agents.example.com/memory/p");
  });
});

describe("talking to a runtime", () => {
  // A stand-in runtime: it answers with whatever the case before it set.
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  server.listen(0, "127.0.0.1");
  after(() => server.close());

  const ready = new Promise<void>((done) => server.once("listening", done)).then(() => {
    serverAt(`http://127.0.0.1:${(server.address() as { port: number }).port}/api`);
  });

  test("the page calls the runtime it was pointed at", async () => {
    await ready;
    answer = { status: 200, body: { exists: true } };
    deepStrictEqual(await api.account(), { exists: true });
    strictEqual(asked.at(-1), "/api/account");
  });

  test("a trailing slash on the address does not double up", async () => {
    await ready;
    const was = serverAt();
    serverAt(`${was}/`);
    strictEqual(serverAt(), was);
  });

  // The page shows the way in rather than the words, so a 401 has to be
  // something App can tell apart from a runtime that is simply unhappy.
  test("no session comes back as something to act on, not a message", async () => {
    await ready;
    answer = { status: 401, body: { error: "Sign in first." } };
    await rejects(() => api.agents(), NeedsSignIn);
  });

  test("but a wrong password is a message, because that form is already open", async () => {
    await ready;
    answer = { status: 401, body: { error: "Wrong password." } };
    await rejects(
      () => api.signIn("not the password"),
      (error: Error) => !(error instanceof NeedsSignIn) && error.message === "Wrong password.",
    );
  });

  test("and so is a wrong password taking an invitation", async () => {
    await ready;
    answer = { status: 401, body: { error: "That is not the password this address has here." } };
    await rejects(
      () => api.accept("abc", "nope", ""),
      (error: Error) => !(error instanceof NeedsSignIn) && error.message.startsWith("That is not"),
    );
    strictEqual(asked.at(-1), "/api/invitations/abc/accept");
  });

  test("somebody invited sends their email, and the owner does not", async () => {
    await ready;
    answer = { status: 200, body: { ok: true, token: "t" } };
    const sent: unknown[] = [];
    const was = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body))), was(url, init))) as typeof fetch;
    try {
      await api.signIn("pw");
      await api.signIn("pw", "someone@example.com");
    } finally {
      globalThis.fetch = was;
    }
    deepStrictEqual(sent, [{ password: "pw" }, { password: "pw", email: "someone@example.com" }]);
  });

  test("and any other trouble is said as the runtime said it", async () => {
    await ready;
    answer = { status: 500, body: { error: "The database is locked." } };
    await rejects(() => api.runs(), (error: Error) => error.message === "The database is locked.");
    ok(asked.some((one) => one.startsWith("/api/runs")), "the runs call names its own path");
  });
});

describe("somebody invited, on the page", () => {
  const given = { cc: ["chat" as const], tempo: ["run" as const, "read" as const] };

  test("sees only the pages they were given", () => {
    ok(allowed(given, { at: "chat", agent: "cc" }));
    ok(!allowed(given, { at: "chat", agent: "tempo" }));
    ok(allowed(given, { at: "jobs", agent: "tempo" }));
    ok(!allowed(given, { at: "jobs", agent: "cc" }));
    ok(allowed(given, { at: "log", agent: "tempo" }) && allowed(given, { at: "log" }));
    ok(!allowed({ cc: ["chat"] }, { at: "log" }));
    for (const view of [{ at: "home" }, { at: "agent", agent: "cc" }, { at: "memory", agent: "cc" }, { at: "people" }, { at: "tokens" }, { at: "settings" }] as const) {
      ok(!allowed(given, view), view.at);
    }
  });

  test("lands on a chat, on the agent they were on when they may", () => {
    deepStrictEqual(landing(given, ["cc", "tempo"]), { at: "chat", agent: "cc" });
    deepStrictEqual(landing(given, ["cc", "tempo"], "tempo"), { at: "jobs", agent: "tempo" });
    deepStrictEqual(landing({ tempo: ["read"] }, ["tempo"]), { at: "jobs", agent: "tempo" });
    strictEqual(landing({}, []), null);
  });
});

describe("what the server can do, from its list of routes", () => {
  const route = (path: string, method = "GET") => ({ method, path });

  test("the runtime: agents, tokens and people", () =>
    deepStrictEqual(servesFrom([route("/api"), route("/api/agents"), route("/api/tokens"), route("/api/people")]), {
      agents: true,
      tokens: true,
      people: true,
    }));

  test("one from before anybody could be invited has no People page", () =>
    strictEqual(servesFrom([route("/api/agents"), route("/api/tokens")]).people, false));

  test("only a GET counts", () => deepStrictEqual(servesFrom([route("/api/tokens", "POST")]).tokens, false));
});

describe("markdown, rendered", () => {
  let render: (text: string) => string;

  // Node cannot import a .tsx file, so the renderer is built with the same
  // esbuild the page itself is built with, and the bundled module is loaded
  // in memory. It includes its own copy of react, which is this repo's.
  before(async () => {
    const made = await build({
      entryPoints: [`${import.meta.dirname}/views/components/Markdown.tsx`],
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      logLevel: "silent",
    });
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(made.outputFiles[0].contents).toString("base64")}`
    )) as { Markdown: (props: { text: string }) => ReactNode };
    render = (text) => renderToStaticMarkup(createElement(module.Markdown, { text }));
  });

  test("an indented # line is a paragraph, and the render comes to an end", () => {
    const html = render("    # install\nnext line");
    ok(html.includes("<p>"), "the line becomes a paragraph");
    ok(html.includes("# install"), "and the words are there");
    ok(html.includes("next line"));
  });

  test("a heading at column zero is still a heading", () => ok(render("# Title\n\nBody").includes("<h2>Title</h2>")));

  test("nothing is dropped", () => {
    const html = render("**bold** and `code` and a [link](https://example.com)");
    for (const piece of ["<strong>bold</strong>", "<code>code</code>", 'href="https://example.com"']) {
      ok(html.includes(piece), piece);
    }
  });
});

describe("a connection, and what it is missing", () => {
  let render: (ways: Way[]) => string;

  before(async () => {
    const made = await build({
      entryPoints: [`${import.meta.dirname}/views/components/Ways.tsx`],
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      logLevel: "silent",
    });
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(made.outputFiles[0].contents).toString("base64")}`
    )) as { Ways: (props: { ways: Way[]; empty: string }) => ReactNode };
    render = (ways) => renderToStaticMarkup(createElement(module.Ways, { ways, empty: "none" }));
  });

  const google: Way = { name: "google", does: "Mail and files", needs: "google.client", ready: false };

  test("each missing line is shown, in place of the setting it waits on", () => {
    const html = render([{ ...google, missing: ["google.client is not set", "nobody has signed in yet"] }]);
    ok(html.includes("not set up"));
    ok(html.includes("google.client is not set"));
    ok(html.includes("nobody has signed in yet"));
    ok(!html.includes("waiting on"));
  });

  test("without missing, it says which setting it waits on", () => {
    ok(render([google]).includes("waiting on google.client in settings"));
  });

  test("once set up, missing is not shown", () => {
    const html = render([{ ...google, ready: true, missing: ["left over"] }]);
    ok(!html.includes("left over"));
    ok(html.includes("from google.client in settings"));
  });
});
