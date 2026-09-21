// What a job does, checked by running it.
//
// A job is code, so it is tested rather than scored: `npm run evals` is for
// the prompts, and this is for the machinery underneath them. Nothing here
// touches the real database or the real gateway. The database is in memory and
// the gateway is a server on a loopback port that answers whatever the case
// says, so a model step is exercised without spending anything.
//
// These are set rather than left to settings.json, because a setting in a file
// applies here too: a box with model.via "claude" would otherwise run every
// case against a real subscription, slowly, and score differently from the
// next box.
process.env.AGENTS_DB = ":memory:";
// A folder of its own, so a case that writes state (an account, a note) cannot
// land in the real one. Set before any import, like the database above.
process.env.AGENTS_STATE = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/chloe-test-`);
process.env.OWNER = "test:somebody";
process.env.AI_GATEWAY_API_KEY = "test";
process.env.MODEL_VIA = "gateway";

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { z } from "zod";

import { about, failed, is } from "#chloe/ops/check.ts";

// A stand-in gateway, up before anything reads AI_GATEWAY_URL. An answer is
// either what the model said, or a whole message when a case needs it to ask
// for a tool.
type Said = string | { content?: string; tool_calls?: unknown[] };
const answers: Said[] = [];
let asked = 0;
/** The messages the last call was sent, for a case that checks what a model was shown. */
let lastAsked: { role: string; content: string }[] = [];
const gateway = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    asked++;
    lastAsked = (JSON.parse(raw || "{}") as { messages?: typeof lastAsked }).messages ?? [];
    const next = answers.shift() ?? "{}";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: typeof next === "string" ? { content: next } : next }],
        usage: { cost: 0.0002, prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
});
await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
process.env.AI_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`;

// Imported after the environment is set, and by hand rather than with a plain
// import, because those are hoisted above the lines above: core/db.ts would
// read AGENTS_DB before it was set and every case would write into the real
// run history. That is not hypothetical, it happened while this was written.
const { reachBy } = await import("chloejs");
const { answer, db, sweep, waitingFor, waitingOn, work } = await import("chloejs");
type Agent = import("chloejs").Agent;
type Job = import("chloejs").Job;

const sent: string[] = [];
reachBy("test", async (to, text) => void sent.push(`${to}: ${text}`));

function codeJob(id: string, run: Job["run"], state?: z.ZodType, summary?: Job["summary"]): Job {
  return { agent: "test", id, cron: "* * * * *", timezone: "UTC", prompt: "", run, state, summary, files: [] };
}

function agentFor(job: Job): Agent {
  return {
    name: "test",
    folder: tmpdir(),
    memory: { folder: `${tmpdir()}/memory-of-test` },
    description: "",
    model: "anthropic/claude-haiku-4.5",
    instructions: "",
    skills: [],
    jobs: [job],
    channels: [],
  };
}

const row = (id: string): any => db.prepare("select * from runs where id = ?").get(id);

/** Push the deadline into the past, which is what waiting does. */
function timePasses(runId: string): void {
  const parked = { ...JSON.parse(row(runId).parked), expires: new Date(Date.now() - 1000).toISOString() };
  db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), runId);
}

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
  is("a job with no summary says nothing, rather than a guess", row(unsaid.runId).summary, null);

  const words = codeJob("words", async () => "**Done.**\n\n- three things\n- all fine");
  const worded = await work({ agent: agentFor(words), job: words });
  is("a string is read as one plain line", row(worded.runId).summary, "Done. three things all fine");

  const broken = codeJob("broken", async () => ({}), undefined, () => {
    throw new Error("no such field");
  });
  const done = await work({ agent: agentFor(broken), job: broken });
  is("a summary that throws does not fail the run", row(done.runId).error, null);
  is("and it says so", row(done.runId).summary, "(its summary failed: no such field)");

  const { recentWork } = await import("#chloe/serve/recentWork.ts");
  const agent = { ...agentFor(counted), name: "recent" };
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

about("an agent step: the goal is yours, the order is the model's");
{
  asked = 0;
  answers.length = 0;
  const { tool } = await import("chloejs");
  const looked: string[] = [];
  const look = tool({
    id: "look",
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
      goal: "Say why the site went down.",
      tools: [look],
      output: z.object({ why: z.string() }),
      maxSteps: 4,
    }),
  );
  const result = await work({ agent: agentFor(job), job });
  is("it ran the tool it was given", looked, ["logs"]);
  is("and answered in the shape", JSON.parse(result.text), { why: "the deploy failed at 03:00" });
  const line = (JSON.parse(row(result.runId).trace) as { kind: string; cost: number; calls?: { tool: string }[] }[])[0];
  is("the run calls it an agent step", line.kind, "agent");
  is("what it ran is written down", line.calls?.map((one) => one.tool), ["look"]);
  is("and both turns are priced", line.cost, 0.0004);
}

about("an agent step that runs out of steps, and one with nothing to call");
{
  asked = 0;
  answers.length = 0;
  const { tool } = await import("chloejs");
  const wander = tool({
    id: "wander",
    description: "Go round again.",
    inputSchema: z.object({}),
    execute: () => "still nothing",
  });
  const asking = { id: "1", type: "function", function: { name: "wander", arguments: "{}" } };
  answers.push({ content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] });

  const capped = codeJob("capped", async (work) =>
    work.agent("go round", { goal: "Find something that is not there.", tools: [wander], maxSteps: 2 }),
  );
  const out = await work({ agent: agentFor(capped), job: capped }).then(() => "finished", (error: Error) => error.message);
  is("it stops and says so rather than looping forever", out.includes("ran out of steps after 2"), true);

  const empty = codeJob("empty", async (work) =>
    work.agent("with nothing", { goal: "Do something.", tools: [] }),
  );
  const refused = await work({ agent: agentFor(empty), job: empty }).then(() => "", (error: Error) => error.message);
  is("an agent step with no tools is a model step, and says so", refused.includes("use model(...)"), true);
  // A capped run leaves whatever it did not use behind it.
  answers.length = 0;
}

