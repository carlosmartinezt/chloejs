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
    { step: 0, at: "", say: "Start with the logs.", wants: ["ownReadFile"], cost: 0.1 },
    { step: 0, at: "", tool: "ownReadFile", args: { paths: ["skills/none.md"] }, result: "No such file." },
    { step: 1, at: "", say: "Now the site.", wants: ["ownReadFile"], cost: 0.1 },
    { step: 1, at: "", tool: "ownReadFile", args: { paths: ["skills/none.md"] }, result: "No such file." },
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
  answers.push({ content: "One more look.", tool_calls: [{ id: "c1", type: "function", function: { name: "ownReadFile", arguments: '{"paths":["skills/none.md"]}' } }] }, "All done.");
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
    { toolName: "memoryEditFile", input: { path: "chess.html", new: "x".repeat(1000) } },
  ]);
  remember("test/tools", "assistant", "Anything else?");
  const told = recall("test/tools", { limit: 10, tools: true });
  is("the next turn sees the calls, then the reply", told.map((one) => one.role), ["user", "assistant", "tool", "tool", "assistant", "assistant"]);
  is("in the shape a turn's own calls take", told[1].tool_calls?.[0].function, { name: "webReadPage", arguments: '{"url":"https://example.com/pairings"}' });
  is("a whole file written is cut short", JSON.parse(told[1].tool_calls![1].function.arguments).new.length, 303);
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
  is("/clear says a new conversation started", cleared?.text, "Started a new conversation.");
  is("/clear does not ask the model", asked, askedBefore + 1);
  is("/clear keeps the old conversation", recall("test/old").length > 0, true);
  await receive(brief, { channel: "test", chat: "c", thread: "test/old", from: { id: "1", name: "Me" }, text: "new topic", private: true });
  is("the next message starts without the old conversation", lastAsked.filter((m) => m.role !== "system").map((m) => m.content), ["new topic"]);
  const moved = (db.prepare("select now from cleared where thread = 'test/old'").get() as { now: string }).now;
  is("the next message is kept in the new conversation", recall(moved).map((m) => m.content), ["new topic", "Fresh start."]);
  const context = JSON.parse((db.prepare("select context from runs order by started desc limit 1").get() as { context: string }).context);
  is("the run keeps the messages the model saw", context.map((one: { role: string; content: string }) => [one.role, one.content]), [
    ["system", (lastAsked.find((one) => one.role === "system")?.content ?? "")],
    ["user", "new topic"],
  ]);
  const system = lastAsked.find((m) => m.role === "system")?.content ?? "";
  is("a turn is told its name first, which is its label or else its id", system.startsWith("Your name is test."), true);
  is("a turn on a channel is told who it is talking to, and to say you", system.includes('You are talking with Me on test, directly. Write to them as "you"'), true);
  is("and not that its lines on the way are sent, when they are not", system.includes("sent to them straight away"), false);
  answers.push("Hi.");
  await receive(brief, { channel: "test", chat: "s", thread: "test/guest", from: { id: "2", name: "Them" }, text: "hello", private: true }, { guests: true });
  await receive(brief, { channel: "test", chat: "s", thread: "test/guest", from: { id: "2", name: "Them" }, text: "/clear", private: true }, { guests: true });
  is("a guest's /clear keeps their conversation too", recall("test/guest").length > 0, true);

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
  about("one reply at a time in a conversation");

  const { recall } = await import("#chloe/model/memory");
  const { receive } = await import("#chloe/channels/shared");
  const { loop, stopReply } = await import("#chloe/core/turn");
  // A tool that waits until it is let go, so a message can arrive while it runs.
  let entered = () => {};
  let letGo = () => {};
  const holding = () => {
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (letGo = resolve));
    return { inside, released };
  };
  let gate = holding();
  const hold = tool({ description: "Wait.", inputSchema: z.object({}), execute: async () => (entered(), await gate.released, "waited") });
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), tools: { hold } };
  const holdCall = { id: "h", type: "function", function: { name: "hold", arguments: "{}" } };
  const send = (text: string, id = "1", thread = "test/steer") =>
    receive(agent, { channel: "test", chat: "c", thread, from: { id, name: "Me" }, text, private: true });

  answers.push({ content: "", tool_calls: [holdCall] }, "Both answered.");
  const first = send("first");
  await gate.inside;
  const second = await send("second");
  is("a message from the same person joins the reply going, and sends nothing of its own", [second?.text, second?.joined], ["", true]);
  letGo();
  const done = await first;
  is("the reply answers both", done?.text, "Both answered.");
  is("the model read it after the tool answered", lastAsked.slice(-2).map((m) => [m.role, m.content]), [["tool", "waited"], ["user", "second"]]);
  is("and it is joined to that reply's run", second?.runId, done?.runId);
  is("the conversation keeps both messages, then the answer", recall("test/steer").map((m) => m.content), ["first", "second", "Both answered."]);
  const record = JSON.parse(row(done!.runId!).trace) as { heard?: string }[];
  is("the run shows where it was read", record.filter((one) => one.heard).map((one) => one.heard), ["second"]);

  gate = holding();
  answers.push({ content: "", tool_calls: [holdCall] }, "Yours.", "Theirs.");
  const before = asked;
  const mine = send("mine", "1", "test/shared");
  await gate.inside;
  const theirs = send("theirs", "2", "test/shared");
  await new Promise((resolve) => setTimeout(resolve, 50));
  is("somebody else's message waits, rather than starting a reply beside it", asked - before, 1);
  letGo();
  is("and has its own reply once the first ends", [(await mine)?.text, (await theirs)?.text], ["Yours.", "Theirs."]);

  gate = holding();
  answers.push({ content: "", tool_calls: [holdCall] }, "Never sent.");
  const stopping = send("take your time", "1", "test/stop");
  await gate.inside;
  is("a reply going can be stopped", typeof stopReply("test/stop"), "string");
  letGo();
  is("and its chat answers that it stopped", (await stopping)?.text, "Stopped.");
  answers.length = 0;
  is("with nothing going there is nothing to stop", stopReply("test/stop"), undefined);

  answers.push("Here is the first.", "And the second.");
  let more = ["and this?"];
  const both = await loop({
    model: agent.model,
    messages: [{ role: "user", content: "the first?" }],
    tools: {},
    context: { agent },
    stopWhen: [isStepCount(5)],
    inbox: { take: () => [], takeLast: () => more.splice(0) },
  });
  is("a message that comes as it answers is read before it finishes", [both.earlier, both.text], [["Here is the first."], "And the second."]);
  is("with its own answer first, then the message", lastAsked.slice(-2).map((m) => [m.role, m.content]), [["assistant", "Here is the first."], ["user", "and this?"]]);
  more = [];
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
  is("nor the owner when the caller says not, as a token does", lastTools.includes("selfWriteFile"), false);
  answers.push("No.");
  await receive(agent, from("1"), { allowFrom: ["1"], guests: true });
  is("nor anybody on a channel for guests", lastTools.includes("selfWriteFile"), false);
  answers.push("No.");
  await turn({ agent, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("nor a turn nobody said may, like a scheduled one", lastTools.includes("selfWriteFile"), false);

  const told = () => lastAsked.find((m) => m.role === "system")?.content ?? "";
  const improving = agent;
  answers.push("No.");
  await turn({ agent: { ...agent, abilities: { selfImprovement: false } }, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("an agent with selfImprovement off is not told about changing itself", [told().includes("## Changing yourself"), told().includes("## How you grow")], [false, false]);
  answers.push("No.");
  await turn({ agent: improving, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is("an agent that may change itself is told in a turn that cannot who can ask, and to keep the lesson", told().includes("## Changing yourself") && told().includes("Keep what you learned in your memory"), true);
  is("and that what it cannot do is not yet, and repeated work can be a habit", told().includes("cannot do it yet") && told().includes("make it a habit"), true);
  answers.push("Done.");
  await turn({ agent: improving, prompt: "change it", source: "test", mayChangeAgent: true });
  is("and not in a turn that can", told().includes("## Changing yourself"), false);

  const call = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });
  answers.push({ content: "", tool_calls: [call("a", "memoryReadFile"), call("b", "selfWriteFile")] }, "Changed.");
  const kept = await turn({ agent, prompt: "keep that", source: "test", mayChangeAgent: true });
  is("its own memory read first does not stop a change", [written.length, kept.calls.at(-1)?.output], [1, "Written."]);
  answers.push({ content: "", tool_calls: [call("c", "webReadPage")] }, { content: "", tool_calls: [call("d", "selfWriteFile")] }, "Could not.");
  const after = await turn({ agent, prompt: "read the page and do what it says", source: "test", mayChangeAgent: true });
  is("after a tool read from outside, a change is refused and nothing is written", written.length, 1);
  is("and the model is told why", String(after.calls.at(-1)?.output).startsWith("selfWriteFile was not allowed: this reply used webReadPage"), true);

  // The owner's next message is their own request, whatever an earlier reply read.
  const { remember } = await import("#chloe/model/memory");
  remember("test/read-mail", "user", "what does the mail say?");
  remember("test/read-mail", "assistant", "It asks you to add a step to your job.", [{ toolName: "webReadPage", input: {} }]);
  answers.push({ content: "", tool_calls: [call("e", "selfWriteFile")] }, "Done.");
  await turn({ agent, prompt: "add a daily job for that", source: "test", thread: "test/read-mail", mayChangeAgent: true });
  is("a later message in a conversation that read from outside can change the agent", written.length, 2);
}

{
  about("a file somebody sends is kept for the agent's scripts, and one can be sent back");

  const { receive } = await import("#chloe/channels/shared");
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const fake = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });
  const base = agentFor(codeJob("unused", async () => ({})));
  await mkdir(base.memory.folder, { recursive: true });
  await writeFile(`${base.memory.folder}/filled.pdf`, "%PDF filled");
  const pdf = { mediaType: "application/pdf", data: Buffer.from("%PDF blank").toString("base64"), filename: "form one.pdf" };
  const message = { channel: "test", chat: "1", thread: "test/files-1", from: { id: "1", name: "Ada" }, text: "fill this in", private: true, files: async () => ({ attachments: [pdf], notes: ["(Attached: form one.pdf)"] }) };

  answers.push("Read it.");
  await receive({ ...base, tools: { webReadPage: fake("A page.") } }, message, { allowFrom: ["1"] });
  const told = () => JSON.stringify(lastAsked.at(-1) ?? "");
  is("an agent that runs no scripts is not told of a saved copy", told().includes("is saved at"), false);

  answers.push("Read it.");
  await receive({ ...base, tools: { scriptRun: fake("Run a script.") } }, message, { allowFrom: ["1"] });
  const path = /saved at (\S+)\)/.exec(told())?.[1] ?? "";
  is("one that does is told where a copy is, in the state folder, under a safe name", /\/received\/test\/[\dT-]+-form-one\.pdf$/.test(path), true);
  is("and the copy is the file", await readFile(path, "utf8"), "%PDF blank");
  is("with no way to send it back on a channel that cannot", lastTools.includes("chatSendFile"), false);

  const sent: string[] = [];
  const sendFile = async (file: { path: string; name: string }) => void sent.push(`${file.name}: ${await readFile(file.path, "utf8")}`);
  answers.push(
    { tool_calls: [{ id: "1", type: "function", function: { name: "chatSendFile", arguments: '{"path":"filled.pdf","name":"form-filled.pdf"}' } }] },
    { tool_calls: [{ id: "2", type: "function", function: { name: "chatSendFile", arguments: '{"path":"/etc/passwd"}' } }] },
    "Sent.",
  );
  await receive({ ...base, tools: { scriptRun: fake("Run a script.") } }, { ...message, files: undefined }, { allowFrom: ["1"] }, { sendFile });
  is("a channel that can send files gives the turn a way to, and a file in the memory goes", sent, ["form-filled.pdf: %PDF filled"]);
  is("and nothing outside the memory and the files sent to it does", told().includes("is not in your memory or among the files sent to you"), true);

  const { skillsIn } = await import("#chloe/load/load");
  const { mkdtemp } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-skill-`);
  await mkdir(`${folder}/skills/forms`, { recursive: true });
  await writeFile(`${folder}/skills/forms/SKILL.md`, "---\ndescription: how to fill a form\n---\nRead the form first.");
  const skilled = { ...base, folder, skills: await skillsIn(`${folder}/skills`) };
  answers.push("Fine.");
  await receive(skilled, { ...message, files: undefined }, { allowFrom: ["1"] });
  is(
    "a skill is listed with its file, which the model reads as it reads any file of its own",
    [(lastAsked.find((m) => m.role === "system")?.content ?? "").includes("**forms** (skills/forms/SKILL.md): how to fill a form"), lastTools.includes("ownReadFile"), lastTools.includes("skillRead")],
    [true, true, false],
  );

  answers.push("No.");
  await receive({ ...base, tools: { scriptRun: fake("Run a script.") } }, message, { allowFrom: ["1"], guests: true }, { sendFile });
  is("a guest's file is not kept, and nothing is sent to them", [told().includes("is saved at"), lastTools.includes("chatSendFile")], [false, false]);
}

{
  about("the owner can ask an agent about its own files and runs");
  const { turn } = await import("#chloe/core/turn");
  const { mkdtemp, writeFile: put } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(join(tmpdir(), "own-runs-"));
  await put(join(folder, "purpose.md"), "Be brief.");
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), id: "reader", folder, memory: { folder: join(folder, "memory") } };
  const readsFolder = ["ownListFiles", "ownReadFile"];
  const readsRuns = ["ownListRuns", "ownReadRun"];

  answers.push("Hi.");
  await turn({ agent, prompt: "hi", source: "test", fromOwner: true });
  is("every agent's owner gets the tools that read its own files and runs", [...readsFolder, ...readsRuns].every((one) => lastTools.includes(one)), true);
  is("and not the one that changes it, which loading adds", lastTools.includes("selfWriteFile"), false);
  answers.push("Hi.");
  await turn({ agent, prompt: "hi", source: "schedule", job: "nightly" });
  is("a turn its owner did not write still reads its own folder", readsFolder.every((one) => lastTools.includes(one)), true);
  is("but not its runs, which hold what other people said", readsRuns.some((one) => lastTools.includes(one)), false);

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

  const { ownRuns, ownRun } = await import("#chloe/services/selfService");
  // The turns above are runs of this agent too, and newer.
  const listed = ownRuns("reader").runs.filter((one) => String(one.id).startsWith("r-"));
  is("its runs are listed newest first, its own only and no eval's", listed.map((one) => one.id), ["r-failed", "r-chat", "r-job"]);
  is("as facts, without anything said in them", Object.keys(listed[1]).sort(), ["cost", "finished", "id", "job", "source", "started", "steps"]);
  is("a failed one says so", listed[0].failed, true);
  is("one job's, or the conversations", [ownRuns("reader", { job: "morning" }).runs.length, ownRuns("reader", { job: "chat" }).runs.map((one) => one.id).filter((id) => String(id).startsWith("r-"))], [2, ["r-chat"]]);
  const job = ownRun("reader", "r-job");
  is("a job's run shows its steps, with long results cut short", [job.steps.length, String((job.steps[0] as { result?: unknown }).result).endsWith("...[3000 characters]")], [2, true]);
  is("and what it answered", job.reply, "Sent the facts.");
  const chat = ownRun("reader", "r-chat");
  is("a conversation's shows what was asked, not the channel's wrapping", chat.asked, "what is new?");
  is("and what it said on the way and each call, the reply once", chat.steps, [{ said: "Let me look." }, { tool: "webReadPage", args: { url: "https://example.com" }, result: "A page." }]);
  is("a failed run says why", ownRun("reader", "r-failed").error, "Feed down.");
  const refused = (id: string) => {
    try {
      ownRun("reader", id);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("another agent's run is not there", refused("r-other").startsWith("You have no run"), true);
  is("nor an eval's", refused("r-eval").startsWith("You have no run"), true);

  const { ownFile } = await import("#chloe/services/selfService");
  const own = await ownFile(agent, false, "purpose.md");
  is("with selfImprovement off it reads its files and is told it cannot change them", [own.content, own.canWrite, own.why?.includes("selfImprovement")], ["Be brief.", false, true]);

  const written: string[] = [];
  const writer = { ...agent, tools: { selfWriteFile: Object.assign(tool({ description: "Change a file.", inputSchema: z.object({}), execute: async () => (written.push("x"), "Written.") }), { own: true, forOwner: true, changesAgent: true }) } };
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  answers.push({ content: "", tool_calls: [call("l", "ownListRuns", {}), call("f", "ownReadFile", { path: "purpose.md" }), call("w", "selfWriteFile", {})] }, "Done.");
  await turn({ agent: writer, prompt: "change it", source: "test", mayChangeAgent: true });
  is("listing its runs and reading its files does not stop a change", written.length, 1);
  answers.push({ content: "", tool_calls: [call("r", "ownReadRun", { id: "r-chat" }), call("w2", "selfWriteFile", {})] }, "Could not.");
  const after = await turn({ agent: writer, prompt: "fix what went wrong", source: "test", mayChangeAgent: true });
  is("reading a run does, because what it read from outside is in it", [written.length, String(after.calls.at(-1)?.output).includes("this reply used ownReadRun")], [1, true]);
}

{
  about("the owner's agent tries one of its jobs, as its files are now, and sends nothing");
  const { turn } = await import("#chloe/core/turn");
  const { startClock, tryJob } = await import("#chloe/core/clock");
  const { loadAgain } = await import("#chloe/load/load");
  const { realpathSync } = await import("node:fs");
  const { mkdir, mkdtemp, rm, symlink, writeFile: put } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { sent } = await import("./shared.ts");

  // Outside the runtime's folder, so its files are imported afresh, with the
  // package linked the way a project installs it.
  const folder = realpathSync(await mkdtemp(join(tmpdir(), "trier-")));
  await mkdir(join(folder, "node_modules/@chloejs"), { recursive: true });
  await mkdir(join(folder, "jobs"));
  await symlink(fileURLToPath(new URL("../..", import.meta.url)), join(folder, "node_modules/@chloejs/core"));
  const memory = await mkdtemp(join(tmpdir(), "trier-memory-"));
  await put(
    join(folder, "agent.ts"),
    `import { defineAgent } from "@chloejs/core";\nimport tell from "./jobs/tell.ts";\n` +
      `export default defineAgent({ id: "trier", identity: "", purpose: "Be brief.", model: "anthropic/claude-haiku-4.5", ` +
      `memory: { folder: ${JSON.stringify(memory)} }, jobs: [tell] });\n`,
  );
  const job = (words: string) =>
    `import { defineJob, deliver } from "@chloejs/core";\n` +
    `export default defineJob({ id: "tell", description: "The owner knows.", run: (work) => work.step("tell", () => deliver("test:somebody", ${JSON.stringify(words)}, "trier")) });\n`;
  await put(join(folder, "jobs/tell.ts"), job("The first words."));
  const home = { id: "trier", folder, memory: { folder: memory } };
  const loaded = await loadAgain(home);

  const clock = startClock(() => new Map());
  const before = sent.length;
  await put(join(folder, "jobs/tell.ts"), job("The words as changed."));
  const tried = await tryJob(loaded, "tell", { through: clock, source: "agent" });
  is("it runs the job as its files are now, not as it was loaded", tried.held.map((one) => one.text), ["The words as changed."]);
  is("to whom", tried.held[0].to, "test:somebody");
  is("and nothing was sent", sent.length, before);
  is("the run is marked a trial and kept", [row(tried.run).held !== null, row(tried.run).source], [true, "agent"]);
  const missing = await tryJob(loaded, "nope", { through: clock }).then(() => "", (error: Error) => error.message);
  is("a job it does not have is refused, with the ones it has", missing, 'trier has no job called "nope". Its jobs: tell.');

  answers.push("Hi.");
  await turn({ agent: loaded, prompt: "hi", source: "test", fromOwner: true });
  is("every owner's turn has it", lastTools.includes("ownTryJob"), true);
  answers.push("Hi.");
  await turn({ agent: loaded, prompt: "hi", source: "schedule", job: "nightly" });
  is("a turn its owner did not write does not", lastTools.includes("ownTryJob"), false);

  const written: string[] = [];
  const writer = { ...loaded, tools: { selfWriteFile: Object.assign(tool({ description: "Change a file.", inputSchema: z.object({}), execute: async () => (written.push("x"), "Written.") }), { own: true, forOwner: true, changesAgent: true }) } };
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  answers.push({ content: "", tool_calls: [call("t", "ownTryJob", { job: "tell" }), call("w", "selfWriteFile", {})] }, "It would say: The words as changed.");
  const reply = await turn({ agent: writer, prompt: "change it and try it", source: "test", mayChangeAgent: true });
  const answered = reply.calls[0].output as { held: { text: string }[] };
  is("the tool answers with what it held back", answered.held.map((one) => one.text), ["The words as changed."]);
  is("and what it read came from outside, so no change follows it", [written.length, String(reply.calls[1].output).includes("this reply used ownTryJob")], [0, true]);
  is("still nothing sent", sent.length, before);

  clock.stop();
  await rm(folder, { recursive: true, force: true });
  await rm(memory, { recursive: true, force: true });
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

  is("a tool is named by the key it is given", bind(shop, "email", { tools: { shopOrders: own.shopOrders, ownerMail: own.ownerMail } }).tools, ["shopOrders", "ownerMail"]);
  const refusal = (options: Parameters<typeof bind>[2]) => {
    try {
      bind(shop, "email", options);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("a tool that is not one of the agent's stops it loading", refusal({ tools: { elsewhere: fake("Elsewhere.") } }).includes("not in its tools"), true);

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
        identity: "",
        purpose: "Hello.",
        model: "m",
        folder: tmpdir(),
        jobs: jobs as never,
        channels: {
          first: { name: "first", job, start: () => ({ stop: () => {} }) },
          second: { name: "second", job, start: () => ({ stop: () => {} }) },
        } as never,
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
    [lastTools.includes("shopOrders"), lastTools.includes("memoryReadFile"), lastTools.includes("ownReadFile"), lastTools.includes("ownerMail"), lastTools.includes("selfWriteFile")],
    [true, true, true, false, false],
  );
  answers.push("Hello.");
  await receive(shop, { channel: "test", chat: "t", thread: "test/tools-guest", from: { id: "v", name: "a visitor" }, text: "hi", private: true }, { tools: ["shopOrders"], guests: true });
  is("a guest's turn has only what is named", [lastTools.includes("shopOrders"), lastTools.includes("memoryReadFile"), lastTools.includes("ownReadFile")], [true, false, false]);
  const toldNow = () => lastAsked.find((m) => m.role === "system")?.content ?? "";
  is("nor is it told where the memory opens on the dashboard", toldNow().includes("## Links to your memory"), false);
  {
    const { settings } = await import("@chloejs/core");
    const before = settings.serve;
    settings.serve = { ...before, url: "https://chloe.example.com/" };
    answers.push("Here.");
    await receive(shop, { channel: "test", chat: "t", thread: "test/tools-named", from: { id: "1", name: "Me" }, text: "a link?", private: true }, { tools: ["shopOrders"] });
    is("anybody else is told the link to a file in its memory, from serve.url", toldNow().includes(`https://chloe.example.com/agents/${shop.id}/memory/<its path`), true);
    settings.serve = before;
  }

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

{
  about("a tool call that takes too long");

  const { turn } = await import("#chloe/core/turn");
  let toolTold = false;
  // A hundredth of a minute is 600 ms.
  const stuck = Object.assign(
    tool({
      description: "Never answers.",
      inputSchema: z.object({}),
      execute: (_input, { abortSignal }) =>
        new Promise((_, fail) => abortSignal?.addEventListener("abort", () => ((toolTold = true), fail(abortSignal.reason)))),
    }),
    { timeLimit: 0.01 },
  );
  answers.length = 0;
  answers.push({ content: "", tool_calls: [{ id: "1", type: "function", function: { name: "stuck", arguments: "{}" } }] }, "It never answered, so I stopped.");
  const job: Job = { agent: "test", id: "slow", timezone: "UTC", prompt: "Use it.", files: [] };
  const agent = { ...agentFor(job), tools: { stuck } };
  const done = await turn({ agent, prompt: "Use it.", source: "schedule", job: "slow" });
  is("the tool is told to stop at its time limit", toolTold, true);
  is("and the model is told it ran out of time, and carries on", [lastAsked.at(-1)?.content.includes("stuck failed: it ran out of time after 0.01 minutes"), done.text], [true, "It never answered, so I stopped."]);
  answers.length = 0;
}
