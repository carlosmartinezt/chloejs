// Which route a model goes by, and reading a reply from a CLI.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, failed, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, db } from "./shared.ts";

{
  about("reading a reply from a cli");
  // Reaching into the package by path rather than through "@chloejs/core": reading the
  // CLI's replies is the runtime's own business, and this case should move in
  // with it the day chloe becomes its own repo.
  const { readReply } = await import("#chloe/model/cli");

  is("plain words are an answer", readReply("The site is up.").call, undefined);
  const tagged = readReply(
    'Let me look.\n<invoke name="memoryReadFile">\n<parameter name="path">2026</parameter>\n<parameter name="limit">5</parameter>\n</invoke>\n</invoke>\n<invoke name="memoryReadFile">',
    [{ name: "memoryReadFile", description: "", parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } }],
  );
  is("the tag form Claude is trained on is a request too", tagged.call?.function.name, "memoryReadFile");
  is("its values follow the tool's schema", tagged.call?.function.arguments, '{"path":"2026","limit":5}');
  is("and what came before it is what it said", tagged.said, "Let me look.");
  is(
    "an object on its own is a request",
    readReply('{"tool": "check_site", "arguments": {"url": "x"}}').call?.function.name,
    "check_site",
  );
  is(
    "narration before it is kept, not thrown away",
    readReply('Let me look first.\n\n{"tool": "check_site", "arguments": {}}').said,
    "Let me look first.",
  );
  is(
    "and the request still comes through",
    readReply('Let me look first.\n\n{"tool": "check_site", "arguments": {}}').call?.function.arguments,
    "{}",
  );
  is(
    "a fence around it is not a failure",
    readReply('Checking.\n\n```json\n{"tool": "check_site", "arguments": {}}\n```').call?.function.name,
    "check_site",
  );
  is(
    "writing about a tool is not asking for one",
    readReply('You would send {"tool": "check_site"} to ask for it, but I cannot.').call,
    undefined,
  );
  is("an object that is not a request is left as words", readReply('{"note": "not a tool"}').call, undefined);
  is(
    "missing arguments become none rather than nothing",
    readReply('{"tool": "disk_report"}').call?.function.arguments,
    "{}",
  );

  const several = readReply(
    'Reading both.\n{"tool": "memoryReadFile", "arguments": {"path": "a.html"}}\n{"tool": "memorySearchFiles", "arguments": {"query": "citi"}}',
  );
  is("several requests, one a line, are all read, in order", several.calls.map((c) => c.function.name), ["memoryReadFile", "memorySearchFiles"]);
  is("and what came before them is what it said", several.said, "Reading both.");
  is("the first is still the one call for a caller that takes one", several.call?.function.name, "memoryReadFile");
  is(
    "a request over several lines counts as one of them",
    readReply('{"tool": "a", "arguments": {}}\n{\n  "tool": "b",\n  "arguments": {"x": 1}\n}').calls.map((c) => c.function.arguments),
    ["{}", '{"x":1}'],
  );
  is(
    "the same request written twice runs once",
    readReply('{"tool": "a", "arguments": {"p": 1}}\n{"tool": "a", "arguments": {"p": 1}}').calls.length,
    1,
  );
  is(
    "several inside one fence are read too",
    readReply('Checking.\n```json\n{"tool": "a", "arguments": {}}\n{"tool": "b", "arguments": {}}\n```').calls.length,
    2,
  );
  is(
    "an object in the middle of the words is not a request",
    readReply('{"tool": "a", "arguments": {}}\nthen I will see.\n{"tool": "b", "arguments": {}}').calls.map((c) => c.function.name),
    ["b"],
  );
  is("plain words ask for nothing", readReply("All fine.").calls, []);

  // A Telegram run ended by sending the user `memoryListFiles with {"path":"01_projects"}`:
  // the transcript showed past calls in another shape, and the model copied it.
  const { asText } = await import("#chloe/model/cli");
  const memoryListFiles = [{ name: "memoryListFiles", description: "", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const { transcript } = asText({
    tools: memoryListFiles,
    messages: [
      { role: "user", content: "add a note" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", type: "function", function: { name: "memoryListFiles", arguments: '{"path":"02_areas"}' } }],
      },
      { role: "tool", tool_call_id: "1", content: "[]" },
    ],
  });
  const shown = transcript.split("\n").find((line) => line.includes("memoryListFiles"));
  is("a past call is shown in the shape the rules ask for", shown, '{"tool":"memoryListFiles","arguments":{"path":"02_areas"}}');
  is("a single result keeps its plain heading", transcript.includes("[result]\n[]"), true);
  const both = asText({
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "1", type: "function", function: { name: "memoryListFiles", arguments: "{}" } },
          { id: "2", type: "function", function: { name: "memorySearchFiles", arguments: '{"query":"citi"}' } },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "[a]" },
      { role: "tool", tool_call_id: "2", content: "[b]" },
    ],
  }).transcript;
  const listed = asText({
    native: "mcp__chloe__",
    tools: memoryListFiles,
    messages: [
      { role: "system", content: "Use `memoryListFiles` first." },
      { role: "user", content: "look" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "memoryListFiles", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "[]" },
    ],
  });
  is("where the route lists tools longer, a past call has the listed name", listed.transcript.includes("(called mcp__chloe__memoryListFiles with {})"), true);
  is("and the instructions say a short name is the listed one", listed.system.includes("it is the one listed as `mcp__chloe__memoryListFiles`"), true);
  // The claude route sends a part a block, and the cache matches a block only if it is the same one.
  const before = asText({ messages: [{ role: "user", content: "look" }, { role: "assistant", content: "seen" }] });
  const after = asText({ messages: [{ role: "user", content: "look" }, { role: "assistant", content: "seen" }, { role: "user", content: "again" }] });
  is("the parts joined are the transcript", after.parts.join(""), after.transcript);
  is("a message added leaves every part before it as it was", after.parts.slice(0, 2), before.parts);
  is("a route that lists them as they are says nothing extra", asText({ native: "", tools: memoryListFiles, messages: [{ role: "system", content: "x" }] }).system, "x");
  is(
    "results of several calls say which call each answers",
    [both.includes("[result of memoryListFiles]\n[a]"), both.includes("[result of memorySearchFiles]\n[b]")],
    [true, true],
  );
  is(
    "and copying it word for word is a request",
    readReply(shown ?? "", memoryListFiles).call?.function.arguments,
    '{"path":"02_areas"}',
  );
  is(
    "a call written as a sentence is still a request",
    readReply('memoryListFiles with {"path":"01_projects"}', memoryListFiles).call?.function.arguments,
    '{"path":"01_projects"}',
  );
  is(
    "bracketed too, with what came before kept",
    readReply('Let me look.\n[asked for memoryListFiles with {"path":"01_projects"}]', memoryListFiles).said,
    "Let me look.",
  );
  is(
    "but only for a tool the agent has",
    readReply('send_money with {"to":"x"}', memoryListFiles).call,
    undefined,
  );
  is(
    "and not in the middle of a sentence",
    readReply('I called memoryListFiles with {"path":"01_projects"} and it was empty.', memoryListFiles).call,
    undefined,
  );

  // A morning run ended after one turn: the model asked for a file, then wrote
  // the file's contents itself and carried on. None of it ran.
  const memoryReadFile = [{ name: "memoryReadFile", description: "", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const ahead = readReply(
    [
      "I'll start with the briefing.",
      "",
      '{"tool": "memoryReadFile", "arguments": {"path": "BRIEFING.md"}}',
      "",
      "[tool_result]",
      "# BRIEFING.md",
      "Generated: 2026-10-03T06:45:02Z",
      "",
      "Sending the summary.",
      '{"tool": "memoryReadFile", "arguments": {"path": "STATUS.md"}}',
    ].join("\n"),
    memoryReadFile,
  );
  is(
    "a request followed by a result it wrote itself is the first request alone",
    ahead.calls.map((c) => c.function.arguments),
    ['{"path":"BRIEFING.md"}'],
  );
  is("with the words before it kept", ahead.said, "I'll start with the briefing.");
  is("and the rest kept aside, not acted on", ahead.dropped?.split("\n")[0], "[tool_result]");
  is(
    "a [system] heading is the model writing a result too",
    readReply('Checking mail.\n{"tool": "memoryReadFile", "arguments": {}}\n[system] {"count":0}', memoryReadFile).dropped,
    '[system] {"count":0}',
  );
  is(
    "but only for a tool the agent has",
    readReply('{"tool": "send_money", "arguments": {}}\n[tool_result]\nsent', memoryReadFile).call,
    undefined,
  );
  is(
    "and a heading with words between it and the request is an answer",
    readReply('{"tool": "memoryReadFile", "arguments": {}}\nthat is how you ask.\n[note]\nfine', memoryReadFile).call,
    undefined,
  );

  // A Telegram reply said it was filing a comment and sent the request itself
  // as the answer: the object was one closing brace short, so nothing ran.
  const short = readReply('Adding it now.\n\n{"tool":"memoryReadFile","arguments":{"path":"a {b}.html"}', memoryReadFile);
  is("a request short of its closing braces runs", short.call?.function.arguments, '{"path":"a {b}.html"}');
  is("with the words before it kept", short.said, "Adding it now.");
  is(
    "one broken some other way still goes to the tool, which says it is not JSON",
    readReply('{"tool": "memoryReadFile", "arguments": {"path": "a",,}}', memoryReadFile).call?.function.arguments,
    '{"tool": "memoryReadFile", "arguments": {"path": "a",,}}',
  );
  is("but only for a tool the agent has", readReply('{"tool": "send_money", "arguments": {', memoryReadFile).call, undefined);
}

{
  about("which route a model goes by");
  const { models, routeFor, runnable } = await import("#chloe/model/model");
  const { codexModel, readCodex } = await import("#chloe/model/codex");
  const { cliModel } = await import("#chloe/model/claude");
  const { forgetOpencodeModels, viaOpencode } = await import("#chloe/model/opencode");
  const { settings } = await import("@chloejs/core");
  const before = structuredClone(settings.model);

  // Every CLI is a stand-in, so what is on the path decides nothing here. The
  // opencode one is opencodeStandIn.ts beside this file, which answers `models`
  // with two lines, which is how it says what it can carry, and `serve` as
  // opencode 2 does. It is never the real program: that would ask somebody's
  // account.
  const bin = await mkdtemp(join(tmpdir(), "chloe-bin-"));
  const fake = async (name: string, body: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };
  const anyCli = await fake("any", "exit 0");
  const standInLog = join(bin, "opencode.log");
  const opencodeCli = await fake("opencode", `exec "${process.execPath}" "${join(import.meta.dirname, "opencodeStandIn.ts")}" "${standInLog}" "$@"`);

  const pin = (claude: string, codex: string, opencode: string) => {
    Object.assign(settings.model.program, { claude, codex, opencode });
    forgetOpencodeModels();
  };

  try {
    Object.assign(settings.model, { preferredRoute: ["claude", "codex", "opencode", "gateway"], key: "", keys: { anthropic: "", openai: "" }, models: [] });
    pin(anyCli, anyCli, opencodeCli);
    is("the first route that carries the provider wins, so anthropic is the subscription", routeFor("anthropic/claude-sonnet-5"), "claude");
    is("and openai is the plan, because claude cannot carry it", routeFor("openai/gpt-6-luna"), "codex");
    is("a name with no provider is anthropic's", routeFor("claude-sonnet-5"), "claude");
    // opencode says it carries deepseek, and it is ahead of the gateway.
    is("a provider only opencode is signed in to goes there", routeFor("deepseek/deepseek-v4-pro"), "opencode");
    // Nothing before the gateway carries it, so it is the gateway that says a key
    // is missing rather than a CLI refusing the provider for a second reason.
    is("a provider nothing else carries goes to the gateway", routeFor("openrouter/free"), "gateway");

    pin("/nowhere/claude", anyCli, opencodeCli);
    settings.model.key = "k";
    is("a route this box is not set up for is skipped", routeFor("anthropic/claude-sonnet-5"), "gateway");

    pin(anyCli, anyCli, opencodeCli);
    is("and with it set up again the key is not reached for", routeFor("anthropic/claude-sonnet-5"), "claude");

    // Claude or Codex on an API key rather than a subscription: put the gateway first.
    settings.model.preferredRoute = ["gateway", "claude", "codex", "opencode"];
    is("the gateway first sends anthropic over the key", routeFor("anthropic/claude-sonnet-5"), "gateway");
    is("and openai too", routeFor("openai/gpt-6-luna"), "gateway");
    settings.model.preferredRoute = ["claude", "codex", "opencode", "gateway"];
    process.env.CHLOE_MODEL_PREFERRED_ROUTE = "gateway";
    is("the environment is not read", routeFor("anthropic/claude-sonnet-5"), "claude");
    delete process.env.CHLOE_MODEL_PREFERRED_ROUTE;

    // A provider's own key, which only carries that provider.
    settings.model.key = "";
    settings.model.preferredRoute = ["claude", "codex", "opencode", "direct", "gateway"];
    settings.model.keys.anthropic = "a";
    is("an anthropic key is not reached for while the subscription is ahead of it", routeFor("anthropic/claude-sonnet-5"), "claude");
    settings.model.preferredRoute = ["direct", "claude", "codex", "opencode", "gateway"];
    is("put first, anthropic goes to its own API", routeFor("anthropic/claude-sonnet-5"), "direct");
    is("and openai, with no key of its own, does not", routeFor("openai/gpt-6-luna"), "codex");
    settings.model.models = ["anthropic/claude-sonnet-5", "openai/gpt-6-luna"];
    is(
      "each is offered by the route it would go by, then by each other route that runs it",
      models().map((one) => [one.model, one.route]),
      [["anthropic/claude-sonnet-5", "direct"], ["anthropic/claude-sonnet-5 via claude", "claude"], ["openai/gpt-6-luna", "codex"]],
    );
    is("a route named at the end is the one taken", routeFor("anthropic/claude-sonnet-5 via claude"), "claude");
    is("even when it is not set up, so it says what is missing", routeFor("openai/gpt-6-luna via gateway"), "gateway");
    is("a route it names is not offered again", models().filter((one) => one.model.includes("via claude via")), []);
    settings.model.models = ["openai/gpt-5.5"];
    is("opencode is offered for a model on its own list", models().map((one) => one.model), ["openai/gpt-5.5", "openai/gpt-5.5 via opencode"]);

    // Each command says what it runs: claude when it starts, codex from its catalogue.
    const listing = await fake(
      "claude-listing",
      `cat >/dev/null; echo '{"type":"control_response","response":{"response":{"models":[{"value":"opus","resolvedModel":"claude-opus-5-5"},{"value":"claude-opus-5-5","resolvedModel":"claude-opus-5-5"},{"value":"haiku","resolvedModel":"claude-haiku-5-5"}]}}}'`,
    );
    const catalogue = await fake("codex-listing", `echo '{"models":[{"slug":"gpt-6-luna","visibility":"list"},{"slug":"memory-dream","visibility":"hide"}]}'`);
    const { learnModels } = await import("#chloe/model/model");
    const { gatewayUrl } = settings.model;
    Object.assign(settings.model, { models: [], keys: { anthropic: "", openai: "" }, gatewayUrl: "http://127.0.0.1:9/chat/completions" });
    pin(listing, catalogue, opencodeCli);
    await learnModels();
    is(
      "with no shortlist, each route offers what its command says it runs, the hidden left out",
      models().map((one) => [one.model, one.route]),
      [
        ["anthropic/claude-haiku-5-5", "claude"],
        ["anthropic/claude-opus-5-5", "claude"],
        ["deepseek/deepseek-v4-pro", "opencode"],
        ["openai/gpt-5.5", "codex"],
        ["openai/gpt-5.5 via opencode", "opencode"],
        ["openai/gpt-6-luna", "codex"],
      ],
    );
    Object.assign(settings.model, { models: ["anthropic/claude-opus-5.5"], key: "k", preferredRoute: ["gateway", "claude"] });
    is("another route is offered in its own spelling", models().map((one) => one.model), ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5-5 via claude"]);
    Object.assign(settings.model, { models: ["anthropic/claude-sonnet-5"], key: "", gatewayUrl, preferredRoute: ["direct", "claude", "codex", "opencode", "gateway"], keys: { anthropic: "a", openai: "" } });
    pin(anyCli, anyCli, opencodeCli);
    await learnModels();
    settings.model.models = [];
    pin("/nowhere/claude", "/nowhere/codex", "/nowhere/opencode");
    settings.model.preferredRoute = ["claude", "codex", "opencode", "direct", "gateway"];
    is("with no subscription here, the key is next", routeFor("anthropic/claude-sonnet-5"), "direct");
    is("and the startup line reports it", settings.model.preferredRoute.filter(runnable), ["direct"]);
    pin(anyCli, anyCli, opencodeCli);
    const { viaKey } = await import("#chloe/model/key");
    const refusal = async (model: string) => {
      try {
        await viaKey({ model, messages: [{ role: "user", content: "hi" }] }, "direct");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    is("a provider with no key says where one goes", await refusal("openai/gpt-6-luna"),
      "No openai key. Put it in .env as CHLOE_MODEL_KEYS_OPENAI, and in chloe.config.ts's settings as `model: { keys: { openai: process.env.CHLOE_MODEL_KEYS_OPENAI } }`.");
    is("and one it has no place for says how else to reach it", (await refusal("deepseek/deepseek-chat")).startsWith("deepseek has no place in model.keys"), true);
    settings.model.keys.anthropic = "";
    settings.model.key = "k";
    settings.model.preferredRoute = ["claude", "codex", "opencode", "gateway"];

    // The claude command would bill one of these over the subscription.
    const keyless = await fake("claude-keyless", 'cat >/dev/null; printf \'{"type":"result","result":"[%s%s]","is_error":false}\' "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN"');
    pin(keyless, anyCli, opencodeCli);
    process.env.ANTHROPIC_API_KEY = "sk-ant-in-env";
    process.env.ANTHROPIC_AUTH_TOKEN = "token-in-env";
    const { viaClaude: viaClaudeKeyless } = await import("#chloe/model/claude");
    const keylessSaid = await viaClaudeKeyless({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] } as any);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    is("the claude route is never handed an Anthropic key, so it stays on the subscription", keylessSaid.text, "[]");
    pin(anyCli, anyCli, opencodeCli);

    // A model now and then loops on its own tool syntax until the most an
    // answer may be, which by default takes ten minutes.
    const capped = await fake("claude-capped", 'cat >/dev/null; printf \'{"type":"result","result":"%s","is_error":false}\' "$CLAUDE_CODE_MAX_OUTPUT_TOKENS"');
    pin(capped, anyCli, opencodeCli);
    const { viaClaude } = await import("#chloe/model/claude");
    const said = await viaClaude({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] } as any);
    is("the claude route caps each answer", said.text, "16000");

    // With tools, they are real tool calls through the server beside the
    // route, and the calls are read from the CLI's record, never from words.
    // The stand-in answers in that record only when it was handed the server
    // and told to stop after one answer.
    const record = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"=\\"gmailReadEmail\\""},{"type":"tool_use","name":"mcp__chloe__gmailReadEmail","input":{"days":7}},{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","total_cost_usd":0.001}',
    ].join("\n");
    await writeFile(join(bin, "record.jsonl"), `${record}\n`);
    const toolCli = await fake(
      "claude-tools",
      `cat >/dev/null; case "$*" in *--mcp-config*--max-turns\\ 1*) cat "${join(bin, "record.jsonl")}" ;; *) printf '{"type":"result","result":"no tools","is_error":false}' ;; esac`,
    );
    pin(toolCli, anyCli, opencodeCli);
    const tools = [{ name: "gmailReadEmail", description: "Read mail.", parameters: { type: "object", properties: { days: { type: "number" } } } }];
    const asked = await viaClaude({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "mail?" }], tools } as any);
    is("with tools, a call is read from the record", asked.toolCalls.map((c) => [c.function.name, c.function.arguments]), [["gmailReadEmail", '{"days":7}']]);
    is("only a call to a tool it was handed", asked.toolCalls.length, 1);
    is("and words are only words, whatever they look like", asked.text, '="gmailReadEmail"');
    is("stopping after one answer to ask is not a failure", asked.cost, 0.001);

    // Called by its own name, the CLI refuses it, the model tries again, and
    // the CLI exits 1 past its one answer.
    const bare = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"gmailReadEmail","input":{"days":7}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"<tool_use_error>Error: No such tool available: gmailReadEmail</tool_use_error>"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"gmailReadEmail","input":{"days":7}},{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.002}',
    ].join("\n");
    await writeFile(join(bin, "bare.jsonl"), `${bare}\n`);
    pin(await fake("claude-bare", `cat >/dev/null; cat "${join(bin, "bare.jsonl")}"; exit 1`), anyCli, opencodeCli);
    const byName = await viaClaude({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "mail?" }], tools } as any);
    is("a call by the tool's own name counts, once", byName.toolCalls.map((c) => [c.function.name, c.function.arguments]), [["gmailReadEmail", '{"days":7}']]);
    const lost = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.002}',
    ].join("\n");
    await writeFile(join(bin, "lost.jsonl"), `${lost}\n`);
    pin(await fake("claude-lost", `cat >/dev/null; cat "${join(bin, "lost.jsonl")}"; exit 1`), anyCli, opencodeCli);
    const why = await viaClaude({ model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "mail?" }], tools } as any).then(
      () => "",
      (error: Error) => error.message,
    );
    is("a failure says the CLI's reason, not its opening line", why, "Model call refused: claude exited 1: error_max_turns");
    pin(anyCli, anyCli, opencodeCli);

    const { spawn } = await import("node:child_process");
    const specs = join(bin, "tools.json");
    await writeFile(specs, JSON.stringify(tools));
    const server = spawn(process.execPath, [join(import.meta.dirname, "../../model/toolServer.ts"), specs]);
    const heard: string[] = [];
    server.stdout.on("data", (chunk: Buffer) => heard.push(...chunk.toString().split("\n").filter(Boolean)));
    server.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    server.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    server.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gmailReadEmail","arguments":{}}}\n');
    for (let i = 0; i < 100 && heard.length < 3; i++) await new Promise((done) => setTimeout(done, 20));
    server.kill();
    const answers = heard.map((one) => JSON.parse(one));
    is("the tool server answers who it is", answers[0]?.result?.serverInfo?.name, "chloe");
    is("lists the tools it was handed, with their arguments", answers[1]?.result?.tools, [{ name: "gmailReadEmail", description: "Read mail.", inputSchema: tools[0].parameters }]);
    is("and runs nothing when one is called", answers[2]?.result?.content?.[0]?.text.startsWith("Asked for."), true);

    pin("/nowhere/claude", "/nowhere/codex", "/nowhere/opencode");
    is("a route with no program is not set up, and a key is still the gateway", settings.model.preferredRoute.filter(runnable), ["gateway"]);
    pin(anyCli, anyCli, opencodeCli);
    is("and the order is what the startup line reports", settings.model.preferredRoute.filter(runnable), ["claude", "codex", "opencode", "gateway"]);

    is("the codex cli is handed the name alone", codexModel("openai/gpt-6-luna"), "gpt-6-luna");
    let refused = "";
    try {
      codexModel("anthropic/claude-sonnet-5");
    } catch (error) {
      refused = (error as Error).message;
    }
    is("and refuses another provider's model before running anything", refused.includes("can only run OpenAI models"), true);
    is("the claude cli writes a dash for a dot", cliModel("anthropic/claude-haiku-4.5"), "claude-haiku-4-5");

    const lines = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Five."}}',
      '{"type":"turn.completed","usage":{"input_tokens":7572,"cached_input_tokens":1792,"output_tokens":25}}',
    ].join("\n");
    is("codex's lines are read for the message and the tokens", readCodex(lines), { text: "Five.", tokensIn: 7572, tokensOut: 25 });
    let failed = "";
    try {
      readCodex('{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"The model is not supported"}}');
    } catch (error) {
      failed = (error as Error).message;
    }
    is("and a failed turn is the error, in its words", failed, "Model call refused: codex: The model is not supported");

    // The opencode route starts a server of opencode's own for each call and
    // talks to it. The stand-in answers as opencode 2 does, with what the
    // model's name asks for, and writes down everything it was sent.
    const logged = async () => (await readFile(standInLog, "utf8")).split("\n").filter(Boolean).map((line): Record<string, any> => JSON.parse(line));
    const { UsageLimit } = await import("#chloe/model/model");
    const mail = [{ name: "gmailReadEmail", description: "Read mail.", parameters: { type: "object", properties: { days: { type: "number" } } } }];
    pin(anyCli, anyCli, opencodeCli);
    await writeFile(standInLog, "");
    const opened = await viaOpencode({ model: "opencode-go/calls", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "mail?" }], tools: mail } as any);
    const sent = await logged();
    is("on the opencode route a call is read from opencode's events", opened.toolCalls.map((c) => [c.function.name, c.function.arguments]), [["gmailReadEmail", '{"days":7}']]);
    is("as a tool it was handed, once, and a tool of opencode's own does not count", opened.toolCalls.length, 1);
    is("the words are its own session's", opened.text, "Looking.");
    is("and so are the cost and the tokens", [opened.cost, opened.tokensIn, opened.tokensOut], [0.002, 50, 7]);
    const written = sent.find((one) => one.what === "config");
    is("every tool of opencode's own is refused, and each of chloe's asked about", written?.config?.agents?.chloe?.permissions, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "chloe_*", resource: "*", effect: "ask" },
    ]);
    is("its instructions are the request's, and no session title is asked for", [written?.config?.agents?.chloe?.system.startsWith("Be brief."), written?.config?.agents?.title], [true, { disabled: true }]);
    is("it runs in a folder of its own, PWD and all", written?.pwd.includes("chloe-opencode-"), true);
    is("the tool server it is given lists the tools, each offered as itself", [sent.find((one) => one.what === "listed")?.tools, written?.config?.mcp?.servers?.chloe?.codemode], [["gmailReadEmail"], false]);
    const prompt = sent.find((one) => one.path?.endsWith("/prompt"));
    is("the prompt waits until opencode has the tools", prompt?.listed, true);
    is("and is the conversation", prompt?.body?.text.includes("mail?"), true);
    is("each ask is refused with no message, which ends the answer", sent.filter((one) => one.path?.includes("/permission/")).map((one) => one.body), [{ decision: "reject" }, { decision: "reject" }]);
    is("on the password made for the call", sent.some((one) => one.what === "refused"), false);
    is("and then the session and the server are gone", [sent.some((one) => one.method === "DELETE"), sent.at(-1)?.what], [true, "stopped"]);

    await writeFile(standInLog, "");
    const plain = await viaOpencode({ model: "opencode-go/words", messages: [{ role: "user", content: "2+3?" }] } as any);
    is("with no tools the answer is its words, its cost and its tokens", [plain.text, plain.toolCalls, plain.cost, plain.tokensIn, plain.tokensOut], ["Five.", [], 0.004, 58, 5]);
    is("and no tool server is started", (await logged()).some((one) => one.what === "listed"), false);

    await writeFile(standInLog, "");
    const stray = await viaOpencode({ model: "opencode-go/stray", messages: [{ role: "user", content: "ls?" }], tools: mail } as any);
    is("a call that fails before it is asked about stops opencode before it asks the model again", [stray.text, stray.toolCalls], ["Hm.", []]);
    is("by stopping the session", (await logged()).some((one) => one.path?.endsWith("/interrupt")), true);

    const limited = await viaOpencode({ model: "opencode-go/limit", messages: [{ role: "user", content: "hi" }] } as any).then(
      () => undefined,
      (error: Error) => error,
    );
    is("a usage limit is said as one", [limited instanceof UsageLimit, limited?.message.endsWith("It says: You have hit your usage limit")], [true, true]);
    const unavailable = await viaOpencode({ model: "opencode-go/missing", messages: [{ role: "user", content: "hi" }] } as any).then(
      () => "",
      (error: Error) => error.message,
    );
    is("and any other failure in opencode's words", unavailable, "Model call refused: opencode: Model unavailable: opencode-go/missing");
    pin(anyCli, anyCli, "/nowhere/opencode");
    const absent = await viaOpencode({ model: "opencode-go/words", messages: [{ role: "user", content: "hi" }] } as any).then(
      () => "",
      (error: Error) => error.message,
    );
    is("a program that is not there says so", absent.startsWith("The opencode route needs"), true);

    // What is on offer is what this box can run: a route with no program is left out.
    Object.assign(settings.model, { preferredRoute: ["claude", "codex", "opencode", "gateway"], key: "", models: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5", "openai/gpt-6-luna"] });
    pin("/nowhere/claude", "/nowhere/codex", "/nowhere/opencode");
    is("nothing is offered when no route is set up", models(), []);
    pin("/nowhere/claude", anyCli, "/nowhere/opencode");
    is("a model is offered once its program is there, and once only", models(), [{ model: "openai/gpt-6-luna", route: "codex" }]);
    const agent = agentFor(codeJob("nightly", async () => ({})));
    agent.model = "openai/gpt-5.5";
    is("an agent's own model is offered after the list", models(agent).map((one) => one.model), ["openai/gpt-6-luna", "openai/gpt-5.5"]);

    // With no shortlist, what each route says it carries is the offer.
    pin("/nowhere/claude", "/nowhere/codex", opencodeCli);
    settings.model.models = [];
    is("with no shortlist, a route is asked what it has", models().map((one) => one.model), ["deepseek/deepseek-v4-pro", "openai/gpt-5.5"]);
    // Back to the stand-in the top of this file set, rather than to "opencode":
    // the real one on the path would be in reach of every case below.
    pin("claude", "codex", "/nowhere/opencode");
    await rm(bin, { recursive: true, force: true });
  } finally {
    Object.assign(settings.model, before);
  }
}

