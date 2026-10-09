// Jobs and their steps: code, a model, an agent, and stopping to ask a person.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasToolCall, isStepCount, jsonSchema, Output, tool } from "ai";
import { z } from "zod";
import { about, failed, is } from "#chloe/ops/check";
import type { Job, Line } from "./shared.ts";
import { agentFor, answer, answers, asked, codeJob, db, gatewayUrl, lastAsked, row, sent, startCounting, sweep, timePasses, waitingFor, waitingOn, work } from "./shared.ts";

about("a job with no model in it");
{
  let checks = 0;
  const job = codeJob("plain", async ({ step }) => {
    const sites = await step("list", () => ["one", "two"]);
    const down: string[] = [];
    for (const site of sites) {
      const ok = await step(`check ${site}`, () => {
        checks++;
        return site !== "two";
      });
      if (!ok) down.push(site);
    }
    return { down };
  });
  const result = await work({ agent: agentFor(job), job });
  is("it finished", result.parked, false);
  is("it spent nothing", result.cost, 0);
  is("every step is a line", result.steps, 3);
  is("the record says code rather than a model", row(result.runId).model, "code");
  is("it did the work", JSON.parse(result.text), { down: ["two"] });
  is("each check ran once", checks, 2);
  is("the run says who it was for", row(result.runId).owner, "test:somebody");
}

about("what a run did, in one line");
{
  const counted = codeJob("counted", async () => ({ checked: 15, down: [] }), undefined, (r) => `${(r as { checked: number }).checked} sites, all up`);
  const said = await work({ agent: agentFor(counted), job: counted });
  is("a job says it in its own words", row(said.runId).summary, "15 sites, all up");

  const quiet = codeJob("quiet", async () => ({ checked: 15 }));
  const unsaid = await work({ agent: agentFor(quiet), job: quiet });
  is("a job with no response says nothing, rather than a guess", row(unsaid.runId).summary, null);

  const words = codeJob("words", async () => "**Done.**\n\n- three things\n- all fine");
  const worded = await work({ agent: agentFor(words), job: words });
  is("a string is read as one plain line", row(worded.runId).summary, "Done. three things all fine");

  const broken = codeJob("broken", async () => ({}), undefined, () => {
    throw new Error("no such field");
  });
  const done = await work({ agent: agentFor(broken), job: broken });
  is("a response that throws does not fail the run", row(done.runId).error, null);
  is("and it says so", row(done.runId).summary, "(its response failed: no such field)");

  const { recentWork } = await import("#chloe/serve/recentWork");
  const agent = { ...agentFor(counted), id: "recent" };
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const insert = db.prepare(
    "insert into runs (id, agent, started, finished, source, job, model, prompt, summary, error, cost) values (?, 'recent', ?, ?, ?, ?, 'code', '', ?, ?, ?)",
  );
  insert.run("l1", at(0), at(0), "schedule", "backup", "copied", null, 0);
  insert.run("l2", at(1), at(1), "schedule", "counted", "15 sites", null, 0);
  insert.run("l3", at(2), at(2), "schedule", "counted", null, "no answer", 0.5);
  insert.run("l4", at(3), at(3), "schedule", "counted", "15 sites, all up", null, 0.25);
  insert.run("l5", at(4), at(4), "telegram", null, "Hello.", null, 0.1);
  const recent = recentWork(agent);
  is("the newest first, a job in a row folded into one line", recent.map((one) => [one.id, one.times]), [
    ["l5", 1],
    ["l4", 3],
    ["l1", 1],
  ]);
  is("a line says the channel and the job", recent.map((one) => [one.source, one.job]), [
    ["telegram", null],
    ["schedule", "counted"],
    ["schedule", "backup"],
  ]);
  is("a folded line keeps count of what failed and what it cost", [recent[1].failed, recent[1].cost], [1, 0.75]);
  is("and stops at the count it is given", recentWork(agent, 2).length, 2);
}

