// The WhatsApp channel.

import { createServer } from "node:http";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import { agentFor, answer, answers, asked, codeJob, db, row, work } from "./shared.ts";

{
  about("whatsapp");
  const { listen, whatsappText, asNumber } = await import("#chloe/channels/whatsapp");
  const { inPieces } = await import("#chloe/channels/shared");
  const { createHmac } = await import("node:crypto");

  is(
    "markdown arrives as whatsapp's own formatting",
    whatsappText("**Blocked on you:**\n- `main` needs a push, see [the log](https://example.com/a?b=1)\n- *one* item, ~~not two~~"),
    "*Blocked on you:*\n• `main` needs a push, see the log (https://example.com/a?b=1)\n• _one_ item, ~not two~",
  );
  is("a heading is a bold line", whatsappText("## Numbers"), "*Numbers*");
  is("a code block keeps its lines", whatsappText("```\na < b\n  c\n```"), "```\na < b\n  c\n```");
  is("a sum is not italics", whatsappText("2 * 3 * 4"), "2 * 3 * 4");
  is("a long reply is cut at a line break", inPieces("aaaa\nbbbb\ncc", 10), ["aaaa\nbbbb", "cc"]);
  is("a number is read however it was typed", [asNumber("+44 7700 900123"), asNumber("447700900123")], ["+447700900123", "+447700900123"]);


  // A stand-in Graph API: it writes down every call, hands back a media
  // address and its bytes, and refuses the one number that stands for somebody
  // who has not written in a day.
  const calls: { path: string; body: any }[] = [];
  const graph = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url!;
      if (request.method === "GET" && path.endsWith("/media-1")) {
        return void response.end(JSON.stringify({ url: `http://127.0.0.1:${(graph.address() as { port: number }).port}/download/media-1`, file_size: 4 }));
      }
      if (request.method === "GET") return void response.end("PNG!");
      const body = JSON.parse(raw || "{}");
      calls.push({ path, body });
      if (body.to === "447700900999") {
        response.writeHead(400, { "content-type": "application/json" });
        return void response.end(JSON.stringify({ error: { message: "Message failed to send because more than 24 hours have passed since the customer last replied", code: 131047 } }));
      }
      response.end(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }));
    });
  });
  await new Promise<void>((done) => graph.listen(0, "127.0.0.1", done));
  const api = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await pause(20);
    await pause(50);
  };
  const texts = () => calls.filter((c) => c.body.type === "text").map((c) => `${c.body.to}: ${c.body.text.body}`);

  const SECRET = "app-secret";
  const agent = agentFor(codeJob("unused", async () => ({})));
  const running = listen({
    agentId: "test",
    phoneNumberId: "55501",
    token: "permanent",
    appSecret: SECRET,
    verifyToken: "the-word",
    allowFrom: ["+447700900123"],
    api,
    agent: () => agent,
  });
  const route = running.routes![0];
  is("it answers one path, on both methods, so the address can be checked before it is used", [route.path, route.methods], ["/chloe/v1/test/whatsapp", ["GET", "POST"]]);

  /** A call to one of these channels' routes, with whatever signature is given. */
  const hit = async (which: typeof route, method: string, url: string, body = "", signature?: string) => {
    let status = 0;
    let said = "";
    const request = Object.assign(
      (async function* () {
        if (body) yield body;
      })(),
      { method, url, headers: signature === undefined ? {} : { "x-hub-signature-256": signature } },
    );
    await which.handle(request as any, {
      writeHead: (code: number) => ((status = code), { end: (text?: string) => void (said = text ?? "") }),
    } as any);
    return { status, said };
  };
  const call = (method: string, url: string, body = "", signature?: string) => hit(route, method, url, body, signature);
  const signed = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
  const posted = (message: object, who = "Ada", wa = "447700900123") =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "55501" }, contacts: [{ wa_id: wa, profile: { name: who } }], messages: [message] } }] }],
    });
  const text = (body: string, from = "447700900123", id = "wamid.in1") => ({ from, id, timestamp: "1", type: "text", text: { body } });

  is("the word WhatsApp was given gets the challenge back", await call("GET", "/x?hub.mode=subscribe&hub.verify_token=the-word&hub.challenge=12345"), { status: 200, said: "12345" });
  is("any other word gets nothing", (await call("GET", "/x?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=12345")).status, 403);

  const unsigned = await call("POST", "/x", posted(text("let me in")));
  await pause(50);
  is("a message nobody signed is refused, and nothing is answered", [unsigned.status, calls.length], [401, 0]);
  const wrong = await call("POST", "/x", posted(text("let me in")), "sha256=00");
  is("so is one signed with the wrong secret", wrong.status, 401);

  answers.push("hello from the agent");
  const first = posted(text("are you there"));
  is("a signed one is taken, and answered with a 200 before the work starts", (await call("POST", "/x", first, signed(first))).status, 200);
  await until(() => texts().length > 0);
  is("and the reply goes back to the number that wrote", texts(), ["447700900123: hello from the agent"]);
  is("the message is marked read and typing is shown while it works", calls.some((c) => c.body.status === "read" && c.body.typing_indicator), true);
  const ran = db.prepare("select agent, prompt from runs where source = 'whatsapp' order by started").all() as { agent: string; prompt: string }[];
  is("the run is filed under the channel it came in on", ran.length, 1);
  is("and the agent is told who wrote", ran[0].prompt.includes("Ada"), true);

  const stranger = posted(text("hello", "447700900999"), "Stranger", "447700900999");
  await call("POST", "/x", stranger, signed(stranger));
  await pause(100);
  is("somebody not allowed is answered by nobody", texts().length, 1);

  // A file comes in two calls: the id becomes an address, and the address
  // holds the bytes.
  answers.push("a red square");
  const withFile = posted({ from: "447700900123", id: "wamid.in2", type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "what is this?" } });
  await call("POST", "/x", withFile, signed(withFile));
  await until(() => texts().length > 1);
  const lastRun = db.prepare("select prompt from runs where source = 'whatsapp' order by started desc limit 1").get() as { prompt: string };
  is("a photo arrives with the message", lastRun.prompt.includes("(Attached: image.jpeg)"), true);
  running.stop();

  // A job's question: three answers or fewer are buttons, and pressing one is
  // the same as writing it.
  calls.length = 0;
  const asking = codeJob("buttons", async ({ ask }) => ({ go: await ask("go?", { question: "Go?", answer: z.boolean(), who: "whatsapp:+447700900123" }) }));
  const withJob = agentFor(asking);
  const second = listen({ agentId: "test", phoneNumberId: "55501", token: "permanent", appSecret: SECRET, verifyToken: "w", allowFrom: ["+447700900123"], api, agent: () => withJob });
  const parked = await work({ agent: withJob, job: asking });
  const question = calls.find((c) => c.body.type === "interactive");
  is("a yes or no question comes with two buttons", question?.body.interactive.action.buttons.map((b: any) => b.reply.title), ["yes", "no"]);
  const pressed = posted({ from: "447700900123", id: "wamid.in3", type: "interactive", interactive: { button_reply: { id: "b0:yes", title: "yes" } } });
  await hit(second.routes![0], "POST", "/x", pressed, signed(pressed));
  await until(() => !!row(parked.runId).reply);
  is("pressing one answers the waiting job", JSON.parse(row(parked.runId).reply), { go: true });

  // WhatsApp's own refusals are worth reading out loud, and the 24 hour rule
  // is the one that catches people.
  const said: string[] = [];
  const log = console.error;
  console.error = (...line: unknown[]) => void said.push(line.join(" "));
  const stale = posted(text("hello", "447700900999"), "Ada", "447700900999");
  const third = listen({ agentId: "test", phoneNumberId: "55501", token: "permanent", appSecret: SECRET, verifyToken: "w", allowFrom: ["+447700900999"], api, agent: () => agent });
  answers.push("an answer nobody will see");
  await hit(third.routes![0], "POST", "/x", stale, signed(stale));
  await until(() => said.some((l) => l.includes("131047")));
  console.error = log;
  third.stop();
  second.stop();
  is("a reply WhatsApp refuses says which rule refused it", said.some((l) => l.includes("24 hours") && l.includes("131047")), true);


  {
    // No app secret: nothing can tell a message from WhatsApp apart from a
    // message from anybody, so nothing is taken at all.
    const told: string[] = [];
    const log = console.error;
    console.error = (line: string) => void told.push(line);
    const open = listen({ agentId: "test", phoneNumberId: "55501", token: "permanent", appSecret: "", api, agent: () => agent });
    console.error = log;
    const body = posted(text("hello"));
    const { status } = await hit(open.routes![0], "POST", "/x", body, signed(body));
    open.stop();
    is("without an app secret it says so, and refuses every message", [told.some((l) => l.includes("app_secret")), status], [true, 401]);
  }

  {
    // Meta posts to a public address, so the log says which path to pass on to it.
    const said: string[] = [];
    const log = console.log;
    console.log = (...line: unknown[]) => void said.push(line.join(" "));
    const alone = listen({ agentId: "alone", phoneNumberId: "55501", token: "permanent", appSecret: SECRET, verifyToken: "w", api, agent: () => agent });
    console.log = log;
    alone.stop();
    is("the route it answers is said in the log, with the word Meta checks", said.some((one) => one.includes("/chloe/v1/alone/whatsapp") && one.includes(" w ")), true);
  }

  graph.close();
}