{
  about("a model picked on the fly");
  const { choices, choose, chosen, modelFor } = await import("#chloe/model/choices");
  const { commands, receive } = await import("#chloe/channels/shared");
  const { settings } = await import("@chloejs/core");
  const job = codeJob("nightly", async () => ({}));
  const agent = agentFor(job);
  const named = { ...job, model: "anthropic/claude-sonnet-5" };

  is("without a pick, the file decides", [modelFor(agent), modelFor(agent, job), modelFor(agent, named)], ["anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5"]);
  choose("test", "agent", "openai/gpt-6-luna");
  is("a pick for everything beats the agent's own, not a job's own", [modelFor(agent), modelFor(agent, job), modelFor(agent, named)], ["openai/gpt-6-luna", "openai/gpt-6-luna", "anthropic/claude-sonnet-5"]);
  choose("test", "job:nightly", "openai/gpt-5.5");
  is("a pick for a job beats everything", modelFor(agent, job), "openai/gpt-5.5");
  is("every pick is listed, the agent's first", choices("test").map((one) => `${one.scope}=${one.model}`), ["agent=openai/gpt-6-luna", "job:nightly=openai/gpt-5.5"]);
  choose("test", "agent", "");
  choose("test", "job:nightly", "");
  is("an empty model takes a pick back", [chosen("test", "agent"), choices("test")], [undefined, []]);

  is("the menu ends with /models and /clear", commands(agent).slice(-2), [
    { command: "models", description: "Which model answers here, and the ones to pick from" },
    { command: "clear", description: "Start this conversation fresh" },
  ]);

  const listBefore = settings.model.models;
  settings.model.models = ["openai/gpt-6-luna"];
  const from = (text: string, thread = "test/api-pick") =>
    receive(agent, { channel: "api", chat: thread, thread, from: { id: "1", name: "me" }, text, private: true });
  try {
    const list = await from("/models");
    is("/models says what this chat uses and lists the rest", list?.text.split("\n").slice(0, 5), ["This chat: anthropic/claude-haiku-4.5 (the default)", "", "I can run:", "• openai/gpt-6-luna", "• anthropic/claude-haiku-4.5"]);
    is("with a button for each that sends the pick", list?.buttons?.map((one) => [one.label, one.sends]), [["openai/gpt-6-luna", "/model openai/gpt-6-luna"], ["anthropic/claude-haiku-4.5", "/model anthropic/claude-haiku-4.5"]]);
    is("/model picks for this chat", (await from("/model openai/gpt-6-luna"))?.text, "This chat now uses openai/gpt-6-luna.");
    answers.push("hello");
    await from("hi");
    const run = db.prepare("select model from runs where source = 'api' order by started desc limit 1").get() as { model: string };
    is("and the next turn in it goes there", run.model, "openai/gpt-6-luna");
    is("a chat on another thread does not", (await from("/models", "test/api-other"))?.text.split("\n")[0], "This chat: anthropic/claude-haiku-4.5 (the default)");
    is("a name that cannot be run is refused", (await from("/model nonsense"))?.text, "I cannot run nonsense. /models lists what I can.");
    is("for everything picks for the agent", (await from("/model openai/gpt-6-luna for everything"))?.text, "Everything test does now uses openai/gpt-6-luna, apart from a job that names its own.");
    is("which a job with no model of its own follows", modelFor(agent, job), "openai/gpt-6-luna");
    is("for a job picks for that job, with _ for -", (await from("/model anthropic/claude-haiku-4.5 for nightly"))?.text, "nightly now uses anthropic/claude-haiku-4.5.");
    is("and a job it does not have is said", (await from("/model openai/gpt-6-luna for weekly"))?.text, "I have no job called weekly. Mine: nightly.");
    is("/models then shows every pick that is not a chat's", (await from("/models"))?.text.split("\n").slice(0, 3), ["This chat: openai/gpt-6-luna", "Everything: openai/gpt-6-luna", "nightly: anthropic/claude-haiku-4.5"]);
    is("default takes one back", (await from("/model default for everything"))?.text, "Everything test does is back on the default, anthropic/claude-haiku-4.5.");
    is("and says what a job is back on", (await from("/model default for nightly"))?.text, "nightly is back on the default, anthropic/claude-haiku-4.5.");
    is("a call with no conversation has nowhere to keep a pick", (await from("/model openai/gpt-6-luna", ""))?.text, "This call has no conversation to remember a pick for. Say for everything, or for a job.");
    settings.model.models = ["openai/gpt-6-luna via gateway"];
    is("a model on a route of its own is picked whole, with for", (await from("/model openai/gpt-6-luna via gateway for nightly"))?.text, "nightly now uses openai/gpt-6-luna via gateway.");
    await from("/model default for nightly");
    choose("test", "chat:test/api-pick", "");
  } finally {
    settings.model.models = listBefore;
  }
}