about("what started a run, and what to say about it");
{
  const hearing = codeJob("hearing", async (work) => `heard ${work.input.text} from ${work.input.user}`);
  const heard = await work({
    agent: agentFor(hearing),
    job: hearing,
    input: { text: "hi", from: "telegram", chat: "1", user: "Carlos" },
  });
  is("the message arrives with no schema declared", heard.text, "heard hi from Carlos");

  const extra = await work({ agent: agentFor(hearing), job: hearing, input: { customer: "c-12" } }).then(
    () => "",
    (error: Error) => error.message,
  );
  is("anything outside the envelope is still refused", extra.includes("cannot be started with customer"), true);

  const saying = codeJob(
    "saying",
    async () => ({ bought: ["po-1"], checked: 4 }),
    undefined,
    () => "Bought po-1.\nTwo lines checked, all filed.",
  );
  const said = await work({ agent: agentFor(saying), job: saying });
  is("a chat is sent the whole of its response", said.reply, "Bought po-1.\nTwo lines checked, all filed.");
  is("and the overview shows its first line", said.summary, "Bought po-1. Two lines checked, all filed.");

  const worded = await work({ agent: agentFor(saying), job: codeJob("worded", async () => "Two things.\nAll handled.") });
  is("a string needs no response: the chat gets it whole", worded.reply, "Two things.\nAll handled.");
  is("and the overview its first line", worded.summary, "Two things. All handled.");

  const typed = await work({
    agent: agentFor(saying),
    job: { ...codeJob("typed", async (work) => work.args), args: z.object({ text: z.string().optional(), n: z.coerce.number() }) },
    input: { text: "hi", n: "3" },
  });
  is("the message is kept out of a job's input", JSON.parse(typed.text), { n: 3 });

  const memorable = codeJob("memorable", async (work) => {
    const go = await work.ask("file it?", { question: `File ${work.input.text}?`, answer: z.boolean() });
    return go ? `filed ${work.input.text}` : "left it";
  });
  const before = sent.length;
  const waiter = agentFor(memorable);
  const first = await work({ agent: waiter, job: memorable, input: { text: "a highlight", from: "telegram" } });
  is("it parked", first.parked, true);
  is("the question names the message", sent.slice(before), ["somebody: File a highlight?\n(yes or no)"]);
  const done = await answer(first.runId, "yes", new Map([[waiter.id, waiter]]));
  is("the message survived the pause", done.text, "filed a highlight");
  sent.splice(before);
}

about("an agent step: the goal is yours, the order is the model's");
{
  startCounting();
  answers.length = 0;
  const looked: string[] = [];
  const look = tool({
    description: "Look in one place.",
    inputSchema: z.object({ where: z.string() }),
    execute: ({ where }) => {
      looked.push(where);
      return where === "logs" ? "the deploy failed at 03:00" : "nothing here";
    },
  });

  // Two turns of the loop: one that asks for a tool, one that answers.
  answers.push(
    { content: "", tool_calls: [{ id: "1", type: "function", function: { name: "look", arguments: '{"where":"logs"}' } }] },
    '{"why":"the deploy failed at 03:00"}',
  );
  const job = codeJob("investigate", async (work) =>
    work.agent("work out what happened", {
      prompt: "Say why the site went down.",
      tools: { look },
      output: z.object({ why: z.string() }),
      stopWhen: isStepCount(4),
    }),
  );
  const result = await work({ agent: agentFor(job), job });
  is("it ran the tool it was given", looked, ["logs"]);
  is("and answered in the shape", JSON.parse(result.text), { why: "the deploy failed at 03:00" });
  const line = (JSON.parse(row(result.runId).trace) as { kind: string; cost: number; calls?: { toolName: string }[] }[])[0];
  is("the run calls it an agent step", line.kind, "agent");
  is("what it ran is written down", line.calls?.map((one) => one.toolName), ["look"]);
  is("and both turns are priced", line.cost, 0.0004);
}