about("an agent step kept inside its budget");
{
  asked = 0;
  answers.length = 0;
  const { tool } = await import("chloejs");
  const wander = tool({
    id: "wander",
    description: "Go round again.",
    inputSchema: z.object({}),
    execute: () => "still nothing",
  });
  const asking = { id: "1", type: "function", function: { name: "wander", arguments: "{}" } };
  answers.push({ content: "", tool_calls: [asking] }, { content: "", tool_calls: [asking] });

  // Two turns at $0.0002 each, against a budget that only covers one.
  const job = codeJob("dear", async (work) =>
    work.agent("go round", { goal: "Find something expensive.", tools: [wander], budget: 0.0003, maxSteps: 9 }),
  );
  const result = await work({ agent: agentFor(job), job }).then(() => "finished", (error: Error) => error.message);
  is("it stops on the money, not only on the steps", result.includes("spent $0.0004 of its $0.0003 budget"), true);
  const dear = db.prepare("select cost, trace from runs where job = 'dear'").get() as { cost: number; trace: string };
  is("and the run is charged for what it did spend", dear.cost, 0.0004);
  // A step that failed is still a step that happened, or a budget blowout
  // would say what it cost and not what it spent the money on.
  const line = (JSON.parse(dear.trace) as { kind: string; cost: number; failed?: string; calls?: { tool: string }[] }[])[0];
  is("the step it failed on is still a line", [line.kind, line.cost], ["agent", 0.0004]);
  is("with the calls that spent the money", line.calls?.map((one) => one.tool), ["wander"]);
  is("and why it stopped", line.failed?.includes("budget"), true);

  // The second go at the shape is another turn, so it is the budget's business
  // too: a step with nothing left does not get one.
  answers.length = 0;
  answers.push("that is not the shape");
  const once = codeJob("once", async (work) =>
    work.agent("answer properly", {
      goal: "Say how many.",
      tools: [wander],
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
  asked = 0;
  answers.length = 0;
  const { tool } = await import("chloejs");
  const looked: string[] = [];
  const look = tool({
    id: "look",
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
      goal: "Say why the site went down.",
      tools: [look],
      output: z.object({ why: z.string() }),
      // The tool says it may look. This says where.
      approve: ({ args }) => (args as { where: string }).where === "logs" || "only the logs are yours to read",
      maxSteps: 4,
    }),
  );
  const result = await work({ agent: agentFor(job), job });
  is("the call it was not allowed never ran", looked, ["logs"]);
  const line = (JSON.parse(row(result.runId).trace) as { calls?: { tool: string; result: unknown; refused?: boolean }[] }[])[0];
  is("the refusal is written down beside the call", line.calls?.map((one) => one.refused === true), [true, false]);
  is("and the model was told why", String(line.calls?.[0].result).includes("only the logs are yours to read"), true);
  is("so it tried another way and finished", JSON.parse(result.text), { why: "the deploy failed at 03:00" });
  answers.length = 0;
}

about("an approve that cannot answer, and a question from inside a step");
{
  asked = 0;
  answers.length = 0;
  const { tool } = await import("chloejs");
  const look = tool({
    id: "look",
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
      goal: "Say why the site went down.",
      tools: [look],
      approve: () => {
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
    work.agent("work out what happened", { goal: "Say why the site went down.", tools: [look], approve: () => false }),
  );
  const said = await work({ agent: agentFor(flat), job: flat });
  const told = (JSON.parse(row(said.runId).trace) as { calls?: { result: unknown; refused?: boolean }[] }[])[0];
  is("a refusal with no reason given still stops the call", told.calls?.[0].refused, true);
  is("and says so in words the model can use", String(told.calls?.[0].result).includes("the job did not allow it"), true);

  const priced = codeJob("priced", async (work) =>
    work.agent("go round", { goal: "Spend nothing.", tools: [look], budget: 0 }),
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
  const agents = new Map([[agent.name, agent]]);

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

  const done = await answer(first.runId, "yes", new Map([[agent.name, agent]]));
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
  await sweep(new Map([[agent.name, agent]]));
  is("it carried on with what the ask said to", JSON.parse(row(first.runId).reply), { deployed: false });
  is("and stopped holding its job", waitingFor("test", "lapsing"), false);
}

about("nobody answers, and the ask had nothing to carry on with");
{
  const job = codeJob("stuck", ({ ask }) => ask("ok?", { question: "Ok?", answer: z.boolean(), within: "10m" }));
  const agent = agentFor(job);
  const first = await work({ agent, job });
  timePasses(first.runId);
  await sweep(new Map([[agent.name, agent]]));
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
  const result = await answer(first.runId, "yes", new Map([[edited.name, edited]]));
  is("it refused to hand the wrong answer to the wrong step", String(row(result.runId).error).startsWith("This job changed"), true);
}

const shape = z.object({ unhealthy: z.array(z.string()), safe: z.boolean() });
const asking = (id: string) =>
  codeJob(id, async ({ step, model }) => {
    const services = await step("gather", () => [{ name: "one", state: "failed" }]);
    return model("what is wrong", { prompt: JSON.stringify(services), output: shape });
  });

about("a model step that answers in the shape");
{
  asked = 0;
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
}

about("a model step that has to be told again");
{
  asked = 0;
  answers.push('{"unhealthy":"one","safe":"maybe"}', '{"unhealthy":["one"],"safe":false}');
  const job = asking("retried");
  const result = await work({ agent: agentFor(job), job });
  is("it came back in the shape the second time", JSON.parse(result.text), { unhealthy: ["one"], safe: false });
  is("it asked twice", asked, 2);
  is("both calls are charged to the run", row(result.runId).cost, 0.0004);
}

about("a model step that never fits");
{
  asked = 0;
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

{
  about("settings, and what wins");
  const { readSettings, setting } = await import("chloejs");

  const base = { model: { via: "gateway", judge: "a" } };
  is("a default fills in what no file mentions", readSettings(base, {}).model.gateway, "https://ai-gateway.vercel.sh/v1/chat/completions");
  is("a local file wins over the tracked one", readSettings(base, { model: { via: "claude" } }).model.via, "claude");
  is(
    "and wins one key without clearing its neighbours",
    readSettings(base, { model: { via: "claude" } }).model.judge,
    "a",
  );
  is("a setting nobody set is empty rather than missing", readSettings({}, {}).node, "");
  is("an environment variable beats the files", setting("fromfile", "TEST_SETTING_WINS"), "fromfile");
  process.env.TEST_SETTING_WINS = "fromenv";
  is("once there is one", setting("fromfile", "TEST_SETTING_WINS"), "fromenv");

  let refused = "";
  try {
    readSettings({ model: { via: "telepathy" } }, {});
  } catch (error) {
    refused = error instanceof Error ? error.message.split("\n")[0] : "";
  }
  is("a setting that is not a choice is refused, not ignored", refused, "settings are not valid:");
}

{
  about("what mail says when a person has to sign in");
  const { explain } = await import("#chloe/do/mail.ts");

  // The account is read from settings, which on a real box has a real one in it.
  const { settings } = await import("chloejs");
  const was = settings.google.account;
  delete process.env.GOG_ACCOUNT;
  settings.google.account = "somebody@example.com";

  const keyring = explain("read token: aes.KeyUnwrap(): integrity check failed");
  is(
    "a keyring that will not open hands over the command to paste",
    keyring.includes("gog auth login --account somebody@example.com"),
    true,
  );
  is("and says not to retry", keyring.includes("Do not retry"), true);

  const expired = explain("oauth2: invalid_grant");
  is(
    "so does a sign-in Google has revoked",
    expired.includes("gog auth login --account somebody@example.com"),
    true,
  );

  settings.google.account = "";
  is(
    "with no account set there is nothing to put after --account",
    explain("KeyUnwrap(): integrity check failed").includes("--account"),
    false,
  );

  settings.google.account = was;
  is(
    "a missing keyring password is not a sign-in, so it does not say to sign in",
    explain("GOG_KEYRING_PASSWORD is not set").includes("auth login"),
    false,
  );
}

{
  about("reading a reply from the claude cli");
  // Reaching into the package by path rather than through "chloejs": reading the
  // CLI's replies is the runtime's own business, and this case should move in
  // with it the day chloe becomes its own repo.
  const { readReply } = await import("#chloe/model/claude.ts");

  is("plain words are an answer", readReply("The site is up.").call, undefined);
  const tagged = readReply(
    'Let me look.\n<invoke name="read_notes">\n<parameter name="path">2026</parameter>\n<parameter name="limit">5</parameter>\n</invoke>\n</invoke>\n<invoke name="read_notes">',
    [{ name: "read_notes", description: "", parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } }],
  );
  is("the tag form Claude is trained on is a request too", tagged.call?.function.name, "read_notes");
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
}

{
  about("every agent in this repo still loads");
  const { loadAll } = await import("chloejs");

  // One bad file in a jobs folder takes down every job that agent
  // has, silently: the cron lines simply stop existing. That is how a
  // nightly-backup.test.ts sitting beside the job it tests stopped the backup
  // for as long as nobody looked. Loading them all is the cheapest way to
  // notice.
  const { defineAgent } = await import("chloejs");
  const here = defineAgent({ name: "here", model: "m", description: "", instructions: "Hello." });
  is("an agent's folder is the one it is written in, unless it says", here.folder, import.meta.dirname);
  is("and it can say", defineAgent({ ...here, folder: "/elsewhere" }).folder, "/elsewhere");

  const all = await loadAll().then((found) => found, (error: Error) => error);
  is("every agent loads", all instanceof Error ? all.message : null, null);
  for (const agent of all instanceof Error ? [] : all.values()) {
    // A job is only on the clock if the agent imports it, so one written and
    // never named would sit there looking like a job and never run.
    const named = new Set(agent.jobs.flatMap((one) => one.files));
    const inJobs = await readdir(join(agent.folder, "jobs")).catch(() => [] as string[]);
    const unnamed = inJobs
      .filter((file) => /\.(ts|md)$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => `jobs/${file}`)
      .filter((file) => !named.has(file));
    is(`every job in ${agent.name}'s jobs folder is named in its agent.ts`, unnamed, []);
  }
}

{
  about("when a job runs, written in words");

  const { every, describe, parse } = await import("chloejs/timer");

  // It is a library of its own, so nothing in it may reach into the rest. Found
  // from this file rather than from the repo root, because the runtime is a
  // package and the repo that installed it is somewhere else.
  const timer = join(import.meta.dirname, "../timer");
  const reaching: string[] = [];
  for (const file of await readdir(timer)) {
    const source = await readFile(join(timer, file), "utf8");
    for (const [, from] of source.matchAll(/^(?:import|export)\b[^;]*?\sfrom\s+"([^"]+)"/gm)) {
      if (!from.startsWith("./") && !from.startsWith("node:")) reaching.push(`${file}: ${from}`);
    }
  }
  is("chloejs/timer imports nothing outside itself", reaching, []);
  const said: [string, string, string][] = [
    [every(15).minutes, "*/15 * * * *", "every 15 minutes"],
    [every(4).hours, "0 */4 * * *", "every 4 hours"],
    [every.minute, "* * * * *", "every minute"],
    [every.hour.at(0), "0 * * * *", "every hour"],
    [every.hour.at(30), "30 * * * *", "every hour at :30"],
    [every.day.at("07:00"), "0 7 * * *", "every day at 07:00 UTC"],
    [every.day.at("22:45", "10:45"), "45 10,22 * * *", "every day at 10:45 and 22:45 UTC"],
    [every.weekday.at("9:30"), "30 9 * * 1-5", "weekdays at 09:30 UTC"],
    [every.weekend.at("10:00"), "0 10 * * 0,6", "weekends at 10:00 UTC"],
    [every.monday.at("9:00"), "0 9 * * 1", "mondays at 09:00 UTC"],
    [every.month.on(1).at("09:00"), "0 9 1 * *", "on the 1st of every month at 09:00 UTC"],
  ];
  for (const [written, line, words] of said) {
    is(`${words} is ${line}`, written, line);
    is(`and the clock reads it`, typeof parse(written), "object");
    is(`and it reads back as "${words}"`, describe(written), words);
  }
  // New York moves its clocks and the line does not: 07:00 there is 11:00 UTC
  // in summer and 12:00 UTC in winter, including on the days it changes.
  const { due } = await import("chloejs/timer");
  const seven = parse(every.day.at("07:00"));
  const at = (utc: string) => due(seven, new Date(utc), "America/New_York");
  is("07:00 New York in summer is 11:00 UTC", [at("2026-07-01T11:00:00Z"), at("2026-07-01T12:00:00Z")], [true, false]);
  is("and in winter is 12:00 UTC", [at("2026-01-15T12:00:00Z"), at("2026-01-15T11:00:00Z")], [true, false]);
  is("the morning the clocks go forward", at("2026-03-08T11:00:00Z"), true);
  is("the morning they go back", at("2026-11-01T12:00:00Z"), true);
  is("a zone other than UTC is said by its city", describe("20 23 * * *", "America/New_York"), "every day at 23:20 New York");
  is("a line every() could not have written stays a cron line", describe("0 9 * 1 *"), undefined);

  const refused = (write: () => string) => {
    try {
      return `wrote ${write()}`;
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("a count that does not divide the hour is refused, with what does",
    refused(() => every(7).minutes),
    "every(7).minutes does not divide an hour evenly, so the gaps would not all be the same. It can be 2, 3, 4, 5, 6, 10, 12, 15, 20, 30.");
  is("every(1) points at the plain way to say it", refused(() => every(1).hours), "every(1).hours is every.hour.at(0).");
  is("a time is on a 24 hour clock", refused(() => every.day.at("7am")),
    '"7am" is not a time. Write it on a 24 hour clock, like "07:00" or "22:45".');
  is("two times one cron line cannot hold are refused",
    refused(() => every.day.at("07:00", "19:30")),
    "07:00, 19:30 do not share a minute, and one cron line has only one. Make them two jobs.");
  is("a day of the month some months do not have is refused",
    refused(() => every.month.on(31).at("09:00")),
    "every.month.on(31): the day is 1 to 28, so it happens in every month.");
}

{
  about("a job with no cron line, and one with a bad cron line");

  const { jobsOf, markdownJob } = await import("#chloe/load/load.ts");
  const { startClock } = await import("#chloe/core/clock.ts");
  const folder = await mkdtemp(join(tmpdir(), "chloe-jobs-"));
  await mkdir(join(folder, "jobs"));
  await writeFile(join(folder, "jobs/by-hand.md"), "---\ndescription: Says hello.\n---\n\nSay hello.\n");
  const [byHand] = await jobsOf("test", folder, [markdownJob("jobs/by-hand.md")]);
  is("it loads, with its description", byHand.description, "Says hello.");
  is("its id is the file's name", byHand.id, "by-hand");
  is("and has no cron line", byHand.cron, undefined);

  // The clock ticks once as it starts. A job with a cron line of every minute
  // is due, and the one with none is never due.
  const onTheClock = { ...codeJob("every-minute", async () => "ran"), cron: "* * * * *" };
  const offTheClock = codeJob("when-started", async () => "ran");
  delete offTheClock.cron;
  const clock = startClock(() => new Map([["test", { ...agentFor(onTheClock), jobs: [onTheClock, offTheClock] }]]));
  await new Promise((done) => setTimeout(done, 200));
  clock.stop();
  const ran = (job: string) => db.prepare("select count(*) as n from runs where job = ?").get(job) as { n: number };
  is("the clock runs the one with a cron line", ran("every-minute").n, 1);
  is("and says so in the log", db.prepare("select source from runs where job = 'every-minute'").get(), { source: "schedule" });
  is("and leaves the one without", ran("when-started").n, 0);

  await writeFile(join(folder, "jobs/bad.md"), "---\ncron: 61 * * * *\n---\n\nSay hello.\n");
  const refused = await jobsOf("test", folder, [markdownJob("jobs/bad.md")]).then(() => "", (error: Error) => error.message);
  is("a bad cron line is refused as the agent loads, naming the file", refused.includes("jobs/bad.md has a cron line that does not read"), true);

  const twice = await jobsOf("test", folder, [markdownJob("jobs/by-hand.md"), markdownJob("jobs/by-hand.md")])
    .then(() => "", (error: Error) => error.message);
  is("two jobs with one id are refused", twice, "test: two jobs are called by-hand.");

  const both = await jobsOf("test", folder, [{ id: "both", run: async () => "", markdown: "Say hello." }])
    .then(() => "", (error: Error) => error.message);
  is("a job that is code and a prompt is refused", both, "test job both has both run and markdown. A job is code or a prompt, never both.");
  await rm(folder, { recursive: true, force: true });
}

{
  about("a note two jobs want at the same moment");

  const { STATE, note } = await import("chloejs");
  const shape = z.object({ sites: z.record(z.string(), z.string()) }).catch({ sites: {} });
  const kept = note("test-note", "sites", shape);

  // One site to begin with, so that an empty answer later can only mean a
  // reader caught the file mid-write. On a note that has never been written,
  // empty is the honest answer and proves nothing.
  await kept.write({ sites: { "one.example.com": "200" } });

  const many: Record<string, string> = {};
  for (let i = 0; i < 20_000; i++) many[`host-${i}.example.com`] = "200";

  // A reader gets the whole of the old file or the whole of the new one. Before
  // the write was a rename it could catch the file truncated, and a half file
  // reads as the schema's default: no sites at all, which is a wrong answer
  // that looks like a right one.
  const reads: Array<Promise<{ sites: Record<string, string> }>> = [];
  const writing = kept.write({ sites: many });
  for (let i = 0; i < 200; i++) reads.push(kept.read());
  await writing;
  const counts = (await Promise.all(reads)).map((one) => Object.keys(one.sites).length);
  is("nobody reads a half written note", counts.filter((n) => n !== 1 && n !== 20_000), []);
  is("and the note itself is whole afterwards", Object.keys((await kept.read()).sites).length, 20_000);
  const left = (await readdir(join(STATE, "test-note"))).filter((f) => f.endsWith(".part"));
  is("the temporary file is renamed, not left behind", left, []);
  await rm(join(STATE, "test-note"), { recursive: true, force: true });
}

{
  about("no job reaches for a tool");

  // A tool is for a model only, whether it is one of chloe's or the agent's
  // own. A job that imports one is either doing work through a wrapper built
  // for a model, or it wanted a `do/` folder and took the first import that
  // compiled. The other direction is fine: a tool may call a job's function.
  const { loadAll } = await import("chloejs");
  const found = [];
  for (const agent of (await loadAll()).values()) {
    found.push(...(await readdir(agent.folder, { recursive: true, withFileTypes: true })));
  }
  const reaching: string[] = [];
  for (const file of found) {
    if (!file.isFile() || !file.name.endsWith(".ts")) continue;
    if (!file.parentPath.endsWith("/jobs")) continue;
    const source = await readFile(join(file.parentPath, file.name), "utf8");
    if (source.includes('"chloejs/tools"') || source.includes('"../tools/')) reaching.push(file.name);
  }
  is("every job calls the work itself", reaching, []);
}

// Then whatever the repo that installed chloe tests about its own jobs. A
// file named `<job>.test.ts` anywhere in an agent's folder runs its cases as
// it loads, so there is no list of them to keep and nothing to register.
for (const agent of (await (await import("chloejs")).loadAll()).values()) {
  for (const found of await readdir(agent.folder, { recursive: true, withFileTypes: true })) {
    if (!found.isFile() || !found.name.endsWith(".test.ts")) continue;
    await import(pathToFileURL(join(found.parentPath, found.name)).href);
  }
}

{
  about("the folder the page reads and writes");

  const { editable, open, save, tree } = await import("#chloe/serve/files.ts");
  const { names } = await import("chloejs");
  const agent = (await names())[0];

  const top = await tree(agent);
  is("folders come before files", [...top].sort((a, b) => Number(b.dir) - Number(a.dir)), top);
  is(
    "a folder carries what is under it",
    top.some((entry) => entry.dir && (entry.children?.length ?? 0) > 0),
    true,
  );

  is(
    "what a program made is not part of what an agent is",
    JSON.stringify(top).includes("__pycache__"),
    false,
  );

  is("markdown is written back", editable("skills/one.md"), true);
  is("code is not", editable("units.ts"), false);

  const refused = await save(agent, "units.ts", "//").then(() => null, (error: Error) => error.message);
  is("and save refuses it rather than trusting the page", refused, "units.ts is not markdown.");

  // The page hands over a path, so it is as untrusted as one a model wrote.
  const out = await open(agent, "../../etc/passwd").then(() => null, (error: Error) => error.message);
  is("a path out of the agent's folder does not open", out?.startsWith("Path is outside"), true);
}

{
  about("what a request may send");

  const { body, BadRequest } = await import("#chloe/serve/http.ts");
  const shape = z.object({ text: z.string().trim().min(1) });
  // A stand-in caller: whatever it is handed is the body of one request.
  const server = createServer(async (request, response) => {
    const answer = await body(request, shape).then(
      (value) => ({ value }),
      (error: Error) => ({ refused: error instanceof BadRequest, why: error.message }),
    );
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const send = async (raw: string) =>
    (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: "POST", body: raw })).json();

  is("a body in the shape comes back typed", await send('{"text":" hi "}'), { value: { text: "hi" } });
  is("one that does not fit is refused, saying which field", await send('{"text":5}'), {
    refused: true,
    why: "text Invalid input: expected string, received number",
  });
  is("so is one that is not JSON", await send("not json"), { refused: true, why: "Body is not valid JSON." });
  server.close();
}

{
  about("telegram");
  const { listen } = await import("#chloe/channels/telegram.ts");

  // A stand-in Telegram: each update is handed out once, a file is always the
  // same four bytes, and everything the bot sends is written down.
  const inbox: object[] = [];
  const calls: { method: string; body: any; token: string }[] = [];
  const telegram = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.url!.startsWith("/file/")) return void response.end("PNG!");
      const method = request.url!.split("/").pop()!;
      calls.push({ method, body: JSON.parse(raw || "{}"), token: request.url!.split("/")[1].slice(3) });
      const result =
        method === "getUpdates" ? inbox.splice(0)
        : method === "getMe" ? { id: 999, is_bot: true, username: "testbot" }
        : method === "getFile" ? { file_path: "photos/one.png" }
        : true;
      setTimeout(() => response.end(JSON.stringify({ ok: true, result })), method === "getUpdates" ? 20 : 0);
    });
  });
  await new Promise<void>((done) => telegram.listen(0, "127.0.0.1", done));
  const api = `http://127.0.0.1:${(telegram.address() as { port: number }).port}`;
  const said = () => calls.filter((c) => c.method === "sendMessage").map((c) => `${c.body.chat_id}: ${c.body.text}`);
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const settle = async (count: number) => {
    for (let i = 0; i < 100 && said().length < count; i++) await pause(20);
    await pause(50);
  };
  const me = { id: 7, first_name: "Me" };
  const stranger = { id: 9, first_name: "Stranger" };
  const privately = (id: number, from: object, text: string, more: object = {}) => ({
    update_id: id,
    message: { message_id: id, from, chat: { id: (from as { id: number }).id, type: "private" }, text, ...more },
  });
  const inGroup = (id: number, from: object, text: string, more: object = {}) => ({
    update_id: id,
    message: { message_id: id, from, chat: { id: -100, type: "group", title: "Friends" }, text, ...more },
  });

  const toldAgent: string[] = [];
  const job = codeJob("unused", async () => ({}));
  const agent = agentFor(job);

  const first = listen({ name: "test", token: "t", api, agent: () => agent });
  inbox.push(privately(1, stranger, "hi"));
  await settle(1);
  first.stop();
  // A stopped reader's last poll can still reach the stand-in, which hands
  // messages out once and for all, unlike Telegram. Let it land first.
  await pause(100);
  is("it clears a webhook first, or Telegram refuses to hand out messages", calls.some((c) => c.method === "deleteWebhook"), true);
  is("with nobody allowed yet, a private message is told its user id", said()[0]?.startsWith("9: Your Telegram user id is 9."), true);

  calls.length = 0;
  answers.push("hello from the agent", "seen in the group", "a red square");
  const second = listen({ name: "test", token: "t", api, allowFrom: [7], agent: () => agent });
  // One at a time: two turns at once would take the stand-in model's answers in either order.
  inbox.push(privately(5, stranger, "let me in"), privately(6, me, "hi"));
  await settle(1);
  inbox.push(inGroup(7, me, "just chatting"), inGroup(8, me, "@testbot what now", { entities: [{ type: "mention", offset: 0, length: 8 }] }));
  await settle(2);
  inbox.push(privately(9, me, "", { caption: "what is this?", photo: [{ file_id: "small" }, { file_id: "big", file_size: 4 }] }));
  await settle(3);
  second.stop();
  await pause(100);
  is(
    "an allowed user is answered, in private and in a group that mentions the bot, and a stranger by nobody",
    said(),
    ["7: hello from the agent", "-100: seen in the group", "7: a red square"],
  );
  is("a group message that is not for the bot is left alone", said().length, 3);
  is("an answer in a group replies to the message it answers", calls.find((c) => c.method === "sendMessage" && c.body.chat_id === -100)?.body.reply_parameters, { message_id: 8 });
  is("a photo is fetched at its largest size", calls.find((c) => c.method === "getFile")?.body.file_id, "big");
  const lastTurn = db.prepare("select prompt from runs where source = 'telegram' order by started desc limit 1").get() as { prompt: string };
  is("the agent is told where the message came from", lastTurn.prompt.includes("<telegram_context>"), true);
  is("and that a photo came with it", lastTurn.prompt.includes("(Attached: photo.jpg)"), true);
  is(
    "a bot started again carries on from where the last one got to",
    calls.filter((c) => c.method === "getUpdates")[0]?.body.offset,
    2,
  );

  // A job's question with answers that can be listed arrives as buttons, and a press answers it.
  calls.length = 0;
  const asking = codeJob("buttons", async ({ ask }) => ({ go: await ask("go?", { question: "Go?", answer: z.boolean(), who: "telegram:7" }) }));
  const withJob = agentFor(asking);
  const third = listen({ name: "test", token: "t", api, allowFrom: [7], agent: () => withJob });
  const parked = await work({ agent: withJob, job: asking });
  const question = calls.find((c) => c.method === "sendMessage");
  is("a yes or no question comes with two buttons", question?.body.reply_markup?.inline_keyboard?.[0]?.map((b: { text: string }) => b.text), ["yes", "no"]);
  inbox.push({
    update_id: 20,
    callback_query: {
      id: "q",
      from: me,
      data: "a:0",
      message: { message_id: 50, chat: { id: 7, type: "private" }, text: "Go?", reply_markup: question?.body.reply_markup },
    },
  });
  await settle(2);
  third.stop();
  await pause(100);
  is("pressing one answers the job", JSON.parse(row(parked.runId).reply), { go: true });
  is("and the buttons are taken away", calls.find((c) => c.method === "editMessageText")?.body.text, "Go?\n\n→ yes");

  // The other way for messages to arrive: Telegram sends them, with a secret.
  calls.length = 0;
  answers.push("sent to me");
  const fourth = listen({
    name: "test",
    token: "w",
    api,
    allowFrom: [7],
    mode: "webhook",
    publicUrl: "https://example.com",
    credentials: { webhookSecretToken: "s3cret" },
    agent: () => agent,
  });
  await pause(50);
  is("in webhook mode it registers its own address", calls.find((c) => c.method === "setWebhook")?.body.url, "https://example.com/chloe/v1/test/telegram");
  const route = fourth.routes![0];
  const post = async (secret: string) => {
    let status = 0;
    const body = JSON.stringify(privately(30, me, "over the webhook"));
    const request = Object.assign(
      (async function* () {
        yield body;
      })(),
      { headers: { "x-telegram-bot-api-secret-token": secret } },
    );
    await route.handle(request as any, { writeHead: (s: number) => ((status = s), { end: () => {} }) } as any);
    return status;
  };
  is("a call without the secret is refused", await post("wrong"), 401);
  is("a call with it is taken", await post("s3cret"), 200);
  await settle(1);
  fourth.stop();
  is("and answered the same way", said(), ["7: sent to me"]);
  is("it never polls in webhook mode", calls.some((c) => c.token === "w" && c.method === "getUpdates"), false);

  // A plain message a job answers goes to that job, not to the chat, and with
  // inGroups "always" a group message needs no mention.
  calls.length = 0;
  const { startClock } = await import("#chloe/core/clock.ts");
  const handed: string[] = [];
  const highlights = {
    ...codeJob("highlights", async ({ input }) => (handed.push(String(input.text)), { ok: true }), undefined, () => "Filed."),
    input: z.object({ text: z.string() }),
    answers: (text: string) => text.startsWith("\u201c"),
  } as Job;
  delete highlights.cron;
  const reader = agentFor(highlights);
  const ticking = startClock(() => new Map([["test", reader]]));
  const fifth = listen({ name: "test", token: "j", api, allowFrom: [7], inGroups: "always", agent: () => reader });
  inbox.push(inGroup(40, me, "\u201cA line from a book.\u201d \u2014 A Book"));
  await settle(1);
  fifth.stop();
  ticking.stop();
  await pause(100);
  is("a message a job answers goes to that job, whole", handed, ["\u201cA line from a book.\u201d \u2014 A Book"]);
  is("and its summary is the reply", said(), ["-100: Filed."]);
  const { recall: recalled } = await import("#chloe/model/memory.ts");
  is("and the exchange is kept in that chat's conversation", recalled("test/telegram--100").map((m) => m.content).slice(-2), ["\u201cA line from a book.\u201d \u2014 A Book", "Filed."]);
  is("the / menu is the agent's jobs", calls.find((c) => c.method === "setMyCommands")?.body.commands, [{ command: "highlights", description: "highlights" }]);
  telegram.close();

}

{
  about("the api channel");

  const { apiChannel } = await import("#chloe/channels/api.ts");
  const { recall } = await import("#chloe/model/memory.ts");
  const { serve } = await import("#chloe/serve/http.ts");
  const { makeToken, revokeToken, forgetTokens } = await import("#chloe/serve/tokens.ts");

  // It listens to nothing. What binding it does is give a token permission to
  // reach that agent: the server answers the routes either way.
  const marker = apiChannel().start(() => undefined);
  is("the channel opens no path of its own", marker.routes, undefined);
  marker.stop();

  const open = agentFor(codeJob("nightly", async () => ({})));
  open.channels = [apiChannel()];
  const closed = { ...agentFor(codeJob("nightly", async () => ({}))), name: "closed" };

  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", open], ["closed", closed]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock.ts").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  forgetTokens();
  const { secret, token } = makeToken("a test");
  const asToken = (path: string, body?: string) =>
    fetch(`${at}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      ...(body === undefined ? {} : { body }),
    });

  is("a token reads the agents", (await asToken("/api/agents")).status, 200);
  is("and one agent's configuration", ((await (await asToken("/api/agents/test")).json()) as { api: boolean }).api, true);
  is("which says the other one is not on the api", ((await (await asToken("/api/agents/closed")).json()) as { api: boolean }).api, false);

  answers.push("Three are late.");
  const first = await asToken("/api/agents/test/chat", '{"prompt":"how many orders are late?"}');
  const said = (await first.json()) as { runId: string; text: string; cost: number };
  is("a prompt comes back as what the agent said", [first.status, said.text], [200, "Three are late."]);
  is("with the run it was, and what it cost", [typeof said.runId, said.cost > 0], ["string", true]);
  is("and the run says where it came from", row(said.runId).source, "api");

  // A thread the caller names is its own conversation, kept under this agent
  // so two callers naming the same one cannot land in each other's.
  answers.push("Four now.");
  await asToken("/api/agents/test/chat", '{"prompt":"and now?","thread":"mine"}');
  is("a named thread is remembered under the agent", recall("test/api-mine").map((m) => m.content), ["and now?", "Four now."]);

  // The point of the whole arrangement: binding the channel is what opens it.
  const refused = await asToken("/api/agents/closed/chat", '{"prompt":"hello"}');
  is("an agent with no api channel is shut to a token", [refused.status, ((await refused.json()) as { error: string }).error.includes("no api channel")], [403, true]);
  is("and so is running one of its jobs", (await asToken("/api/agents/closed/job/nightly", "{}")).status, 403);
  is("while the one that binds it may be fired", (await asToken("/api/agents/test/job/nightly", "{}")).status, 200);
  is("a job it does not have is still a 404", (await asToken("/api/agents/test/job/nope", "{}")).status, 404);

  // A token is for reading and for the agents that opted in. Everything else
  // is the account's, and saying so is the whole of the authorisation.
  is("a token cannot write a file", (await asToken("/api/agents/test/file", '{"path":"x.md","content":"hi"}')).status, 403);
  is("nor make another token", (await asToken("/api/tokens", '{"name":"sneaky"}')).status, 403);
  is("nor read an agent's memory", (await asToken("/api/agents/test/memory")).status, 403);

  revokeToken(token.id);
  is("a revoked token stops working", (await asToken("/api/agents")).status, 401);

  server.close();
}

{
  about("runs a stop cut off");

  const { closeCutOff } = await import("#chloe/core/db.ts");
  const insert = db.prepare(
    "insert into runs (id, agent, started, finished, source, model, prompt, parked) values (?, 'stopped', ?, ?, 'x', 'code', '', ?)",
  );
  const now = new Date().toISOString();
  // Earlier cases leave runs open in this database, and they are not what is being counted.
  db.prepare("update runs set finished = coalesce(finished, ?) where parked is null").run(now);
  insert.run("cut", now, null, null);
  insert.run("waiting", now, null, "{}");
  insert.run("done", now, now, null);
  is("one was cut off", closeCutOff(), 1);
  is("it ends, saying why", row("cut").error, "Cut off: the service stopped while this was running.");
  is("a run waiting on a person is left waiting", row("waiting").finished, null);
  is("a finished run is left as it was", row("done").error, null);
}

{
  about("a conversation remembers which tools a reply used");

  const { recall, remember } = await import("#chloe/model/memory.ts");
  remember("test/tools", "user", "What board am I on?");
  remember("test/tools", "assistant", "Board 210.", [
    { tool: "read_page", args: { url: "https://example.com/pairings" } },
    { tool: "write_notes", args: { path: "chess.html", content: "x".repeat(1000) } },
  ]);
  remember("test/tools", "assistant", "Anything else?");
  const told = recall("test/tools", { limit: 10, tools: true });
  is("the next turn sees the calls, then the reply", told.map((one) => one.role), ["user", "assistant", "tool", "tool", "assistant", "assistant"]);
  is("in the shape a turn's own calls take", told[1].tool_calls?.[0].function, { name: "read_page", arguments: '{"url":"https://example.com/pairings"}' });
  is("a whole file written is cut short", JSON.parse(told[1].tool_calls![1].function.arguments).content.length, 303);
  is("each call is answered, or a provider refuses the history", told[2].tool_call_id, told[1].tool_calls?.[0].id);
  is("the reply itself is left as it was", told[4].content, "Board 210.");
  is("a reply that called nothing is too", told[5].content, "Anything else?");
  is("the page shows only the words", recall("test/tools").map((one) => one.content), ["What board am I on?", "Board 210.", "Anything else?"]);

  // How much of a conversation is shown: a count, and an age.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  db.prepare("insert into messages (thread, role, content, at) values ('test/old', 'user', 'long ago', ?)").run(old);
  remember("test/old", "user", "yesterday-ish");
  remember("test/old", "assistant", "just now");
  is("the last few, oldest first", recall("test/old", { limit: 2 }).map((m) => m.content), ["yesterday-ish", "just now"]);
  is("and none older than the days given", recall("test/old", { days: 30 }).map((m) => m.content), ["yesterday-ish", "just now"]);
  is("which are still there when nothing limits the age", recall("test/old").length, 3);

  // What a turn is shown is its channel's chatHistory.
  answers.push("Noted.");
  const { receive } = await import("#chloe/channels/shared.ts");
  const brief = agentFor(codeJob("unused", async () => ({})));
  await receive(brief, { channel: "test", chat: "c", thread: "test/old", from: { id: "1", name: "Me" }, text: "and today?", private: true }, { chatHistory: { messages: 1 } });
  const shownTo = lastAsked.filter((m) => m.role !== "system").map((m) => m.content);
  is("a channel's chatHistory is what a turn on it is shown", shownTo, ["just now", "and today?"]);
}

{
  about("reading a web page");

  const { htmlToText, isPrivate, readPage } = await import("chloejs");
  const html =
    "<!doctype html><html><head><title>Wall &amp; chart</title><style>td{}</style></head><body>\n" +
    "<table>\n<tr><td><a href=\"report.php?section=Novice - under 900\">Novice</a></td>\n<td>239</td></tr>\n" +
    "<tr><td>Sapp,&nbspNalani</td><td>W&nbsp120</td></tr></table><script>alert(1)</script></body></html>";
  const read = htmlToText(html, "https://example.com/events/");
  is("the title is read", read.title, "Wall & chart");
  is(
    "a row is one line, a link keeps its full address, and scripts are gone",
    read.text,
    "[Novice](https://example.com/events/report.php?section=Novice%20-%20under%20900) | 239\nSapp, Nalani | W 120",
  );
  is("loopback is private", isPrivate("127.0.0.1"), true);
  is("a home network is private", isPrivate("192.168.1.20"), true);
  is("loopback written as IPv6 is private", isPrivate("::ffff:127.0.0.1"), true);
  is("loopback carried in IPv6 as hex is private", isPrivate("::ffff:7f00:1"), true);
  is("a home network translated to IPv6 is private", isPrivate("64:ff9b::c0a8:114"), true);
  is("link local IPv6 is private", isPrivate("fe80::1"), true);
  is("a public address is not", isPrivate("104.21.3.4"), false);
  is("a public IPv6 address is not", isPrivate("2606:4700::6810:84e5"), false);
  const hexLoopback = await readPage("http://[::ffff:7f00:1]:3067/").then(() => "read", (error: Error) => error.message);
  is("loopback in IPv6 hex is refused", hexLoopback, "[::ffff:7f00:1] is a private address, and those are not read.");
  const byName = await readPage("http://localhost:3067/").then(() => "read", (error: Error) => error.message);
  is("a name that resolves to loopback is refused when connecting", byName, "localhost is a private address, and those are not read.");
  const refused = await readPage("http://127.0.0.1:3067/").then(() => "read", (error: Error) => error.message);
  is("this box's own ports are refused", refused, "127.0.0.1 is a private address, and those are not read.");
}

{
  about("a copy of the agents' database");

  const { copyDatabase } = await import("chloejs");
  const { DatabaseSync } = await import("node:sqlite");
  const { tmpdir } = await import("node:os");
  const to = join(tmpdir(), `copy-${process.pid}`, "agents.db");
  const copied = await copyDatabase(to);
  const opened = new DatabaseSync(to, { readOnly: true });
  const count = (from: typeof db) => (from.prepare("select count(*) as n from runs").get() as { n: number }).n;
  is("it is written where it was asked for", copied.path, to);
  is("it opens, and holds every run", count(opened), count(db));
  opened.close();
  await rm(join(tmpdir(), `copy-${process.pid}`), { recursive: true, force: true });
}

{
  about("the login in front of the page");

  const { createAccount, hasAccount, setCookie, signIn, signedIn } = await import("#chloe/serve/login.ts");
  const carrying = (cookie: string) => ({ headers: { cookie } }) as import("node:http").IncomingMessage;

  is("a fresh copy has no account", hasAccount(), false);
  createAccount("somebody", "a long enough one");
  is("the first visit makes it", hasAccount(), true);

  const refused = (() => {
    try {
      createAccount("nobody", "another long one");
      return "made a second";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("and every visit after it is refused", refused, "An account already exists.");

  const session = signIn("somebody", "a long enough one", "1.2.3.4");
  is("the right password signs in", signedIn(carrying(`chloe_session=${session}`)), true);
  is("a cookie somebody edited does not", signedIn(carrying(`chloe_session=${session.slice(0, -1)}x`)), false);
  is("no cookie does not", signedIn(carrying("")), false);
  is("signing out clears it", setCookie("", true).includes("Max-Age=0"), true);

  // The same value said the other way, for a caller that is not a browser.
  const bearing = (authorization: string) => ({ headers: { authorization } }) as import("node:http").IncomingMessage;
  is("the same value as a bearer signs in", signedIn(bearing(`Bearer ${session}`)), true);
  is("and the word is not case sensitive", signedIn(bearing(`bearer ${session}`)), true);
  is("a bearer somebody edited does not", signedIn(bearing(`Bearer ${session.slice(0, -1)}x`)), false);
  is("an empty bearer does not", signedIn(bearing("Bearer ")), false);
  is("and another scheme does not", signedIn(bearing(`Basic ${session}`)), false);

  const wrong = (() => {
    try {
      signIn("somebody", "not the password", "1.2.3.4");
      return "signed in";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("the wrong password does not", wrong, "Wrong username or password.");

  for (let tries = 0; tries < 5; tries++) {
    try {
      signIn("somebody", "not the password", "9.9.9.9");
    } catch {
      // Counting the failures is the point; the message is checked above.
    }
  }
  const locked = (() => {
    try {
      signIn("somebody", "a long enough one", "9.9.9.9");
      return "signed in";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("guessing over and over locks that address out", locked.startsWith("Too many tries."), true);
  is("and only that one", Boolean(signIn("somebody", "a long enough one", "1.2.3.4")), true);
}

{
  about("the API without a browser");

  // About the runtime on its own, so the runtime's own site is the one being
  // asked. Whether a page package happens to be installed in this repo is not
  // what these are testing, and letting it decide would make them drift.
  process.env.CHLOE_PAGE = "builtin";
  const { serve } = await import("#chloe/serve/http.ts");
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map(),
    clock: { fire() {} } as unknown as import("#chloe/core/clock.ts").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const asked = await fetch(`${at}/api/account`);
  is("whether an account exists is answered with no session", [asked.status, await asked.json()], [200, { exists: true }]);

  const shut = await fetch(`${at}/api/agents`);
  is("and everything else is still shut", [shut.status, await shut.json()], [401, { error: "Sign in first." }]);

  const got = await fetch(`${at}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "somebody", password: "a long enough one" }),
  });
  const { token } = (await got.json()) as { token?: string };
  is("signing in hands back a token", typeof token === "string" && token.length > 0, true);
  is("and sets the cookie as well", (got.headers.get("set-cookie") ?? "").startsWith("chloe_session="), true);

  const held = await fetch(`${at}/api/agents`, { headers: { authorization: `Bearer ${token ?? ""}` } });
  is("the token opens the door the cookie opens", held.status, 200);

  const made = await fetch(`${at}/api/agents`, { headers: { authorization: "Bearer not.a.token" } });
  is("one this copy did not sign does not", made.status, 401);

  // The site is the account's. A token opens the API and not a browser
  // session, so the page it would be shown is the way in instead.
  const root = await fetch(`${at}/`, { redirect: "manual" });
  is("the root sends somebody with no session to the way in", [root.status, root.headers.get("location")], [303, "/login"]);
  const header = await fetch(`${at}/`, { redirect: "manual", headers: { authorization: `Bearer ${token ?? ""}` } });
  is("the account's own session opens it, however it is carried", header.status, 200);

  const signedIn = await fetch(`${at}/`, { redirect: "manual", headers: { cookie: `chloe_session=${token ?? ""}` } });
  is("as the cookie a browser sends", signedIn.status, 200);
  is("which says what is loaded", (await signedIn.text()).includes("agent"), true);

  const docs = await fetch(`${at}/api`, { headers: { accept: "text/html" } });
  is("the docs are open, because they are about the API and not in it", docs.status, 200);
  const listed = (await (await fetch(`${at}/api`)).json()) as { path: string }[];
  is("and the same list comes back as JSON", listed.some((one) => one.path === "/api/agents/:name/chat"), true);
  is("every route it answers is in that list", listed.length > 15, true);

  server.close();
}

