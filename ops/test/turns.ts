// Runs that stopped part way, and what a conversation remembers.

import { isStepCount, tool } from "ai";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import type { Job } from "./shared.ts";
import { agentFor, answers, asked, codeJob, db, lastAsked, lastTools, row } from "./shared.ts";

{
  about("runs a stop cut off");

  const { closeCutOff, going } = await import("#chloe/core/db");
  const insert = db.prepare(
    "insert into runs (id, agent, started, finished, source, model, prompt, parked) values (?, 'stopped', ?, ?, 'x', 'code', '', ?)",
  );
  const now = new Date().toISOString();
  // Earlier cases leave runs open in this database, and they are not what is being counted.
  db.prepare("update runs set finished = coalesce(finished, ?) where parked is null").run(now);
  insert.run("cut", now, null, null);
  insert.run("waiting", now, null, "{}");
  insert.run("done", now, now, null);
  is("a stop waits for the one going, and not the one waiting on a person", going(), 1);
  is("one was cut off", closeCutOff(), 1);
  is("and then none is going", going(), 0);
  is("it ends, saying why", row("cut").error, "Cut off: the service stopped while this was running.");
  is("a run waiting on a person is left waiting", row("waiting").finished, null);
  is("a finished run is left as it was", row("done").error, null);
}