about("an agent written with the AI SDK's own model and tools");
{
  startCounting();
  answers.length = 0;
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { defineAgent } = await import("@chloejs/core");
  const { resolveAgent } = await import("#chloe/load/load");
  const { turn } = await import("#chloe/core/turn");
  const { models, routeFor } = await import("#chloe/model/model");
  const { learnPrices, priced } = await import("#chloe/model/key");

  // A provider package pointed at the stand-in, as anthropic("...") would be at Anthropic.
  const standIn = createOpenAICompatible({ name: "standin", baseURL: gatewayUrl.replace(/\/chat\/completions$/, "") });
  const asked_: string[] = [];
  const definition = defineAgent({
    id: "sdk",
    folder: await mkdtemp(join(tmpdir(), "chloe-sdk-")),
    description: "",
    instructions: "Answer about the weather.",
    features: { memory: false },
    model: standIn("pal-1"),
    tools: {
      weather: tool({
        description: "Get the weather in a location (in Fahrenheit)",
        inputSchema: z.object({ location: z.string() }),
        execute: async ({ location }) => {
          asked_.push(location);
          return { location, temperature: 72 };
        },
      }),
      convert: tool({
        description: "Convert Fahrenheit to Celsius",
        inputSchema: jsonSchema<{ temperature: number }>({ type: "object", properties: { temperature: { type: "number" } }, required: ["temperature"] }),
        execute: async ({ temperature }) => ({ celsius: Math.round((temperature - 32) * (5 / 9)) }),
      }),
    },
  });
  const agent = await resolveAgent(definition);
  is("its model goes by the provider's own name for it", agent.model, "standin/pal-1");
  is("and is reached by its own package, whatever the routes say", routeFor(agent.model), "direct");
  is("it is on offer for that agent", models(agent).find((one) => one.model === agent.model)?.route, "direct");
  is("its tools are the ones it was given, by their names, and selfWriteFile", Object.keys(agent.tools ?? {}).sort(), ["convert", "selfWriteFile", "weather"]);

  answers.push(
    { content: "", tool_calls: [{ id: "1", type: "function", function: { name: "weather", arguments: '{"location":"San Francisco"}' } }] },
    { content: "", tool_calls: [{ id: "2", type: "function", function: { name: "convert", arguments: '{"temperature":72}' } }] },
    { content: "", tool_calls: [{ id: "3", type: "function", function: { name: "weather", arguments: '{"place":"Paris"}' } }] },
    "It is 22 degrees.",
  );
  const result = await turn({ agent, prompt: "What is the weather in San Francisco in celsius?", source: "terminal" });
  is("chloe's own loop runs its tools", asked_, ["San Francisco"]);
  is("and the model sees what each one said", lastAsked.filter((one) => one.role === "tool").map((one) => one.content), [
    '{"location":"San Francisco","temperature":72}',
    '{"celsius":22}',
    "weather was called wrongly: location Invalid input: expected string, received undefined",
  ]);
  is("and answers", result.text, "It is 22 degrees.");
  const trace = JSON.parse(row(result.runId).trace) as { tool?: string; failed?: boolean }[];
  is("every call is in the record, the wrong one marked", trace.filter((one) => one.tool).map((one) => [one.tool, one.failed ?? false]), [["weather", false], ["convert", false], ["weather", true]]);
  is("under the model's name", row(result.runId).model, "standin/pal-1");

  // A provider says tokens, and the gateway's list says what a token costs,
  // in its own spelling of the name.
  learnPrices([{ id: "standin/pal-1.5", pricing: { input: "0.000001", output: "0.000002", input_cache_read: "0.0000001" } }]);
  const usage = (inputTokens: number, cacheReadTokens: number, outputTokens: number) =>
    ({ inputTokens, outputTokens, inputTokenDetails: { noCacheTokens: inputTokens - cacheReadTokens, cacheReadTokens, cacheWriteTokens: 0 }, outputTokenDetails: {} }) as never;
  is("a call is priced from the gateway's list, which writes a dot where the provider writes a dash", priced("standin/pal-1-5", usage(1000, 0, 500)).toFixed(6), "0.002000");
  is("with what came from the cache at its own price", priced("standin/pal-1-5", usage(1000, 800, 0)).toFixed(6), "0.000280");
  is("and a model the list does not have costs nothing", priced("standin/unlisted", usage(1000, 0, 500)), 0);
  learnPrices([]);

  const asking = defineAgent({
    ...definition,
    id: "sdk-asking",
    tools: { pay: tool({ description: "Pay.", inputSchema: z.object({}), needsApproval: true, execute: async () => "paid" }) },
  });
  const { approval } = await import("#chloe/model/tool");
  const loaded = await resolveAgent(asking);
  const pay = loaded.tools!.pay;
  const here = { agent: loaded };
  is("a tool that wants approval loads", typeof pay.execute, "function");
  is("and wants a person", await approval({ pay }, "pay", {}, "1", here), { person: "" });
  is("unless toolApproval approves it first, as the AI SDK has it", await approval({ pay }, "pay", {}, "1", here, { pay: "approved" }), { run: true });
  is("and toolApproval saying nothing leaves it to the tool", await approval({ pay }, "pay", {}, "1", here, () => "not-applicable"), { person: "" });
  is("a denial's reason is what the model is told", await approval({ pay }, "pay", {}, "1", here, { pay: { type: "denied", reason: "not on Sundays" } }), { denied: "not on Sundays" });
}

