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

import { AnswerGone, api, collectAnswer, frameUnder, NeedsSignIn, serverAt, servesFrom } from "./lib/api.ts";
import { saidAt } from "./lib/format.ts";
import { href, read } from "./lib/route.ts";
import { ideasFor, ideasFrom } from "./lib/ideas.ts";
import { allowed, landing } from "./lib/given.ts";
import { modelName, shortChoices } from "./lib/models.ts";
import { byPlace, moved } from "./lib/order.ts";
import type { Way } from "./lib/types.ts";
import { forgetTyped, setTyped, typed } from "./lib/prefs.ts";
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
    for (const path of ["/", "/agents/cc", "/agents/cc/config", "/agents/cc/log", "/agents/chloe/memory/01_projects/x.html", "/log", "/tokens", "/account", "/configuration", "/appearance", "/help", "/people"]) {
      strictEqual(href(read(path, "")), path, path);
    }
    deepStrictEqual(read("/agents/cc/log", ""), { at: "log", agent: "cc", run: undefined });
    // An agent's own address is its chat; its overview is config.
    deepStrictEqual(read("/agents/cc", ""), { at: "chat", agent: "cc", thread: undefined });
    deepStrictEqual(read("/agents/cc/config", ""), { at: "agent", agent: "cc" });
    deepStrictEqual(read("/agents/cc/chat", ""), { at: "chat", agent: "cc", thread: undefined });
  });

  test("when somebody said something, by how long ago it was on the box's own clock", () => {
    const now = new Date("2026-11-05T15:00:00Z");
    strictEqual(saidAt("2026-11-05T14:18:00Z", now), "Today 9:18 AM");
    // Past midnight in UTC, and still the evening before where the box is.
    strictEqual(saidAt("2026-11-05T03:00:00Z", now), "Yesterday 10:00 PM");
    strictEqual(saidAt("2026-11-02T18:18:00Z", now), "Monday 1:18 PM");
    strictEqual(saidAt("2026-10-20T17:18:00Z", now), "Oct 20, 1:18 PM");
    strictEqual(saidAt("2025-10-20T17:18:00Z", now), "Oct 20, 2025, 1:18 PM");
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

  test("a new chat about a file in memory keeps the file in the address", () => {
    const at = href({ at: "chat", agent: "chloe", about: "01_projects/a b/index.html" });
    strictEqual(at, "/agents/chloe?about=01_projects%2Fa%20b%2Findex.html");
    deepStrictEqual(read("/agents/chloe", at.slice(at.indexOf("?"))), { at: "chat", agent: "chloe", about: "01_projects/a b/index.html" });
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
      () => api.signIn("me@example.com", "not the password"),
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

  test("signing in sends the email and the password", async () => {
    await ready;
    answer = { status: 200, body: { ok: true, token: "t" } };
    const sent: unknown[] = [];
    const was = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body))), was(url, init))) as typeof fetch;
    try {
      await api.signIn("someone@example.com", "pw");
    } finally {
      globalThis.fetch = was;
    }
    deepStrictEqual(sent, [{ email: "someone@example.com", password: "pw" }]);
  });

  test("and any other trouble is said as the runtime said it", async () => {
    await ready;
    answer = { status: 500, body: { error: "The database is locked." } };
    await rejects(() => api.runs(), (error: Error) => error.message === "The database is locked.");
    ok(asked.some((one) => one.startsWith("/api/runs")), "the runs call names its own path");
  });
});

