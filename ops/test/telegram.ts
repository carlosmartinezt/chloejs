// The Telegram channel.

import { createServer } from "node:http";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import type { Job } from "./shared.ts";
import { agentFor, answer, answers, asked, codeJob, db, row, work } from "./shared.ts";

{
  about("telegram");
  const { listen, telegramChannel, telegramHtml } = await import("#chloe/channels/telegram");
  const { inPieces } = await import("#chloe/channels/shared");

  is(
    "markdown arrives as telegram's own formatting",
    telegramHtml("**Blocked on you:**\n1. `main` needs a fast-forward, see [the log](https://example.com/a?b=1&c=2).\n- *one* item"),
    "<b>Blocked on you:</b>\n1. <code>main</code> needs a fast-forward, see <a href=\"https://example.com/a?b=1&amp;c=2\">the log</a>.\n• <i>one</i> item",
  );
  is("a heading is a bold line", telegramHtml("## Numbers"), "<b>Numbers</b>");
  is("what telegram would read as a tag is escaped", telegramHtml("1 < 2 & 3 > 2"), "1 &lt; 2 &amp; 3 &gt; 2");
  is("nothing inside code is read as formatting", telegramHtml("`**not bold** <b>`"), "<code>**not bold** &lt;b&gt;</code>");
  is("a code block keeps its lines", telegramHtml("```\na < b\n  c\n```"), "<pre>a &lt; b\n  c</pre>");
  is("a quote is a quote", telegramHtml("> said\n> twice"), "<blockquote>said\ntwice</blockquote>");
  is("a link that is not a web or mail address stays as written", telegramHtml("[go](javascript:alert(1))"), "[go](javascript:alert(1))");
  is("underscores in a name are left alone", telegramHtml("scriptRun and webReadPage"), "scriptRun and webReadPage");
  is("a sum is not italics", telegramHtml("2 * 3 * 4"), "2 * 3 * 4");
  is("a long reply is cut at a line break", inPieces("aaaa\nbbbb\ncc", 10), ["aaaa\nbbbb", "cc"]);
  is("and one with none is cut where it has to be", inPieces("abcdefghij", 4), ["abcd", "efgh", "ij"]);

  {
    // Two agents, one with a bot in settings and one without. Each reads its
    // own entry, by the name it has when the channel starts.
    const { settings } = await import("@chloejs/core");
    const before = settings.agents;
    settings.agents = { first: { telegram: "first-bot", slack: { bot_token: "", app_token: "" }, whatsapp: { phone_number_id: "", token: "", app_secret: "" } } };
    const said: string[] = [];
    const log = console.error;
    console.error = (line: string) => void said.push(line);
    const channel = telegramChannel({ api: "http://127.0.0.1:9" });
    channel.start(() => ({ id: "second" }) as any).stop();
    channel.start(() => ({ id: "first" }) as any).stop();
    console.error = log;
    settings.agents = before;
    is("an agent with no entry has no bot, and is not handed another's", said.some((l) => l.includes("second has a Telegram channel but no bot")), true);
    is("an agent with one uses its own", said.some((l) => l.includes("first has a Telegram channel but no bot")), false);
  }
  is(
    "a channel says what it was made with, so a reload can tell an edit from none",
    [
      telegramChannel({ allowFrom: [1] }).madeWith === telegramChannel({ allowFrom: [1] }).madeWith,
      telegramChannel({ allowFrom: [1] }).madeWith === telegramChannel({ allowFrom: [1], sendWhileWorking: true }).madeWith,
    ],
    [true, false],
  );

  // What the page is allowed to show of a channel. Nothing here is a list of
  // option names: a credential is spotted by what it is, so a channel written
  // by anybody is treated like the ones that ship here.
  {
    const { channelsOf } = await import("#chloe/serve/inside");
    const { settings } = await import("#chloe/core/settings");
    const before = settings.agents;
    settings.agents = { first: { telegram: "the-one-in-settings" } } as unknown as typeof settings.agents;
    const channel = telegramChannel({
      allowFrom: [111111111],
      inGroups: "always",
      stackWithin: 5,
      credentials: { botToken: "8301554167:AAH3kQ2vB7pLxZr9TnW4sYdE1cJmU6oKgFa" },
    });
    const shown = channelsOf({ id: "first", channels: [channel] } as any)[0].settings;
    is("who may reach it and how it answers are shown", shown?.slice(0, 3), [
      { name: "allowFrom", value: "111111111" },
      { name: "inGroups", value: "always" },
      { name: "stackWithin", value: "5" },
    ]);
    is("a token written into the agent is not, however deep it sits", shown?.[3], {
      name: "credentials",
      value: "botToken hidden",
    });
    const held = telegramChannel({ credentials: { botToken: "the-one-in-settings" } });
    is(
      "nor is a short one the settings hold",
      channelsOf({ id: "first", channels: [held] } as any)[0].settings,
      [{ name: "credentials", value: "botToken hidden" }],
    );
    settings.agents = before;
  }

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
      const body = JSON.parse(raw || "{}");
      const token = request.url!.split("/")[1].slice(3);
      // The bot called "picky" refuses every formatted message, as Telegram
      // does one whose tags it cannot read.
      if (token === "picky" && body.parse_mode) {
        return void response.end(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }));
      }
      calls.push({ method, body, token });
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

  const first = listen({ agentId: "test", token: "t", api, agent: () => agent });
  inbox.push(privately(1, stranger, "hi"));
  await settle(1);
  first.stop();
  // A stopped reader's last poll can still reach the stand-in, which hands
  // messages out once and for all, unlike Telegram. Let it land first.
  await pause(100);
  is("it clears a webhook first, or Telegram refuses to hand out messages", calls.some((c) => c.method === "deleteWebhook"), true);
  is("a reply goes as telegram's formatting", calls.find((c) => c.method === "sendMessage")?.body.parse_mode, "HTML");

  const picky = listen({ agentId: "test", token: "picky", api, agent: () => agent });
  inbox.push(privately(2, stranger, "hi"));
  for (let i = 0; i < 100 && !calls.some((c) => c.token === "picky" && c.method === "sendMessage"); i++) await pause(20);
  picky.stop();
  await pause(100);
  const plain = calls.find((c) => c.token === "picky" && c.method === "sendMessage");
  is("a reply telegram refuses to format is sent again as plain words", [plain?.body.parse_mode, typeof plain?.body.text], [undefined, "string"]);
  is("with nobody allowed yet, a private message is told its user id", said()[0]?.startsWith("9: Your Telegram user id is 9."), true);

  calls.length = 0;
  answers.push("hello from the agent", "seen in the group", "a red square");
  const second = listen({ agentId: "test", token: "t", api, allowFrom: [7], agent: () => agent });
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
  const third = listen({ agentId: "test", token: "t", api, allowFrom: [7], agent: () => withJob });
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
    agentId: "test",
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

  // A command a person sends starts that job with the words after it, and with
  // inGroups "always" a group message needs no mention.
  calls.length = 0;
  answers.length = 0;
  const { startClock } = await import("#chloe/core/clock");
  const handed: string[] = [];
  const highlights = {
    ...codeJob("highlights", async ({ input }) => (handed.push(input.text), { ok: true }), undefined, () => "Filed. " + "A reply that is longer than one line. ".repeat(8).trim()),
  } as Job;
  delete highlights.cron;
  const reader = agentFor(highlights);
  const ticking = startClock(() => new Map([["test", reader]]));
  const fifth = listen({ agentId: "test", token: "j", api, allowFrom: [7], inGroups: "always", agent: () => reader });
  inbox.push(inGroup(40, me, "/highlights \u201cA line from a book.\u201d \u2014 A Book"));
  await settle(1);
  fifth.stop();
  ticking.stop();
  await pause(100);
  is("a command hands the words after it to that job, whole", handed, ["\u201cA line from a book.\u201d \u2014 A Book"]);
  const whole = "Filed. " + "A reply that is longer than one line. ".repeat(8).trim();
  is("and its own reply is what the chat is sent, whole", said(), [`-100: ${whole}`]);
  const { recall: recalled } = await import("#chloe/model/memory");
  is("and the exchange is kept in that chat's conversation, once", recalled("test/telegram--100").map((m) => m.content).slice(-2), ["/highlights \u201cA line from a book.\u201d \u2014 A Book", whole]);
  is("the / menu is the agent's jobs, then /models and /clear", calls.find((c) => c.method === "setMyCommands")?.body.commands, [
    { command: "highlights", description: "highlights" },
    { command: "models", description: "Which model answers here, and the ones to pick from" },
    { command: "clear", description: "Start this conversation fresh" },
  ]);

  // Two messages a second apart are one message, and the answer goes under the
  // first of them. A share that arrives as a quote and then a comment is why.
  calls.length = 0;
  handed.length = 0;
  const sixth = listen({ agentId: "test", token: "j", api, allowFrom: [7], inGroups: "always", stackWithin: 1, agent: () => reader });
  inbox.push(inGroup(41, me, "/highlights \u201cA line.\u201d \u2014 A Book"));
  await pause(200);
  inbox.push(inGroup(42, me, "and what I thought of it"));
  await settle(1);
  sixth.stop();
  await pause(100);
  is("messages sent close together are handled as one", handed, ["\u201cA line.\u201d \u2014 A Book\n\nand what I thought of it"]);
  is("and the answer replies to the first of them", calls.find((c) => c.method === "sendMessage")?.body.reply_parameters, { message_id: 41 });

  // A model's reply never starts a job, even one that is exactly its command:
  // the model may have read a page or a mail written to ask for that reply.
  calls.length = 0;
  handed.length = 0;
  answers.push("/highlights only the quote");
  const again = startClock(() => new Map([["test", reader]]));
  const replied = listen({ agentId: "test", token: "j", api, allowFrom: [7], inGroups: "always", agent: () => reader });
  inbox.push(inGroup(44, me, "\u201cA line.\u201d and a comment"));
  await settle(1);
  replied.stop();
  again.stop();
  await pause(100);
  is("a reply that is a job's command starts nothing", handed, []);
  is("and is sent as it is", said().at(-1), "-100: /highlights only the quote");

  // The words after a command fill the job's args in order, the last field
  // taking the rest of the line.
  {
    const { receive: received, argsFrom } = await import("#chloe/channels/shared");
    const weather = { ...codeJob("check-weather", async ({ args }) => `${args.location} in ${args.unit}`), args: z.object({ unit: z.string(), location: z.string() }) } as Job;
    delete weather.cron;
    is("a word to each field, the rest to the last", argsFrom(weather, "  metric New  York "), { unit: "metric", location: "New  York" });
    is("and fewer words fill fewer fields", argsFrom(weather, "metric"), { unit: "metric" });
    is("a job with no args takes none from the words", argsFrom(codeJob("plain", async () => ""), "a b"), {});
    const forecaster = agentFor(weather);
    const going = startClock(() => new Map([["test", forecaster]]));
    const asked = (text: string) =>
      received(forecaster, { channel: "test", chat: "w", thread: "", from: { id: "1", name: "Me" }, text, private: true }).then((done) => done?.text);
    is("so a command reads like one", await asked("/check-weather metric New York"), "New York in metric");
    is("and one missing a field says how to write it", (await asked("/check_weather metric"))?.endsWith("Write it as /check-weather <unit> <location>."), true);
    going.stop();
  }

  // A run that failed says so. Saying it is already running would send
  // somebody looking for a run that is not there.
  calls.length = 0;
  const breaks = {
    ...codeJob("highlights", async () => {
      throw new Error("the page would not write");
    }),
  } as Job;
  delete breaks.cron;
  const broken = agentFor(breaks);
  const failing = startClock(() => new Map([["test", broken]]));
  const seventh = listen({ agentId: "test", token: "j", api, allowFrom: [7], inGroups: "always", agent: () => broken });
  inbox.push(inGroup(43, me, "/highlights \u201cAnother line.\u201d \u2014 A Book"));
  await settle(1);
  seventh.stop();
  failing.stop();
  await pause(100);
  is("a failed job says what failed, not that it is already running", said(), ["-100: highlights failed. the page would not write"]);

  // /models comes with a button a model, and pressing one picks it for the chat.
  // The list is the agent's own model alone here, whatever this box's settings offer.
  calls.length = 0;
  const { settings: withModels } = await import("@chloejs/core");
  const offeredBefore = withModels.model.models;
  withModels.model.models = [];
  const eighth = listen({ agentId: "test", token: "t", api, allowFrom: [7], agent: () => agent });
  inbox.push(privately(60, me, "/models"));
  await settle(1);
  const offered = calls.find((c) => c.method === "sendMessage");
  const rows = offered?.body.reply_markup?.inline_keyboard as { text: string; callback_data: string }[][] | undefined;
  is("the models are buttons, one a row, each sending the pick", rows, [[{ text: "anthropic/claude-haiku-4.5", callback_data: "s:/model anthropic/claude-haiku-4.5" }]]);
  inbox.push({
    update_id: 61,
    callback_query: {
      id: "q2",
      from: me,
      data: "s:/model anthropic/claude-haiku-4.5",
      message: { message_id: 70, chat: { id: 7, type: "private" }, text: "the list", reply_markup: offered?.body.reply_markup },
    },
  });
  await settle(2);
  eighth.stop();
  withModels.model.models = offeredBefore;
  await pause(100);
  is("pressing one picks it", said()[1], "7: This chat now uses anthropic/claude-haiku-4.5.");
  is("and the buttons are replaced by what was pressed", calls.find((c) => c.method === "editMessageText")?.body.text, "the list\n\n→ anthropic/claude-haiku-4.5");
  is("the menu offers /models and /clear", calls.find((c) => c.method === "setMyCommands")?.body.commands.slice(-2).map((one: { command: string }) => one.command), ["models", "clear"]);

  telegram.close();

}