about("an agent step that runs out of steps, and one with nothing to call");
{
  startCounting();
  answers.length = 0;
  const wander = tool({
    description: "Go round again.",
    inputSchema: z.object({}),
    execute: () => "still nothing",
  });
  const asking = { id: "1", type: "function", function: { name: "wander", arguments: "{}" } };
  answers.push({ content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] });

  const capped = codeJob("capped", async (work) =>
    work.agent("go round", { prompt: "Find something that is not there.", tools: { wander }, stopWhen: isStepCount(2) }),
  );
  const out = await work({ agent: agentFor(capped), job: capped }).then(() => "finished", (error: Error) => error.message);
  is("it stops and says so rather than looping forever", out.includes("stopped by its stopWhen after 2 steps"), true);

  const empty = codeJob("empty", async (work) =>
    work.agent("with nothing", { prompt: "Do something.", tools: {} }),
  );
  const refused = await work({ agent: agentFor(empty), job: empty }).then(() => "", (error: Error) => error.message);
  is("an agent step with no tools is a model step, and says so", refused.includes("use model(...)"), true);
  // A capped run leaves whatever it did not use behind it.
  answers.length = 0;
}

about("an agent step stopped by the AI SDK's own conditions, and outputs other than an object");
{
  startCounting();
  answers.length = 0;
  const done = tool({ description: "Say it is done.", inputSchema: z.object({}), execute: () => "noted" });
  answers.push({ content: "", tool_calls: [{ id: "1", type: "function", function: { name: "done", arguments: "{}" } }] });
  const stopped = codeJob("stopped", async (work) =>
    work.agent("finish", { prompt: "Finish.", tools: { done }, stopWhen: hasToolCall("done") }),
  );
  const out = await work({ agent: agentFor(stopped), job: stopped }).then(() => "finished", (error: Error) => error.message);
  is("hasToolCall stops it after the step that made the call", out.includes("stopped by its stopWhen after 1 steps"), true);

  answers.length = 0;
  answers.push('{"result":"billing"}');
  const picked = codeJob("picked", async (work) =>
    work.model("pick", { prompt: "Which desk?", output: Output.choice({ options: ["billing", "sales"] }) }),
  );
  is("Output.choice comes back as the choice", (await work({ agent: agentFor(picked), job: picked })).text.includes("billing"), true);

  const texty = codeJob("texty", async (work) => work.model("say", { prompt: "Say something.", output: Output.text() }));
  const refused = await work({ agent: agentFor(texty), job: texty }).then(() => "", (error: Error) => error.message);
  is("Output.text is refused in a model step, because free text cannot steer the next one", refused.includes("answers in a shape"), true);
  answers.length = 0;
}