{
  about("a job's prompt the service stopped carries on from where it was");

  const { CUT_OFF } = await import("#chloe/core/db");
  const { carryOn, stopped } = await import("#chloe/core/turn");
  const looked: string[] = [];
  const look = tool({
    description: "Look in one place.",
    inputSchema: z.object({ where: z.string() }),
    execute: ({ where }) => void looked.push(where),
  });
  const job: Job = { agent: "test", id: "morning", timezone: "UTC", prompt: "Look around.", files: [] };
  const agent = { ...agentFor(job), tools: { look } };
  // Two answers: one whose call finished, then one cut off while its first of two calls ran.
  const trace = [
    { step: 0, at: "", say: "Start with the logs.", wants: ["look"], cost: 0.1 },
    { step: 0, at: "", tool: "look", args: { where: "logs" }, result: "all quiet" },
    { step: 1, at: "", say: "Now the site.", wants: ["look", "look"], cost: 0.1 },
  ];
  const context = [
    { role: "system", content: "You are a test." },
    { role: "user", content: "Look around." },
  ];
  const insert = db.prepare(
    "insert into runs (id, agent, started, finished, source, job, model, prompt, kind, error, context, trace) values (?, 'test', ?, ?, 'schedule', ?, 'anthropic/claude-haiku-4.5', '', ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  insert.run("stopped-turn", now, now, "morning", "turn", CUT_OFF, JSON.stringify(context), JSON.stringify(trace));
  insert.run("failed-turn", now, now, "morning", "turn", "the model said no", JSON.stringify(context), "[]");
  insert.run("stopped-chat", now, now, null, "turn", CUT_OFF, JSON.stringify(context), "[]");

  let why = "";
  try {
    stopped("failed-turn");
  } catch (error) {
    why = (error as Error).message;
  }
  is("a run that failed on its own does not carry on", why, "Only a run the service stopped in the middle of, or one that ran out of steps, can carry on.");
  why = "";
  try {
    stopped("stopped-chat");
  } catch (error) {
    why = (error as Error).message;
  }
  is("nor does a conversation", why, "Only a job's prompt can carry on, and this run is not one.");

  answers.length = 0;
  answers.push("All done.");
  const result = await carryOn({ agent, runId: "stopped-turn" });
  const shown = lastAsked as { role: string; content: string; tool_calls?: { function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  is("it is handed what it began with, then what it did", shown.map((one) => one.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
  is("with the call that finished, as it was made", shown[2].tool_calls?.map((one) => [one.function.name, one.function.arguments]), [["look", '{"where":"logs"}']]);
  is("and what it said back", shown[3].content, "all quiet");
  is("the answer cut off keeps its words and no calls", [shown[4].content, shown[4].tool_calls], ["Now the site.", undefined]);
  is("and it is told what did not finish", shown[5].content.includes("You had asked for look, look, which did not finish"), true);
  is("the same run finishes", [result.runId, row("stopped-turn").finished !== null, row("stopped-turn").error, row("stopped-turn").reply], ["stopped-turn", true, null, "All done."]);
  const after = JSON.parse(row("stopped-turn").trace) as { step: number; say?: string; carried?: string }[];
  is("the record says where it picked up", after.filter((one) => one.carried).map((one) => one.step), [2]);
  is("its steps and spending count from before", [result.steps, after.at(-1)?.step, after.at(-1)?.say], [3, 2, "All done."]);
  is("nothing ran again by itself", looked, []);
  why = "";
  try {
    stopped("stopped-turn");
  } catch (error) {
    why = (error as Error).message;
  }
  is("and once finished it does not carry on twice", why, "Only a run the service stopped in the middle of, or one that ran out of steps, can carry on.");
}

{
  about("a job's prompt that ran out of steps carries on with as many again");

  const { carryOn, canCarryOn } = await import("#chloe/core/turn");
  const job: Job = { agent: "test", id: "morning", timezone: "UTC", prompt: "Look around.", files: [] };
  const agent = { ...agentFor(job), stopWhen: isStepCount(2) };
  const trace = [
    { step: 0, at: "", say: "Start with the logs.", wants: ["skillRead"], cost: 0.1 },
    { step: 0, at: "", tool: "skillRead", args: { name: "none" }, result: "No skill called none." },
    { step: 1, at: "", say: "Now the site.", wants: ["skillRead"], cost: 0.1 },
    { step: 1, at: "", tool: "skillRead", args: { name: "none" }, result: "No skill called none." },
  ];
  const context = [
    { role: "system", content: "You are a test." },
    { role: "user", content: "Look around." },
  ];
  const now = new Date().toISOString();
  db.prepare(
    "insert into runs (id, agent, started, finished, source, job, model, prompt, kind, error, context, trace) values ('tired-turn', 'test', ?, ?, 'schedule', 'morning', 'anthropic/claude-haiku-4.5', '', 'turn', 'Stopped after 2 steps without finishing.', ?, ?)",
  ).run(now, now, JSON.stringify(context), JSON.stringify(trace));
  is("the page is told why it can carry on", canCarryOn("tired-turn"), "out of steps");

  answers.length = 0;
  answers.push({ content: "One more look.", tool_calls: [{ id: "c1", type: "function", function: { name: "skillRead", arguments: '{"name":"none"}' } }] }, "All done.");
  const result = await carryOn({ agent, runId: "tired-turn" });
  const shown = lastAsked as { role: string; content: string }[];
  is("it is told it ran out of steps", shown.at(-3)?.content.startsWith("You ran out of steps"), true);
  is("and gets as many steps again, not what was left", [result.text, row("tired-turn").error, row("tired-turn").reply], ["All done.", null, "All done."]);
  const after = JSON.parse(row("tired-turn").trace) as { step: number; carried?: string }[];
  is("the record says it was given more", after.find((one) => one.carried)?.carried, "It ran out of steps here, and was given as many again to carry on.");
  is("its steps count from before", result.steps, 4);
}

{
  about("a conversation remembers which tools a reply used");

  const { recall, remember } = await import("#chloe/model/memory");
  remember("test/tools", "user", "What board am I on?");
  remember("test/tools", "assistant", "Board 210.", [
    { toolName: "webReadPage", input: { url: "https://example.com/pairings" } },
    { toolName: "memoryWriteFile", input: { path: "chess.html", content: "x".repeat(1000) } },
  ]);
  remember("test/tools", "assistant", "Anything else?");
  const told = recall("test/tools", { limit: 10, tools: true });
  is("the next turn sees the calls, then the reply", told.map((one) => one.role), ["user", "assistant", "tool", "tool", "assistant", "assistant"]);
  is("in the shape a turn's own calls take", told[1].tool_calls?.[0].function, { name: "webReadPage", arguments: '{"url":"https://example.com/pairings"}' });
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
  const { receive } = await import("#chloe/channels/shared");
  const brief = agentFor(codeJob("unused", async () => ({})));
  const askedBefore = asked;
  await receive(brief, { channel: "test", chat: "c", thread: "test/old", from: { id: "1", name: "Me" }, text: "and today?", private: true }, { chatHistory: { messages: 1 } });
  const shownTo = lastAsked.filter((m) => m.role !== "system").map((m) => m.content);
  is("a channel's chatHistory is what a turn on it is shown", shownTo, ["just now", "and today?"]);
  answers.push("Fresh start.");
  const cleared = await receive(brief, { channel: "test", chat: "c", thread: "test/old", from: { id: "1", name: "Me" }, text: "/clear", private: true });
  is("/clear confirms the conversation was cleared", cleared?.text, "Conversation cleared.");
  is("/clear does not ask the model", asked, askedBefore + 1);
  is("/clear leaves this chat with no recalled messages", recall("test/old"), []);
  await receive(brief, { channel: "test", chat: "c", thread: "test/old", from: { id: "1", name: "Me" }, text: "new topic", private: true });
  is("the next message starts without the old conversation", lastAsked.filter((m) => m.role !== "system").map((m) => m.content), ["new topic"]);
  const context = JSON.parse((db.prepare("select context from runs order by started desc limit 1").get() as { context: string }).context);
  is("the run keeps the messages the model saw", context.map((one: { role: string; content: string }) => [one.role, one.content]), [
    ["system", (lastAsked.find((one) => one.role === "system")?.content ?? "")],
    ["user", "new topic"],
  ]);
  const system = lastAsked.find((m) => m.role === "system")?.content ?? "";
  is("a turn on a channel is told who it is talking to, and to say you", system.includes('You are talking with Me on test, directly. Write to them as "you"'), true);
  is("and not that its lines on the way are sent, when they are not", system.includes("sent to them straight away"), false);

  // What the model writes on its way to an answer is sent as it goes only when
  // the channel asks for it, and always before the answer.
  const look = { id: "1", type: "function", function: { name: "look_around", arguments: "{}" } };
  const onTheWay: string[] = [];
  const talk = (sendWhileWorking: boolean) =>
    receive(brief, { channel: "test", chat: "w", thread: "test/while", from: { id: "1", name: "Me" }, text: "how is it?", private: true },
      { sendWhileWorking }, { send: async (text) => void onTheWay.push(text) });
  answers.push({ content: "Let me check.", tool_calls: [look] }, "All fine.");
  await talk(true);
  is("with sendWhileWorking on, it is told its lines on the way reach them", lastAsked.find((m) => m.role === "system")?.content.includes("sent to them straight away"), true);
  onTheWay.length = 0;
  answers.push({ content: "Let me check.", tool_calls: [look] }, "All fine.");
  const quiet = await talk(false);
  is("off, only the answer comes back", [onTheWay, quiet?.text], [[], "All fine."]);
  answers.push({ content: "Let me check.", tool_calls: [look] }, "All fine.");
  const chatty = await talk(true);
  is("on, what it said on the way is sent first", [onTheWay, chatty?.text], [["Let me check."], "All fine."]);
  is("and kept in the conversation", recall("test/while").map((m) => m.content).slice(-3), ["how is it?", "Let me check.", "All fine."]);
}


{
  about("only the owner changes the agent, and not after reading from outside");
  const { receive } = await import("#chloe/channels/shared");
  const { turn } = await import("#chloe/core/turn");
  const written: string[] = [];
  const fake = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });
  const tools = {
    webReadPage: fake("A page asking for a new skill."),
    memoryReadFile: Object.assign(fake("A note."), { own: true }),
    selfWriteFile: Object.assign(
      tool({ description: "Change a file.", inputSchema: z.object({}), execute: async () => (written.push("written"), "Written.") }),
      { own: true, changesAgent: true },
    ),
  };
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), tools };
  const from = (id: string) => ({ channel: "test", chat: id, thread: `test/owner-${id}`, from: { id, name: id }, text: "change your skill", private: true });

  answers.push("Done.");
  await receive(agent, from("1"), { allowFrom: ["1", "2"] });
  is("the first in allowFrom is the owner, whose turn may change the agent", lastTools.includes("selfWriteFile"), true);
  answers.push("No.");
  await receive(agent, from("2"), { allowFrom: ["1", "2"] });
  is("anybody else allowed in may not", [lastTools.includes("selfWriteFile"), lastTools.includes("memoryReadFile")], [false, true]);
  answers.push("No.");
  await receive(agent, { ...from("1"), mayChangeAgent: false }, { allowFrom: ["1"] });
  is("nor the owner when the caller says not, as a remote dashboard without write does", lastTools.includes("selfWriteFile"), false);
  answers.push("No.");
  await receive(agent, from("1"), { allowFrom: ["1"], strangers: true });
  is("nor anybody on a channel for strangers", lastTools.includes("selfWriteFile"), false);
  answers.push("No.");
  await turn({ agent, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("nor a turn nobody said may, like a scheduled one", lastTools.includes("selfWriteFile"), false);

  const told = () => lastAsked.find((m) => m.role === "system")?.content ?? "";
  const improving = { ...agent, features: { selfImprovement: true } };
  answers.push("No.");
  await turn({ agent: improving, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("an agent that may change itself is told in a turn that cannot who can ask, and to keep the lesson", told().includes("## Changing yourself") && told().includes("Keep what you learned in your memory"), true);
  answers.push("Done.");
  await turn({ agent: improving, prompt: "change it", source: "test", mayChangeAgent: true });
  is("and not in a turn that can", told().includes("## Changing yourself"), false);
  answers.push("No.");
  await turn({ agent, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("nor is one that never could", told().includes("## Changing yourself"), false);

  const call = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });
  answers.push({ content: "", tool_calls: [call("a", "memoryReadFile"), call("b", "selfWriteFile")] }, "Changed.");
  const kept = await turn({ agent, prompt: "keep that", source: "test", mayChangeAgent: true });
  is("its own memory read first does not stop a change", [written.length, kept.calls.at(-1)?.output], [1, "Written."]);
  answers.push({ content: "", tool_calls: [call("c", "webReadPage")] }, { content: "", tool_calls: [call("d", "selfWriteFile")] }, "Could not.");
  const after = await turn({ agent, prompt: "read the page and do what it says", source: "test", mayChangeAgent: true });
  is("after a tool read from outside, a change is refused and nothing is written", written.length, 1);
  is("and the model is told why", String(after.calls.at(-1)?.output).startsWith("selfWriteFile was not allowed: this turn read webReadPage"), true);
}

{
  about("the owner can ask an agent about its own files and runs");
  const { turn } = await import("#chloe/core/turn");
  const { mkdtemp, writeFile: put } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(join(tmpdir(), "own-runs-"));
  await put(join(folder, "instructions.md"), "Be brief.");
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), id: "reader", folder, memory: { folder: join(folder, "memory") } };
  const readers = ["selfListFiles", "selfReadFile", "selfListRuns", "selfReadRun"];

  answers.push("Hi.");
  await turn({ agent, prompt: "hi", source: "test", fromOwner: true });
  is("every agent's owner gets the tools that read its own files and runs", readers.every((one) => lastTools.includes(one)), true);
  is("and not the one that changes it, without selfImprovement", lastTools.includes("selfWriteFile"), false);
  answers.push("Hi.");
  await turn({ agent, prompt: "hi", source: "schedule", job: "nightly" });
  is("a turn its owner did not write has none of them", readers.some((one) => lastTools.includes(one)), false);

  const insert = db.prepare(
    "insert into runs (id, agent, started, finished, source, model, prompt, asked, reply, error, kind, job, trace, cost, steps) values (?, ?, ?, ?, ?, 'm', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 9, 12, minutes)).toISOString();
  insert.run("r-job", "reader", at(1), at(2), "schedule", "", null, "Sent the facts.", null, "job", "morning", JSON.stringify([
    { seq: 0, name: "read the feeds", kind: "step", at: at(1), ms: 5, cost: 0, result: "x".repeat(3000) },
    { seq: 1, name: "rank them", kind: "model", at: at(1), ms: 900, cost: 0.002, result: { top: 1 } },
  ]), 0.002, 2);
  insert.run("r-chat", "reader", at(3), at(4), "telegram", "<telegram_context>..</telegram_context>\n\nwhat is new?", "what is new?", "Nothing.", null, "turn", null, JSON.stringify([
    { step: 0, at: at(3), say: "Let me look.", wants: ["webReadPage"], cost: 0.01 },
    { step: 0, at: at(3), tool: "webReadPage", args: { url: "https://example.com" }, result: "A page." },
    { step: 1, at: at(3), say: "Nothing.", wants: [], cost: 0.01 },
  ]), 0.02, 2);
  insert.run("r-failed", "reader", at(5), at(6), "schedule", "", null, null, "Feed down.", "job", "morning", "[]", 0, 0);
  insert.run("r-eval", "reader", at(7), at(8), "eval", "", null, "x", null, "turn", null, "[]", 0, 0);
  insert.run("r-other", "someone-else", at(9), at(9), "schedule", "", null, "theirs", null, "job", "morning", "[]", 0, 0);

  const { listOwnRuns, readOwnRun } = await import("#chloe/services/ownRunsService");
  // The turns above are runs of this agent too, and newer.
  const listed = listOwnRuns("reader").runs.filter((one) => String(one.id).startsWith("r-"));
  is("its runs are listed newest first, its own only and no eval's", listed.map((one) => one.id), ["r-failed", "r-chat", "r-job"]);
  is("as facts, without anything said in them", Object.keys(listed[1]).sort(), ["cost", "finished", "id", "job", "source", "started", "steps"]);
  is("a failed one says so", listed[0].failed, true);
  is("one job's, or the conversations", [listOwnRuns("reader", { job: "morning" }).runs.length, listOwnRuns("reader", { job: "chat" }).runs.map((one) => one.id).filter((id) => String(id).startsWith("r-"))], [2, ["r-chat"]]);
  const job = readOwnRun("reader", "r-job");
  is("a job's run shows its steps, with long results cut short", [job.steps.length, String((job.steps[0] as { result?: unknown }).result).endsWith("...[3000 characters]")], [2, true]);
  is("and what it answered", job.reply, "Sent the facts.");
  const chat = readOwnRun("reader", "r-chat");
  is("a conversation's shows what was asked, not the channel's wrapping", chat.asked, "what is new?");
  is("and what it said on the way and each call, the reply once", chat.steps, [{ said: "Let me look." }, { tool: "webReadPage", args: { url: "https://example.com" }, result: "A page." }]);
  is("a failed run says why", readOwnRun("reader", "r-failed").error, "Feed down.");
  const refused = (id: string) => {
    try {
      readOwnRun("reader", id);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("another agent's run is not there", refused("r-other").startsWith("You have no run"), true);
  is("nor an eval's", refused("r-eval").startsWith("You have no run"), true);

  const { readOwn } = await import("#chloe/services/ownFilesService");
  const own = await readOwn(agent, undefined, "instructions.md");
  is("without selfImprovement it reads its files and is told it cannot change them", [own.content, own.canWrite, own.why?.includes("selfImprovement")], ["Be brief.", false, true]);

  const written: string[] = [];
  const writer = { ...agent, tools: { selfWriteFile: Object.assign(tool({ description: "Change a file.", inputSchema: z.object({}), execute: async () => (written.push("x"), "Written.") }), { own: true, forOwner: true, changesAgent: true }) } };
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  answers.push({ content: "", tool_calls: [call("l", "selfListRuns", {}), call("f", "selfReadFile", { path: "instructions.md" }), call("w", "selfWriteFile", {})] }, "Done.");
  await turn({ agent: writer, prompt: "change it", source: "test", mayChangeAgent: true });
  is("listing its runs and reading its files does not stop a change", written.length, 1);
  answers.push({ content: "", tool_calls: [call("r", "selfReadRun", { id: "r-chat" }), call("w2", "selfWriteFile", {})] }, "Could not.");
  const after = await turn({ agent: writer, prompt: "fix what went wrong", source: "test", mayChangeAgent: true });
  is("reading a run does, because what it read from outside is in it", [written.length, String(after.calls.at(-1)?.output).includes("this turn read selfReadRun")], [1, true]);
}

{
  about("a sign-in is the runtime's to run, never the model's");

  const { NeedsSignIn } = await import("#chloe/connections/connection");
  const { receive } = await import("#chloe/channels/shared");
  const { recall } = await import("#chloe/model/memory");
  const link = "https://accounts.example/approve?scope=mail+files&state=s1";
  let signedIn = false;
  const shop: import("@chloejs/core").Connection = {
    name: "shop",
    does: "The shop's orders.",
    settings: [],
    signIn: {
      start: async () => ({ say: "Open this link and send me the code.", link }),
      answers: (text) => text.startsWith("code-"),
      finish: async (text) => {
        if (text !== "code-right") throw new Error("Google did not take that code.");
        signedIn = true;
        return "Signed in to the shop.";
      },
    },
    missing: async () => (signedIn ? [] : ["nobody has signed in"]),
  };
  const orders = Object.assign(
    tool({
      description: "Read the orders.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!signedIn) throw new NeedsSignIn("shop", "The shop cannot be reached: nobody has signed in.");
        return ["one late order"];
      },
    }),
    { needs: shop },
  );
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), tools: { shopReadOrders: orders } };
  const call = { id: "1", type: "function", function: { name: "shopReadOrders", arguments: "{}" } };
  const chat = (text: string) =>
    receive(agent, { channel: "test", chat: "s", thread: "test/sign-in", from: { id: "1", name: "Me" }, text, private: true });

  answers.push({ content: "", tool_calls: [call] });
  const before = asked;
  const first = await chat("any late orders?");
  is("a tool that needs a sign-in stops the turn, with no second model call", asked, before + 1);
  is("and the reply is what failed, the connection's words, and its link as it made it", first?.text, `The shop cannot be reached: nobody has signed in.\n\nOpen this link and send me the code.\n\n${link}`);

  const wrong = await chat("code-wrong");
  is("an answer the connection refuses is said, and no model is asked", [wrong?.text, asked], ["Google did not take that code.", before + 1]);

  answers.push({ content: "", tool_calls: [call] }, "One order is late.");
  const done = await chat("code-right");
  is("the right one signs in, then what was asked is asked again", done?.text, "Signed in to the shop.\n\nOne order is late.");
  is("the code is kept out of the conversation", recall("test/sign-in").some((one) => one.content.includes("code-right")), false);

  signedIn = false;
  const { turn } = await import("#chloe/core/turn");
  answers.push({ content: "", tool_calls: [call] });
  const alone = await turn({ agent, prompt: "any late orders?", source: "schedule" });
  is("a run with nobody to answer starts no sign-in, and says who can", alone.text.includes("signs in from a chat") && !alone.text.includes(link), true);
}

{
  about("a channel's tools and job");
  const { bind, receive } = await import("#chloe/channels/shared");
  const { startClock } = await import("#chloe/core/clock");
  const fake = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });
  const own = { shopOrders: fake("Orders."), ownerMail: fake("The owner's mail."), memoryReadFile: fake("A note."), selfWriteFile: fake("Its own file.") };
  const shop = { ...agentFor(codeJob("unused", async () => ({}))), tools: own };

  is("a tool is named by the tool itself, and read as its name", bind(shop, "email", { tools: [own.shopOrders, "ownerMail"] }).tools, ["shopOrders", "ownerMail"]);
  const refusal = (options: Parameters<typeof bind>[2]) => {
    try {
      bind(shop, "email", options);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("a tool that is not one of the agent's stops it loading", refusal({ tools: [fake("Elsewhere.")] }).includes("not in its tools"), true);

  // A channel's job is named on the channel, and the agent loads it from there.
  const { defineAgent, defineJob } = await import("@chloejs/core");
  const { tmpdir } = await import("node:os");
  const { resolveAgent } = await import("#chloe/load/load");
  const { commands } = await import("#chloe/channels/shared");
  const replying = defineJob({ id: "reply", description: "Replies.", run: async () => "Hi." });
  const loading = (job: unknown, jobs: unknown[] = []) =>
    resolveAgent(
      defineAgent({
        id: "desk",
        description: "",
        instructions: "Hello.",
        model: "m",
        folder: tmpdir(),
        jobs: jobs as never,
        channels: [
          { name: "first", job, start: () => ({ stop: () => {} }) },
          { name: "second", job, start: () => ({ stop: () => {} }) },
        ] as never,
      }),
    ).then(
      (agent) => agent,
      (error: Error) => error.message,
    );
  const loaded = await loading(replying);
  is(
    "a channel's job is one of the agent's jobs, once, with each channel that names it",
    typeof loaded === "string" ? loaded : loaded.jobs.map((one) => [one.id, one.channels]),
    [["reply", ["first", "second"]]],
  );
  is("and no channel offers it as a command", typeof loaded === "string" ? loaded : commands(loaded).some((one) => one.command === "reply"), false);
  is("one also in its jobs stops the agent loading", String(await loading(replying, [replying])).includes("also in its jobs"), true);
  is("so does one that is a prompt", String(await loading(defineJob({ id: "said", description: "", markdown: "Say hi." } as never))).includes("is a prompt"), true);
  is("and one with a cron line", String(await loading(defineJob({ id: "timed", description: "", cron: "0 9 * * *", run: async () => "" }))).includes("cron line"), true);

  answers.push("Order 12 ships Monday.");
  await receive(shop, { channel: "test", chat: "t", thread: "test/tools-named", from: { id: "1", name: "Me" }, text: "where is it?", private: true }, { tools: ["shopOrders"] });
  is(
    "a turn has the tools named, its memory and its skills, and nothing else",
    [lastTools.includes("shopOrders"), lastTools.includes("memoryReadFile"), lastTools.includes("skillRead"), lastTools.includes("ownerMail"), lastTools.includes("selfWriteFile")],
    [true, true, true, false, false],
  );
  answers.push("Hello.");
  await receive(shop, { channel: "test", chat: "t", thread: "test/tools-stranger", from: { id: "v", name: "a visitor" }, text: "hi", private: true }, { tools: ["shopOrders"], strangers: true });
  is("a stranger's turn has only what is named", [lastTools.includes("shopOrders"), lastTools.includes("memoryReadFile"), lastTools.includes("skillRead")], [true, false, false]);

  // A job that holds each run open until the case lets it go.
  const inputs: { text: string; userId: string; from: string }[] = [];
  const going: (() => void)[] = [];
  const answer = {
    ...codeJob("answer", async ({ input }) => {
      inputs.push({ text: input.text, userId: input.userId, from: input.from });
      await new Promise<void>((done) => going.push(done));
      return `Thanks, ${input.userId}.`;
    }),
  } as Job;
  delete answer.cron;
  const desk = { ...agentFor(answer), tools: own };
  const ticking = startClock(() => new Map([["test", desk]]));
  const from = (who: string, text: string) =>
    receive(desk, { channel: "email", chat: who, thread: `test/${who}`, from: { id: who, name: who }, text, private: true }, { job: "answer" });
  const asking = asked;
  const first = from("ann@shop.test", "/model gpt-5");
  const second = from("bob@shop.test", "Where is my order?");
  for (let i = 0; i < 50 && inputs.length < 2; i++) await new Promise((done) => setTimeout(done, 10));
  is("every message starts the job, with who sent it, and a slash is only text", inputs, [
    { text: "/model gpt-5", userId: "ann@shop.test", from: "email" },
    { text: "Where is my order?", userId: "bob@shop.test", from: "email" },
  ]);
  is("two conversations are answered side by side", ticking.running().length, 2);
  const again = await from("ann@shop.test", "Hello?");
  is("a second message in one conversation still being answered is told to wait", again?.text, "I am still answering your last message. Send this one again once I have.");
  for (const done of going.splice(0)) done();
  is("what the job returns is the reply", [(await first)?.text, (await second)?.text], ["Thanks, ann@shop.test.", "Thanks, bob@shop.test."]);
  is("and no model was asked for any of it", asked, asking);
  ticking.stop();
}