{
  about("a channel's own path, through the server");

  process.env.CHLOE_PAGE = "builtin";
  const { serve } = await import("#chloe/serve/http.ts");

  // A channel that is sent its messages, as telegram's webhook mode is, gets
  // its path handed to it before the login. The api channel is not one of
  // these any more, so this stands in for the shape rather than using it.
  let reached = 0;
  const reachable = agentFor(codeJob("unused", async () => ({})));
  const route = {
    path: "/chloe/v1/test/hook",
    async handle(_request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
      reached += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  };
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", reachable]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock.ts").Clock,
    channels: () => [route],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  is("the runtime hands a channel its path with no session at all", (await fetch(`${at}${route.path}`, { method: "POST", body: "{}" })).status, 200);
  is("and it really was the channel that answered", reached, 1);

  // Only POST is handed over, so the same path asked any other way is not a
  // path this server has. It is not /api, so the site answers it.
  is("its path is not open to a GET", (await fetch(`${at}${route.path}`, { redirect: "manual" })).status, 303);

  server.close();
}

{
  about("what a job is started with");

  const { work: runJob, checkInput, WrongInput } = await import("#chloe/core/steps.ts");

  const takes = z.object({
    text: z.string().min(1),
    from: z.string().default("somewhere"),
    times: z.coerce.number().default(1),
  });

  let saw: unknown;
  const reader = agentFor({
    ...codeJob("reading", async (w) => {
      saw = w.input;
      return { got: (w.input as { text: string }).text };
    }),
    input: takes,
  } as Job);

  await runJob({ agent: reader, job: reader.jobs[0], input: { text: "a highlight" } });
  is("the job is handed what it was started with", saw, { text: "a highlight", from: "somewhere", times: 1 });

  await runJob({ agent: reader, job: reader.jobs[0], input: { text: "x", from: "telegram", times: "3" } });
  is("a query string's strings are coerced by the shape", saw, { text: "x", from: "telegram", times: 3 });

  // The point of checking before the run exists: the caller is told, rather
  // than left to read a failed run to find out.
  const refused = (sent: unknown) => {
    try {
      checkInput(reader.jobs[0], sent);
      return "allowed";
    } catch (error) {
      return error instanceof WrongInput ? "refused" : "wrong error";
    }
  };
  is("a missing required field is refused", refused({}), "refused");
  is("and so is the wrong type", refused({ text: 5 }), "refused");
  is("what fits is allowed", refused({ text: "fine" }), "allowed");

  // A job that declares nothing takes nothing. Quietly dropping what somebody
  // sent would read as the job ignoring them.
  const plain = agentFor(codeJob("plain", async () => ({})));
  const sentAnyway = await runJob({ agent: plain, job: plain.jobs[0], input: { text: "hello" } })
    .then(() => "allowed")
    .catch((error: unknown) => (error instanceof WrongInput ? "refused" : "wrong error"));
  is("a job with no input shape is not started with one", sentAnyway, "refused");
  is("and starting it with nothing is fine", (await runJob({ agent: plain, job: plain.jobs[0] })).steps >= 0, true);

  // Written on the run row rather than held in memory, which is what lets a
  // run that stopped to ask somebody come back to the same input.
  const kept = await runJob({ agent: reader, job: reader.jobs[0], input: { text: "kept" } });
  is("the run records what it was started with", JSON.parse(row(kept.runId).input), { text: "kept", from: "somewhere", times: 1 });
  is("and a run the clock started records nothing", row((await runJob({ agent: plain, job: plain.jobs[0] })).runId).input, "{}");
}