about("an agent step kept inside its budget");
{
  startCounting();
  answers.length = 0;
  const wander = tool({
    description: "Go round again.",
    inputSchema: z.object({}),
    execute: () => "still nothing",
  });
  const asking = { id: "1", type: "function", function: { name: "wander", arguments: "{}" } };
  answers.push({ content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] });

  // Two turns at $0.0002 each, against a budget that only covers one.
  const job = codeJob("dear", async (work) =>
    work.agent("go round", { prompt: "Find something expensive.", tools: { wander }, budget: 0.0003, stopWhen: isStepCount(9) }),
  );
  const result = await work({ agent: agentFor(job), job }).then(() => "finished", (error: Error) => error.message);
  is("it stops on the money, not only on the steps", result.includes("spent $0.0004 of its $0.0003 budget"), true);
  const dear = db.prepare("select cost, trace from runs where job = 'dear'").get() as { cost: number; trace: string };
  is("and the run is charged for what it did spend", dear.cost, 0.0004);
  // A step that failed is still a step that happened, or a budget blowout
  // would say what it cost and not what it spent the money on.
  const line = (JSON.parse(dear.trace) as { kind: string; cost: number; failed?: string; calls?: { toolName: string }[] }[])[0];
  is("the step it failed on is still a line", [line.kind, line.cost], ["agent", 0.0004]);
  is("with the calls that spent the money", line.calls?.map((one) => one.toolName), ["wander"]);
  is("and why it stopped", line.failed?.includes("budget"), true);

  // The second go at the shape is another turn, so it is the budget's business
  // too: a step with nothing left does not get one.
  answers.length = 0;
  answers.push("that is not the shape");
  const once = codeJob("once", async (work) =>
    work.agent("answer properly", {
      prompt: "Say how many.",
      tools: { wander },
      output: z.object({ n: z.number() }),
      budget: 0.0002,
    }),
  );
  const noRetry = await work({ agent: agentFor(once), job: once }).then(() => "", (error: Error) => error.message);
  is("with nothing left, it does not pay for another go at the shape", noRetry.includes("spent $0.0002 of its $0.0002 budget"), true);
  is("and it stopped after the one turn it could afford", asked, 3);
  answers.length = 0;
}

about("an agent step whose calls the job has to allow");
{
  startCounting();
  answers.length = 0;
  const looked: string[] = [];
  const look = tool({
    description: "Look in one place.",
    inputSchema: z.object({ where: z.string() }),
    execute: ({ where }) => {
      looked.push(where);
      return "the deploy failed at 03:00";
    },
  });
  const wanting = (where: string) => ({
    id: "1",
    type: "function",
    function: { name: "look", arguments: JSON.stringify({ where }) },
  });
  answers.push(
    { content: "", tool_calls: [wanting("the password file")] },
    { content: "", tool_calls: [wanting("logs")] },
    '{"why":"the deploy failed at 03:00"}',
  );

  const job = codeJob("allowed", async (work) =>
    work.agent("work out what happened", {
      prompt: "Say why the site went down.",
      tools: { look },
      output: z.object({ why: z.string() }),
      // The tool says it may look. This says where.
      toolApproval: { look: ({ where }) => (where === "logs" ? "approved" : { type: "denied", reason: "only the logs are yours to read" }) },
      stopWhen: isStepCount(4),
    }),
  );
  const result = await work({ agent: agentFor(job), job });
  is("the call it was not allowed never ran", looked, ["logs"]);
  const line = (JSON.parse(row(result.runId).trace) as { calls?: { toolName: string; output: unknown; refused?: boolean }[] }[])[0];
  is("the refusal is written down beside the call", line.calls?.map((one) => one.refused === true), [true, false]);
  is("and the model was told why", String(line.calls?.[0].output).includes("only the logs are yours to read"), true);
  is("so it tried another way and finished", JSON.parse(result.text), { why: "the deploy failed at 03:00" });
  answers.length = 0;
}