describe("the order somebody dragged conversations into", () => {
  test("one never dragged comes first, and those dragged keep their places", () => {
    const list = [{ id: "c", place: 1 }, { id: "new" }, { id: "a", place: 0 }, { id: "newer", place: null }];
    deepStrictEqual(byPlace(list).map((one) => one.id), ["new", "newer", "a", "c"]);
  });

  test("a drop goes in front of the row it names, or at the end", () => {
    deepStrictEqual(moved(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
    deepStrictEqual(moved(["a", "b", "c"], "a", null), ["b", "c", "a"]);
    deepStrictEqual(moved(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
  });

  test("and one from another section joins the list", () => {
    deepStrictEqual(moved(["a", "b"], "x", "b"), ["a", "x", "b"]);
  });
});

describe("what is written in the chat box and not sent", () => {
  test("is kept by conversation, goes when emptied, and all goes on signing out", () => {
    const kept = Object.create({
      getItem: (key: string) => kept[key] ?? null,
      setItem: (key: string, value: string) => void (kept[key] = value),
      removeItem: (key: string) => void delete kept[key],
    });
    Object.defineProperty(globalThis, "localStorage", { value: kept, configurable: true });
    try {
      kept["chloe.theme"] = "red";
      setTyped("chloe", "", "a new chat");
      setTyped("chloe", "chloe/one", "half a thought");
      strictEqual(typed("chloe", ""), "a new chat");
      strictEqual(typed("chloe", "chloe/one"), "half a thought");
      strictEqual(typed("chloe", "chloe/two"), "");
      setTyped("chloe", "", "");
      strictEqual("chloe.typed.chloe." in kept, false);
      forgetTyped();
      deepStrictEqual(Object.keys(kept), ["chloe.theme"]);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("a model's name on the page", () => {
  test("in the words its maker's own app uses", () => {
    deepStrictEqual(
      ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-luna", "openai/gpt-5.6-terra", "google/gemini-3.8-flash-high"].map(modelName),
      ["Claude Opus 5.5", "Claude Sonnet 5.5", "ChatGPT 6 Luna", "ChatGPT 5.6 Terra", "Gemini 3.8 Flash"],
    );
  });

  test("DeepSeek and Kimi, whichever route carries them", () => {
    deepStrictEqual(
      ["opencode-go/deepseek-v4.1-flash", "opencode-go/kimi-k3.1-pro", "opencode-go/kimi-k3"].map(modelName),
      ["DeepSeek V4.1 Flash", "Kimi K3.1 Pro", "Kimi K3"],
    );
  });

  test("a model that trains on what it is sent says so", () => {
    strictEqual(modelName("opencode-go/muse-spark-1.3-contributor"), "Muse Spark 1.3 (training model)");
  });

  test("anybody else's stays as written, and a route named after it stays", () => {
    strictEqual(modelName("opencode-go/glm-5.3"), "opencode-go/glm-5.3");
    strictEqual(modelName("anthropic/claude-opus-5-5 via opencode"), "Claude Opus 5.5 via opencode");
  });

  test("a chat's short menu is only what the owner named", () => {
    const menu = shortChoices(
      [{ model: "openai/gpt-6-luna", route: "codex", short: true }, { model: "anthropic/claude-opus-5-5 via opencode", route: "opencode" }],
      () => {},
      "openai/gpt-6-luna",
    ) as { label: string; current?: boolean }[];
    deepStrictEqual(menu.map((one) => [one.label, one.current]), [["ChatGPT 6 Luna", true]]);
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
    for (const view of [{ at: "home" }, { at: "agent", agent: "cc" }, { at: "memory", agent: "cc" }, { at: "people" }, { at: "tokens" }, { at: "account" }, { at: "configuration" }, { at: "appearance" }] as const) {
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
  let unmarked: (text: string) => string;

  // Node cannot import a .tsx file, so the renderer is built with the same
  // esbuild the page itself is built with, and the bundled module is loaded
  // in memory. React is left out of the bundle and pointed at this file's own,
  // because a component with a hook, rendered by another copy, finds no React.
  before(async () => {
    const made = await build({
      entryPoints: [`${import.meta.dirname}/views/components/Markdown.tsx`],
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      external: ["react", "react/jsx-runtime"],
      logLevel: "silent",
    });
    const code = made.outputFiles[0].text.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, name) => `from "${import.meta.resolve(name)}"`);
    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      Markdown: (props: { text: string }) => ReactNode;
      unmarked: (text: string) => string;
    };
    render = (text) => renderToStaticMarkup(createElement(module.Markdown, { text }));
    unmarked = module.unmarked;
  });

  test("a picture loads only from the runtime's own files, and anything else stays a link", () => {
    const own = render("![A fox](file:chloe/abc-123)");
    ok(own.includes('<img src="/api/agents/chloe/chat/files/abc-123"'), "its own file loads");
    ok(own.includes('alt="A fox"'), "says what it shows");
    for (const away of ["![track](https://evil.example/?said=secret)", "![x](http://evil.example/a.png)", "![x](/api/tokens)", "![x](file:chloe/../../etc)", "![x](data:image/svg+xml,a)", "![x](javascript:alert(1))"]) {
      ok(!render(away).includes("<img"), `${away} does not load`);
    }
    ok(render("![track](https://evil.example/a.png)").includes('href="https://evil.example/a.png"'), "it is a link somebody has to press");
  });

  test("a link inside bold is still a link", () => {
    const html = render("**[Piqosity](https://www.piqosity.com/tests):** free");
    ok(html.includes('<strong><a class="away" href="https://www.piqosity.com/tests"'), "a link, in bold");
    ok(!html.includes("]("), "no marks left");
  });

  test("pictures alone on a line are a row, and one among words sits in them", () => {
    ok(render("![a](file:c/1) ![b](file:c/2)\n![d](file:c/3)").includes('class="pics n3"'), "a row of three");
    ok(render("![a](file:c/1)").includes('class="pics n1"'), "one alone");
    ok(render("1. ![a](file:c/1) **Name**: why").includes('<li><a class="pic"'), "beside a list item");
    strictEqual(unmarked("See ![a fox](file:c/1) here"), "See a fox here");
  });

  test("a file a reply handed over is a card, and a PDF says so", () => {
    const card = render("[Rory's worksheet.pdf](file:chloe/abc)");
    ok(card.includes('class="file-card"'), "a card");
    ok(card.includes('href="/api/agents/chloe/chat/files/abc"'), "that opens it");
    ok(card.includes('class="kind pdf">PDF'), "says it is a PDF");
    ok(render("[notes.txt](file:chloe/abc)").includes(">File<"), "anything else is a file");
  });

  test("a writing fence is a card of prose, copied without its marks", () => {
    const html = render("Here it is.\n\n```writing\n**(Chorus)**\n\n*Read the signs* and go\n```\n");
    ok(html.includes('class="writing"'), "a card");
    ok(html.includes("<strong>(Chorus)</strong>"), "its marks rendered");
    ok(!html.includes("<pre"), "not code");
    strictEqual(unmarked("# Song\n**(Chorus)**\n*Read the signs* and [go](https://x.org)"), "Song\n(Chorus)\nRead the signs and go");
  });

  test("an indented # line is a paragraph, and the render comes to an end", () => {
    const html = render("    # install\nnext line");
    ok(html.includes("<p>"), "the line becomes a paragraph");
    ok(html.includes("# install"), "and the words are there");
    ok(html.includes("next line"));
  });

  test("a heading at column zero is still a heading", () => ok(render("# Title\n\nBody").includes("<h2>Title</h2>")));

  test("a numbered list spaced out with blank lines is one list, numbered on", () => {
    const html = render("1. **One.** First\n\n2. **Two.** Second\n\n3. Third");
    strictEqual(html.match(/<ol/g)?.length, 1, "one list");
    strictEqual(html.match(/<li>/g)?.length, 3, "three items");
  });

  test("a numbered list that words interrupt starts again where it was", () => {
    const html = render("1. One\n\nBetween.\n\n2. Two");
    ok(html.includes('<ol start="2">'), html);
  });

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
    ok(html.includes("Not ready"));
    ok(html.includes("google.client is not set"));
    ok(html.includes("nobody has signed in yet"));
    ok(!html.includes("Needs google.client"));
  });

  test("without missing, it says which setting it waits on", () => {
    ok(render([google]).includes("Needs google.client in chloe.config.ts"));
  });

  test("once set up, missing is not shown", () => {
    const html = render([{ ...google, ready: true, missing: ["left over"] }]);
    ok(!html.includes("left over"));
    ok(html.includes("Ready") && !html.includes("Needs google.client"));
  });
});

describe("things to ask under an empty chat box", () => {
  const plain = { id: "a", identity: "", model: "", declaredModel: "", chosen: [], channels: [], api: false, memory: "", tools: [], toolsFrom: {}, skills: [], jobs: [] };
  test("an agent with nothing turned on gets the one that fits any agent", () => {
    deepStrictEqual(ideasFor(plain), ["What can you do?"]);
  });
  test("what it has turned on decides the rest, three at most", () => {
    const self = { ...plain, toolsFrom: { selfWriteFile: "abilities.selfImprovement" }, channels: ["telegram"] };
    const said = ideasFor(self, 3, () => 0);
    strictEqual(said.length, 3);
    const every = ideasFor(self, 99);
    strictEqual(said[0], every[0]);
    ok(said[0].startsWith("Write a job"));
    ok(every.some((one) => one.includes("Telegram")));
    ok(!every.some((one) => one.includes("Slack")));
  });
  test("after some talk, the newest named conversations and a group, emoji left off", () => {
    const one = (thread: string, last: string, label: string | null, archived: string | null = null) => ({ thread, messages: 2, last, label, archived });
    const threads = [
      one("a/1", "2026-10-01", "📚 Old reading"),
      one("a/2", "2026-10-03", "🏠 Council tax"),
      one("a/3", "2026-10-04", null),
      one("a/4", "2026-10-05", "Hidden", "2026-10-06"),
      one("a/5", "2026-10-02", "Greencard"),
    ];
    deepStrictEqual(ideasFrom(threads, [{ id: 1, name: "🌀 Projects" }]), [
      "What is left to do on Council tax?",
      "What is left to do on Greencard?",
      "What should I do next in Projects?",
    ]);
    deepStrictEqual(ideasFrom([one("a/3", "2026-10-04", null)], []), []);
  });
});

describe("collecting the answer to a chat message", () => {
  const wait = async () => {};
  const answering = (...replies: (Response | Error)[]) => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      const reply = replies.shift()!;
      if (reply instanceof Error) throw reply;
      return reply;
    }) as typeof fetch;
    return asked;
  };
  const said = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const was = globalThis.fetch;
  after(() => {
    globalThis.fetch = was;
  });

  test("it asks until the reply is done", async () => {
    const asked = answering(said({ going: true }), said({ going: true }), said({ text: "Done.", cost: 1 }));
    strictEqual((await collectAnswer("chloe", "a1", wait)).text, "Done.");
    strictEqual(asked.length, 3);
    ok(asked[0].endsWith("/agents/chloe/chat/answers/a1"));
  });

  test("a dropped connection or a proxy's error is only tried again, as the reply goes on without it", async () => {
    answering(new TypeError("Failed to fetch"), new Response("", { status: 524 }), new Response("", { status: 502 }), said({ text: "Done." }));
    strictEqual((await collectAnswer("chloe", "a1", wait)).text, "Done.");
  });

  test("a reply that failed says why", async () => {
    answering(said({ failed: "It broke." }));
    await rejects(collectAnswer("chloe", "a1", wait), /It broke/);
  });

  test("one no longer held is told apart, so the conversation can be read instead", async () => {
    answering(said({ error: "No answer with that id." }, 404));
    await rejects(collectAnswer("chloe", "a1", wait), AnswerGone);
  });

  test("a session that ended asks for the sign-in, however long it waited", async () => {
    answering(said({ going: true }), said({ error: "Sign in first." }, 401));
    await rejects(collectAnswer("chloe", "a1", wait), NeedsSignIn);
  });
});