{
  about("starting a job over the API");

  const { serve } = await import("#chloe/serve/http.ts");
  const { apiChannel } = await import("#chloe/channels/api.ts");
  const { makeToken, forgetTokens } = await import("#chloe/serve/tokens.ts");

  process.env.CHLOE_PAGE = "builtin";
  let started: unknown;
  const agent = agentFor({
    ...codeJob("reading", async (w) => {
      started = w.input;
      return {};
    }),
    input: z.object({ text: z.string().min(1), source: z.string().default("") }),
  } as Job);
  agent.channels = [apiChannel()];

  const fired: { job: string; input: unknown; channel?: string }[] = [];
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", agent]]),
    clock: {
      fire(_a: Agent, j: Job, input?: unknown, channel?: string) {
        fired.push({ job: j.id, input, channel });
        return Promise.resolve(undefined);
      },
      running: () => [],
    } as unknown as import("#chloe/core/clock.ts").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  forgetTokens();
  const { secret } = makeToken("a test");
  const start = (query: string, body?: string) =>
    fetch(`${at}/api/agents/test/job/reading${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      ...(body === undefined ? {} : { body }),
    });

  is("a query string starts it", (await start("?text=a+highlight&source=myapp")).status, 200);
  is("and is what the job is handed", fired.at(-1)?.input, { text: "a highlight", source: "myapp" });
  is("on the api channel", fired.at(-1)?.channel, "api");

  is("a JSON body does too", (await start("", '{"text":"from a body"}')).status, 200);
  is("and wins where they overlap", (await start("?text=query", '{"text":"body"}')).status, 200);
  is("the body being the one that counts", (fired.at(-1)?.input as { text: string }).text, "body");
  const byHand = await fetch(`${at}/api/agents/test/job/reading?text=x`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-chloe-channel": "terminal" },
  });
  is("npm run agent says it is the terminal", [byHand.status, fired.at(-1)?.channel], [200, "terminal"]);
  fired.pop();

  // Started and not awaited, so a caller that sent the wrong thing has to be
  // told now or it never finds out.
  const wrong = await start("?source=myapp");
  is("input that does not fit is refused before anything runs", wrong.status, 400);
  is("with the reason", ((await wrong.json()) as { error: string }).error.includes("text"), true);
  is("and nothing was started", fired.length, 3);

  is("a job that agent does not have is still a 404", (await start("").then(() => fetch(`${at}/api/agents/test/job/nope`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }))).status, 404);

  delete process.env.CHLOE_PAGE;
  server.close();
}

{
  about("who a request is really from");

  const { from } = await import("#chloe/serve/login.ts");
  const asking = (headers: Record<string, string>) =>
    from({ headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as import("node:http").IncomingMessage);

  is("with nothing in front, it is the socket", asking({}), "127.0.0.1");

  // Every hop appends, so the end of the list is what the proxy in front saw
  // and the front of it is whatever the caller sent. Reading the front lets a
  // stranger choose which address gets locked out, including somebody else's.
  is("one proxy in front, and it is what that proxy saw", asking({ "x-forwarded-for": "203.0.113.7" }), "203.0.113.7");
  is("a chain reads from the end, not the start", asking({ "x-forwarded-for": "203.0.113.7, 172.68.1.1" }), "172.68.1.1");
  is("so a forged entry at the front is ignored", asking({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), "203.0.113.7");

  // Cloudflare overwrites this one rather than appending to it, so a client
  // cannot put anything in it. That makes it worth more than the list.
  is("Cloudflare's own header wins", asking({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1, 172.68.1.1" }), "203.0.113.9");
  is("and a forged copy of it is still only the first entry of its own list", asking({ "cf-connecting-ip": "203.0.113.9, 1.2.3.4" }), "203.0.113.9");
}

{
  about("an agent's memory, and the log of what was served");

  const { mkdir: makeDir, writeFile: put, readFile: get } = await import("node:fs/promises");
  const { serve } = await import("#chloe/serve/http.ts");
  const { makeToken, forgetTokens } = await import("#chloe/serve/tokens.ts");
  const { memoryFolder } = await import("#chloe/load/load.ts");

  const folder = `${process.env.AGENTS_STATE}/memory-under-test`;
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
  process.env.CHLOE_PAGE = "builtin";

  // Every agent has a memory. Unsaid, it is the agent's own state folder,
  // which is where the memory tool has always written.
  is("unsaid, an agent's memory is its own state folder", memoryFolder("tempo"), `${process.env.AGENTS_STATE}/tempo`);
  is("said, it is wherever the agent says", memoryFolder("chloe", { folder: "/somewhere" }), "/somewhere");

  const keeper: Agent = { ...agentFor(codeJob("unused", async () => ({}))), memory: { folder, label: "Private" } };
  const other: Agent = {
    ...agentFor(codeJob("unused", async () => ({}))),
    name: "other",
    memory: { folder: `${process.env.AGENTS_STATE}/other-has-never-written` },
  };

  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map([["test", keeper], ["other", other]]),
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock.ts").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const { token } = (await (
    await fetch(`${at}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "somebody", password: "a long enough one" }),
    })
  ).json()) as { token: string };
  const as = { cookie: `chloe_session=${token}` };
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
  await put(`${process.env.AGENTS_STATE}/NOT-IN-MEMORY.txt`, "never shown");
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
  is("the log is kept outside the memory it records", (await get(`${process.env.AGENTS_STATE}/memory-audit/test.jsonl`, "utf8")).length > 0, true);

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
  const outer = `${process.env.AGENTS_STATE}/outer-repo`;
  await makeDir(`${outer}/agents`, { recursive: true });
  await makeDir(`${outer}/data/tempo`, { recursive: true });
  const quiet = { cwd: outer, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q", "-b", "main"], quiet);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], quiet);
  await put(`${outer}/agents/someone-elses-work.ts`, "half done");
  await put(`${outer}/data/tempo/journal.md`, "a day");

  const inside: Agent = { ...agentFor(codeJob("unused", async () => ({}))), name: "inside", memory: { folder: `${outer}/data/tempo` } };
  const { memoryGit, memoryCommit } = await import("#chloe/serve/memory.ts");
  is("a memory inside another repo is not a repo", (await memoryGit(inside)).repo, false);
  const tried = await memoryCommit(inside, "tidy up", "test").then(() => "committed", (error: Error) => error.message);
  is("so commit refuses rather than committing that repo's work", tried, "This memory is not a git repository.");
  is("and nothing was committed in the other repo", execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: outer, encoding: "utf8" }).trim(), "1");
  is("whose work is still sitting there uncommitted", execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: outer, encoding: "utf8" }).includes("agents/someone-elses-work.ts"), true);

  // One that is the top of its own repository is one.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: `${outer}/data/tempo`, stdio: "ignore" });
  is("a memory that is the top of its own repo is one", (await memoryGit(inside)).repo, true);

  delete process.env.CHLOE_PAGE;
  server.close();
}