about("an approve that cannot answer, and a question from inside a step");
{
  startCounting();
  answers.length = 0;
  const look = tool({
    description: "Look in one place.",
    inputSchema: z.object({ where: z.string() }),
    execute: () => "nothing here",
  });
  answers.push({
    content: "",
    tool_calls: [{ id: "1", type: "function", function: { name: "look", arguments: '{"where":"logs"}' } }],
  });

  // A gate that cannot answer is not a refusal: the step stops rather than
  // guessing which way the job meant it.
  const gate = codeJob("gate", async (work) =>
    work.agent("work out what happened", {
      prompt: "Say why the site went down.",
      tools: { look },
      toolApproval: () => {
        throw new Error("the rule itself is broken");
      },
    }),
  );
  const why = await work({ agent: agentFor(gate), job: gate }).then(() => "", (error: Error) => error.message);
  is("a broken gate stops the step and names the call", why, "Deciding whether look could run failed: the rule itself is broken");
  is("and the turn it had already paid for is on the run", db.prepare("select cost from runs where job = 'gate'").get(), { cost: 0.0002 });

  // Refusing without a reason still stops the call, and the model is told
  // something it can act on rather than nothing.
  answers.length = 0;
  answers.push(
    { content: "", tool_calls: [{ id: "1", type: "function", function: { name: "look", arguments: '{"where":"logs"}' } }] },
    "nothing to report",
  );
  const flat = codeJob("flat", async (work) =>
    work.agent("work out what happened", { prompt: "Say why the site went down.", tools: { look }, toolApproval: () => "denied" }),
  );
  const said = await work({ agent: agentFor(flat), job: flat });
  const told = (JSON.parse(row(said.runId).trace) as { calls?: { output: unknown; refused?: boolean }[] }[])[0];
  is("a refusal with no reason given still stops the call", told.calls?.[0].refused, true);
  is("and says so in words the model can use", String(told.calls?.[0].output).includes("it was denied"), true);

  const priced = codeJob("priced", async (work) =>
    work.agent("go round", { prompt: "Spend nothing.", tools: { look }, budget: 0 }),
  );
  const notANumber = await work({ agent: agentFor(priced), job: priced }).then(() => "", (error: Error) => error.message);
  is("a budget that is not an amount is refused before anything runs", notANumber.includes("dollars above zero"), true);

  const nested = codeJob("nested", async (work) =>
    work.step("ask while working", () => work.ask("now?", { question: "Now?", answer: z.boolean() })),
  );
  const refused = await work({ agent: agentFor(nested), job: nested }).then(() => "", (error: Error) => error.message);
  is("a job pauses between steps, not inside one", refused.includes('was called inside the step "ask while working"'), true);
  answers.length = 0;
}

about("a job that waits for a person");
{
  let gathered = 0;
  let restarted = 0;
  const job = codeJob(
    "asking",
    async ({ step, ask, setState, state }) => {
      const down = await step("gather", () => {
        gathered++;
        return ["site"];
      });
      await setState({ down });
      const go = await ask("restart?", { question: `Restart ${down.join(", ")}?`, answer: z.boolean() });
      if (!go) return { skipped: true };
      await step("restart", () => {
        restarted++;
        return "done";
      });
      return { restarted: down, state: state.down };
    },
    z.object({ down: z.array(z.string()).default([]) }),
  );
  const agent = agentFor(job);
  const agents = new Map([[agent.id, agent]]);

  const first = await work({ agent, job });
  is("it parked", first.parked, true);
  is("the question went to the owner, with what fits", sent[0], "somebody: Restart site?\n(yes or no)");
  is("the job is held while it waits", waitingFor("test", "asking"), true);
  is("the person has a question outstanding", waitingOn("test:somebody")?.id, first.runId);
  is("state survived the pause", row(first.runId).state, JSON.stringify({ down: ["site"] }));

  const confused = await answer(first.runId, "maybe later", agents);
  is("an answer that does not fit parks again", confused.parked, true);
  is("and it says so rather than guessing", sent[1].startsWith("somebody: I did not understand that."), true);

  const done = await answer(first.runId, "yes", agents);
  is("it carried on", JSON.parse(done.text).restarted, ["site"]);
  is("the step before the question did not run twice", gathered, 1);
  is("the step after it ran once", restarted, 1);
  is("nothing is waiting now", waitingFor("test", "asking"), false);
  is("the ask is a line in the record", JSON.parse(row(done.runId).trace)[1].kind, "ask");
}

about("an agent step that stops for a person to approve a call");
{
  const paid: number[] = [];
  let gathered = 0;
  const pay = tool({
    description: "Pay.",
    inputSchema: z.object({ amount: z.number() }),
    needsApproval: ({ amount }) => amount > 100,
    execute: async ({ amount }) => {
      paid.push(amount);
      return "paid";
    },
  });
  const both = {
    content: "",
    tool_calls: [
      { id: "1", type: "function", function: { name: "pay", arguments: '{"amount":20}' } },
      { id: "2", type: "function", function: { name: "pay", arguments: '{"amount":240}' } },
    ],
  };
  const job = codeJob("paying", async (work) => {
    await work.step("gather", () => ++gathered);
    return work.agent("pay up", { prompt: "Pay what is owed.", tools: { pay } });
  });
  const agent = agentFor(job);
  const agents = new Map([[agent.id, agent]]);

  startCounting();
  answers.length = 0;
  answers.push(both, "Paid both.");
  const first = await work({ agent, job });
  is("it parked on the call that needs a yes", first.parked, true);
  is("the call before it ran, and that one did not", paid, [20]);
  is("the owner was asked about that call, with what it would do", [sent.at(-1)?.includes('wants to use pay in "pay up"'), sent.at(-1)?.includes('"amount": 240')], [true, true]);
  is("the job is held while it waits", waitingFor("test", "paying"), true);

  const confused = await answer(first.runId, "hmm", agents);
  is("an answer that is not a yes or a no is asked again", [confused.parked, sent.at(-1)?.startsWith("somebody: I did not understand that.")], [true, true]);

  const done = await answer(first.runId, "yes", agents);
  is("a yes runs it, and the step carries on to the end", [paid, done.text], [[20, 240], "Paid both."]);
  is("the step before it did not run again", gathered, 1);
  is("and the model was not asked again for what it had already said", asked, 2);
  const line = (JSON.parse(row(done.runId).trace) as Line[])[1];
  is("the agent step is one line, with every call it made", line.calls?.map((one) => (one.input as { amount: number }).amount), [20, 240]);
  is("priced for both turns, the one before the wait and the one after", line.cost, 0.0004);

  paid.length = 0;
  startCounting();
  answers.push(both, "Paid the small one.");
  const again = await work({ agent, job });
  const said = await answer(again.runId, "no", agents);
  is("a no refuses that call, and the model is told", [paid, said.text], [[20], "Paid the small one."]);
  const refused = (JSON.parse(row(said.runId).trace) as Line[])[1].calls?.[1];
  is("and the refusal is in the record", [refused?.refused, String(refused?.output).includes("the person asked said no")], [true, true]);
  answers.length = 0;
}

about("a step that failed, on a run that carried on past it");
{
  let tried = 0;
  const job = codeJob("stumble", async ({ step, ask }) => {
    let why = "";
    try {
      await step("the thing that fails", () => {
        tried++;
        throw new Error("it did not work");
      });
    } catch (error) {
      why = (error as Error).message;
    }
    return { why, go: await ask("carry on?", { question: "Carry on?", answer: z.boolean() }) };
  });
  const agent = agentFor(job);
  const first = await work({ agent, job });
  is("the step that failed is a line in the record", JSON.parse(row(first.runId).trace)[0].failed, "it did not work");

  const done = await answer(first.runId, "yes", new Map([[agent.id, agent]]));
  is("it did not run again on the way back", tried, 1);
  is("and it failed the same way it failed the first time", JSON.parse(done.text).why, "it did not work");
}

about("nobody answers");
{
  const job = codeJob("lapsing", async ({ ask }) => ({
    deployed: await ask("deploy?", { question: "Deploy?", answer: z.boolean(), within: "30m", otherwise: false }),
  }));
  const agent = agentFor(job);
  const first = await work({ agent, job });
  timePasses(first.runId);
  await sweep(new Map([[agent.id, agent]]));
  is("it carried on with what the ask said to", JSON.parse(row(first.runId).reply), { deployed: false });
  is("and stopped holding its job", waitingFor("test", "lapsing"), false);
}