{
  about("a page a package offers");

  const { installedPage, pageIn } = await import("#chloe/serve/page.ts");

  // A node_modules of its own, holding one package that declares a page. The
  // runtime never names a package: it looks for the declaration.
  const modules = await mkdtemp(join(tmpdir(), "chloe-page-"));
  await mkdir(`${modules}/zod`, { recursive: true });
  await writeFile(`${modules}/zod/package.json`, JSON.stringify({ name: "zod" }));
  await mkdir(`${modules}/some-dashboard/dist`, { recursive: true });
  await writeFile(`${modules}/some-dashboard/package.json`, JSON.stringify({ name: "some-dashboard", chloePage: "dist" }));
  await writeFile(`${modules}/some-dashboard/dist/index.html`, '<div id="app"></div>');
  await writeFile(`${modules}/some-dashboard/dist/page.js`, "");

  const found = pageIn(modules);
  is("it finds the package that declares one", found?.name, "some-dashboard");
  is("and serves the folder that package named", found?.dir.endsWith("/dist"), true);
  is("a folder with no packages offers nothing", pageIn(`${modules}/nowhere`), null);

  process.env.CHLOE_PAGE = "builtin";
  is("and it can be told to use the runtime's own instead", installedPage(), null);
  delete process.env.CHLOE_PAGE;

  // What it serves. A file that is there is the file. Everything else is one of
  // the page's own addresses, including one with a dot in it: an address inside
  // the page can name a file that lives somewhere else entirely.
  const { servePageFile } = await import("#chloe/serve/page.ts");
  const served = async (path: string) => {
    let type = "";
    let body = "";
    const response = {
      writeHead: (_status: number, headers: Record<string, string>) => ((type = headers["content-type"]), response),
      end: (chunk: Buffer | string) => void (body = String(chunk)),
    };
    await servePageFile(response as never, found!, path);
    return { type, page: body.includes('id="app"') };
  };
  is("its own script is its own script", (await served("/page.js")).type.startsWith("text/javascript"), true);
  is("an address of the page's is the page", (await served("/agents/chloe/log")).page, true);
  is("and so is one that names a file somewhere else", (await served("/agents/chloe/memory/02_areas/chess/curriculum.html")).page, true);
  is("but it will not hand out a file from outside its folder", (await served("/../../package.json")).page, true);
  await rm(modules, { recursive: true, force: true });
}

{
  about("what the page adds to a note");

  const { withHead } = await import("#chloe/serve/memory.ts");
  const add = '<link rel="stylesheet" href="/notes.css">';
  is("first inside the note's own head", withHead("<html><head><title>x</title></head></html>", add), `<html><head>\n${add}<title>x</title></head></html>`);
  is("not inside a header that is not a head", withHead("<!doctype html><header>h</header>", add), `<!doctype html>\n${add}<header>h</header>`);
  is("a head of its own when there is html and no head", withHead('<html lang="en"><p>x</p></html>', add), `<html lang="en">\n<head>${add}</head><p>x</p></html>`);
  is("and nothing at all when the page adds nothing", withHead("<p>x</p>", ""), "<p>x</p>");
}

await rm(process.env.AGENTS_STATE, { recursive: true, force: true });
gateway.close();
console.log(failed() === 0 ? "\nAll clear." : `\n${failed()} to fix above.`);
process.exit(failed() === 0 ? 0 : 1);