about("nobody answers, and the ask had nothing to carry on with");
{
  const job = codeJob("stuck", ({ ask }) => ask("ok?", { question: "Ok?", answer: z.boolean(), within: "10m" }));
  const agent = agentFor(job);
  const first = await work({ agent, job });
  timePasses(first.runId);
  await sweep(new Map([[agent.id, agent]]));
  is("the run stopped and said why", String(row(first.runId).error).startsWith("Nobody answered"), true);
  is("and stopped holding its job", waitingFor("test", "stuck"), false);
}

about("the job was edited while a run was waiting");
{
  const before = codeJob("edited", async ({ step, ask }) => {
    await step("one", () => 1);
    return ask("go?", { question: "Go?", answer: z.boolean() });
  });
  const first = await work({ agent: agentFor(before), job: before });
  const after = { ...before, run: async ({ step, ask }: any) => {
    await step("something else", () => 2);
    return ask("go?", { question: "Go?", answer: z.boolean() });
  } } as Job;
  const edited = agentFor(after);
  const result = await answer(first.runId, "yes", new Map([[edited.id, edited]]));
  is("it refused to hand the wrong answer to the wrong step", String(row(result.runId).error).startsWith("This job changed"), true);
}

const shape = z.object({ unhealthy: z.array(z.string()), safe: z.boolean() });
const asking = (id: string) =>
  codeJob(id, async ({ step, model }) => {
    const services = await step("gather", () => [{ name: "one", state: "failed" }]);
    return model("what is wrong", { prompt: JSON.stringify(services), output: id === "wrapped" ? Output.object({ schema: shape }) : shape });
  });

about("a model step that answers in the shape");
{
  startCounting();
  answers.push('```json\n{"unhealthy":["one"],"safe":true}\n```');
  const job = asking("clean");
  const result = await work({ agent: agentFor(job), job });
  const saved = row(result.runId);
  is("a fence around the JSON is not a failure", JSON.parse(result.text), { unhealthy: ["one"], safe: true });
  is("it asked once", asked, 1);
  is("the run now names the model it used", saved.model, "anthropic/claude-haiku-4.5");
  const lines = JSON.parse(saved.trace) as { kind: string; cost: number }[];
  is("the step that did not ask cost nothing", lines[0].cost, 0);
  is("the step that asked carries the cost", lines[1].cost, 0.0002);
  is("and is marked as the model step", lines[1].kind, "model");

  answers.push('{"unhealthy":[],"safe":true}');
  const wrapped = asking("wrapped");
  is("the same schema as the AI SDK's Output.object reads the same", JSON.parse((await work({ agent: agentFor(wrapped), job: wrapped })).text), { unhealthy: [], safe: true });
}

about("a model step that has to be told again");
{
  startCounting();
  answers.push('{"unhealthy":"one","safe":"maybe"}', '{"unhealthy":["one"],"safe":false}');
  const job = asking("retried");
  const result = await work({ agent: agentFor(job), job });
  is("it came back in the shape the second time", JSON.parse(result.text), { unhealthy: ["one"], safe: false });
  is("it asked twice", asked, 2);
  is("both calls are charged to the run", row(result.runId).cost, 0.0004);
}

about("a model step that never fits");
{
  startCounting();
  answers.push("sorry, I cannot help with that", "still not JSON");
  const job = asking("hopeless");
  let threw = "";
  await work({ agent: agentFor(job), job }).catch((error: Error) => {
    threw = error.message;
  });
  is("it gave up rather than passing the text on", threw.startsWith('The model step "what is wrong" did not answer'), true);
  is("after two goes", asked, 2);
  // The money left whether or not the answer was usable, so the run says so
  // rather than reading as free.
  const run = db.prepare("select cost, trace from runs where job = 'hopeless'").get() as { cost: number; trace: string };
  const line = (JSON.parse(run.trace) as { kind: string; cost: number; failed?: string }[])[1];
  is("and the run was charged for both", [run.cost, line.cost], [0.0004, 0.0004]);
  is("with the step it stopped on named", [line.kind, line.failed?.slice(0, 14)], ["model", "The model step"]);
}
