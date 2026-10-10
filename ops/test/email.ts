// Email: who really sent it, and the email channel.

import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import type { Agent } from "./shared.ts";
import { agentFor, answers, codeJob, db, lastAsked, lastTools, sent } from "./shared.ts";

{
  about("reading an email, and who really sent it");
  const { addresses, readEmail, replyOnly, htmlText, signedBy, signatures } = await import("#chloe/core/mail");

  is("the address is the one in angle brackets, and the name is the name", addresses('"Jenny Example" <Jenny@Example.com>'), { list: ["jenny@example.com"], name: "Jenny Example" });
  is("an address written inside the quoted name is not the sender", addresses('"<carlos@example.com>" <someone@else.com>').list, ["someone@else.com"]);
  is("nor inside a comment", addresses("(<carlos@example.com>) someone@else.com").list, ["someone@else.com"]);
  is("an escaped quote does not end the name", addresses('"a \\" <carlos@example.com>" <someone@else.com>').list, ["someone@else.com"]);
  is("two angle brackets in one address give no address", addresses("<carlos@example.com> <someone@else.com>").list, []);
  is("a bare address, and a list of two", addresses("a@b.com, Jo <JO@c.com>").list, ["a@b.com", "jo@c.com"]);

  // Signed by an independent DKIM library (dkimpy) with a throwaway key, so
  // this checks the verifier against somebody else's signer, not its own.
  const SIGNED = {"key": "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDD67EgJyu6UHve/7pZXEKx0SkCBIQrm6je903HMAk091G5Iuxp/njYtWkU1n/OnyXspRxSV5cqeaE2qXICJ3eSHWGI1YeKHfd7tYAQRGKFqBUqmC81a5xCvUPrTJF61+JTKDKKr7pJRpDO6k3ylUlsHTjipoENeNORppBX9+OLQwIDAQAB", "relaxed": "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;\r\n i=@example.com; q=dns/txt; s=sel; t=1791031631; h=from : to : subject\r\n : message-id; bh=+DHnkpqRr3HOVCRaPkPai+eD/q5qBF3Dgz35uRQJc9o=;\r\n b=QWXXfw7xhgofg1q86bgfQ2MwliQYgXShVFbxTC63oV7w53Ab9xfH9G7uZ/tC1KU1UZMZG\r\n QvK9Da4vBf13NQ2srjGNKkEpDcywS8H16By6owlq0C/zqpJS3K8iliwOtm72uZa0aRvIjql\r\n XWdYkTtcWXHMuy0qzrPU+wfAuYnOxXo=\r\nFrom: Jenny  Example <Jenny@Example.com>\r\nTo: Chloe <reply-1234@chloejs.test>\r\nSubject: =?utf-8?B?UmU6IFRlbm5pcyDwn46+?=\r\nMessage-ID: <abc@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSaturdays work best, and caf=C3=A9 near the courts is a plus.  \r\n\r\n________________________________\r\nFrom: Chloe <reply-1234@chloejs.test>\r\nSent: Friday, October 2, 2026 9:00 AM\r\n\r\nWhat matters most to you in a club?\r\n--b1\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n<div>Saturdays work best, and caf&eacute; near the courts is a plus.</div><div id=\"appendonsend\"></div><div id=\"divRplyFwdMsg\">From: Chloe</div>\r\n--b1--\r\n\r\n\r\n", "simple": "DKIM-Signature: v=1; a=rsa-sha256; c=simple/simple; d=example.com;\r\n i=@example.com; q=dns/txt; s=sel; t=1791031631; h=from : to : subject;\r\n bh=AmilHDE/au4dAlhSfHOpj150BI+qhnTxdOeVA3IoNLs=;\r\n b=Ujf9kdIFbIGkjlBJ/tmw/ZpR6cFD1G/6Gl37NvohHElRReNDGxoPhhfBpT6AzGbbaFrDU\r\n E6j0N59uDTkR3Tv41pFgmrQRrEdOS4qXQN0YrsmylIlCGZaR/QpN63v5jQauDXy02nUH8Dj\r\n EEsFq2lhjBZOuGjNOmCl07GXBci93eg=\r\nFrom: Jenny  Example <Jenny@Example.com>\r\nTo: Chloe <reply-1234@chloejs.test>\r\nSubject: =?utf-8?B?UmU6IFRlbm5pcyDwn46+?=\r\nMessage-ID: <abc@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSaturdays work best, and caf=C3=A9 near the courts is a plus.  \r\n\r\n________________________________\r\nFrom: Chloe <reply-1234@chloejs.test>\r\nSent: Friday, October 2, 2026 9:00 AM\r\n\r\nWhat matters most to you in a club?\r\n--b1\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n<div>Saturdays work best, and caf&eacute; near the courts is a plus.</div><div id=\"appendonsend\"></div><div id=\"divRplyFwdMsg\">From: Chloe</div>\r\n--b1--\r\n\r\n\r\n", "partial": "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;\r\n i=@example.com; l=516; q=dns/txt; s=sel; t=1791031631; h=from : to;\r\n bh=+DHnkpqRr3HOVCRaPkPai+eD/q5qBF3Dgz35uRQJc9o=;\r\n b=Nicgqb06ojobrWJW023tW9tf3efaykzAcNFeBOJV/D64t7XQ2OEgVZwx/2HuGDRZTUZAn\r\n xNo7wHHRTxjVPBl81MidA+PFcWGWS3bOUWmtohkf17edHEo9T0eWkLMX8JKwlOjO96qMTcL\r\n wAOmNKMbnQY6tIcUU1daNVa8+smUdpU=\r\nFrom: Jenny  Example <Jenny@Example.com>\r\nTo: Chloe <reply-1234@chloejs.test>\r\nSubject: =?utf-8?B?UmU6IFRlbm5pcyDwn46+?=\r\nMessage-ID: <abc@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSaturdays work best, and caf=C3=A9 near the courts is a plus.  \r\n\r\n________________________________\r\nFrom: Chloe <reply-1234@chloejs.test>\r\nSent: Friday, October 2, 2026 9:00 AM\r\n\r\nWhat matters most to you in a club?\r\n--b1\r\nContent-Type: text/html; charset=\"utf-8\"\r\n\r\n<div>Saturdays work best, and caf&eacute; near the courts is a plus.</div><div id=\"appendonsend\"></div><div id=\"divRplyFwdMsg\">From: Chloe</div>\r\n--b1--\r\n\r\n\r\n"} as { key: string; relaxed: string; simple: string; partial: string };
  const dns = async (name: string) => {
    if (name === "sel._domainkey.example.com") return [["v=DKIM1; k=rsa; ", `p=${SIGNED.key.slice(0, 100)}`, SIGNED.key.slice(100)]];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };

  is("a relaxed signature checks out", await signedBy(SIGNED.relaxed, "example.com", dns), { ok: true, why: "it checks out" });
  is("so does a simple one", (await signedBy(SIGNED.simple, "example.com", dns)).ok, true);
  is("and with bare line endings, as some servers hand a message over", (await signedBy(SIGNED.relaxed.replace(/\r\n/g, "\n"), "example.com", dns)).ok, true);
  is("a sender at a subdomain is covered by its parent's signature", (await signedBy(SIGNED.relaxed, "mail.example.com", dns)).ok, true);
  is(
    "a body changed after signing is caught",
    await signedBy(SIGNED.relaxed.replace("Saturdays", "Sundays"), "example.com", dns),
    { ok: false, why: "the body was changed after it was signed" },
  );
  is("a From line changed after signing is caught", (await signedBy(SIGNED.relaxed.replace("Jenny@Example.com", "evil@example.com"), "example.com", dns)).ok, false);
  is(
    "a signature by another domain says nothing about this one",
    await signedBy(SIGNED.relaxed, "outlook.com", dns),
    { ok: false, why: "nothing on it is signed by outlook.com (signed by example.com)" },
  );
  is("one that signs only part of the body is refused", (await signatures(SIGNED.partial, dns))[0].why, "it signs only part of the body (l=)");
  is("no signature at all is refused", (await signedBy("From: a@b.com\r\n\r\nhi\r\n", "b.com", dns)).why, "it carries no DKIM signature");
  is(
    "a key that is not in DNS is a refusal, not a crash",
    (await signedBy(SIGNED.relaxed.replace("s=sel", "s=gone"), "example.com", dns)).ok,
    false,
  );

  const mail = readEmail(SIGNED.relaxed);
  is(
    "the From and To are read, lower case, and the subject decoded",
    [mail.from, mail.fromName, mail.to, mail.subject, mail.messageId],
    [["jenny@example.com"], "Jenny  Example", ["reply-1234@chloejs.test"], "Re: Tennis 🎾", "<abc@example.com>"],
  );
  is("what they wrote this time is cut from above Outlook's quoted history", mail.reply, "Saturdays work best, and café near the courts is a plus.");
  is("the plain text is kept whole", mail.text.includes("What matters most to you in a club?"), true);
  is(
    "a reply from Gmail or Apple Mail is cut at its 'wrote:' line",
    replyOnly("Yes, Saturday.\n\nOn Fri, Oct 2, 2026 at 9:00 AM Chloe <reply-1@x.org>\nwrote:\n> What day?"),
    "Yes, Saturday.",
  );
  is("trailing quoted lines go too", replyOnly("Fine by me.\n> earlier\n> more"), "Fine by me.");
  is("an Outlook header block is a cut", replyOnly("Ok\n\nFrom: Chloe\nSent: Friday\nTo: me\n\nold"), "Ok");
  is("HTML is read as text, entities and all", htmlText("<p>Caf&eacute; &amp; <b>courts</b></p><p>A&ntilde;o&#33;</p>"), "Café & courts\nAño!");
  is(
    "a file on it is named, not read",
    readEmail('From: a@b.com\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nSee attached\r\n--x\r\nContent-Type: application/pdf; name="prices.pdf"\r\nContent-Disposition: attachment; filename="prices.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--x--\r\n').files,
    ["prices.pdf"],
  );
  const { whenSent } = await import("#chloe/core/mail");
  is("a Date line is said in the sender's own time", whenSent("Sat, 3 Oct 2026 13:52:10 -0400"), "Sat, Oct 3, 2026 at 1:52 PM");
  is("and one that cannot be read is nothing", whenSent("whenever"), "");
  is("two From addresses are both read, so a reader can refuse them", readEmail("From: a@b.com, c@d.com\r\n\r\nhi").from, ["a@b.com", "c@d.com"]);

  about("email");
  const { listen } = await import("#chloe/channels/email");
  type Mailbox = import("#chloe/channels/email").Mailbox;
  type OutgoingMail = import("#chloe/channels/email").OutgoingMail;
  const ADDRESS = "reply-1234@chloejs.test";

  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await pause(20);
    await pause(50);
  };
  // A mailbox of our own: one address, every email it was asked to send
  // written down, and what arrives, handed over one at a time.
  const held: { to: string; raw: string }[] = [];
  const outbox: OutgoingMail[] = [];
  const askedFor: string[] = [];
  // While holding, a send finishes only when the case lets it go.
  let holding = false;
  const sending: (() => void)[] = [];
  const mailbox: Mailbox = {
    address: async (person) => (askedFor.push(person), ADDRESS),
    send: (mail) =>
      new Promise<void>((done) => {
        outbox.push(mail);
        if (holding) sending.push(done);
        else done();
      }),
    receive: async (take, signal) => {
      while (!signal.aborted) {
        const one = held.shift();
        if (one) await take(one.to, one.raw);
        else await pause(20);
      }
    },
  };
  const deliver = (raw: string, to = ADDRESS) => held.push({ to, raw });

  const own = {
    gmailReadEmail: { description: "Read the owner's mail.", inputSchema: z.object({}), execute: async () => "mail" },
    webReadPage: { description: "Read a page.", inputSchema: z.object({}), execute: async () => "page" },
  };
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), label: "Chloe", tools: own } as unknown as Agent;
  const { bind } = await import("#chloe/channels/shared");
  const running = listen({
    agentId: "test",
    channel: "email",
    mailbox,
    allowFrom: ["Jenny@Example.com"],
    bound: bind(agent, "email", { tools: [own.webReadPage] }),
    lookUp: dns,
    agent: () => agent,
  });
  const { openEmail, emailChannel } = await import("#chloe/channels/email");
  let old = "";
  try {
    emailChannel({ allowFrom: [], withoutTools: ["gmailReadEmail"] } as never);
  } catch (error) {
    old = (error as Error).message;
  }
  is("the old withoutTools stops the agent loading rather than being ignored", old.includes("withoutTools is gone"), true);

  let refused = "";
  try {
    await openEmail("test", "someone@else.com", "Hello", "Hi");
  } catch (error) {
    refused = (error as Error).message;
  }
  is("nobody outside allowFrom is ever emailed", refused.includes("is not somebody test may email"), true);

  const started = await openEmail("test", "jenny@example.com", "Tennis", "What matters most to you in a **club**?");
  is("starting one asks the mailbox for an address for her", [started.address, askedFor], [ADDRESS, ["jenny@example.com"]]);
  is(
    "and sends from it, as the agent, in Markdown and plain text",
    [outbox[0].from, outbox[0].name, outbox[0].subject, outbox[0].text.trim(), outbox[0].html.includes("<strong>club</strong>")],
    [ADDRESS, "Chloe", "Tennis", "What matters most to you in a club?", true],
  );
  const owned = db.prepare("select label, owner from threads where thread = ?").get(started.thread) as { label: string; owner: string };
  is("the conversation is the person's, under the subject, so they see it on the dashboard too", owned, { label: "Tennis", owner: "jenny@example.com" });

  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...line: unknown[]) => void warned.push(line.join(" "));

  answers.push("Saturdays it is. I will look for clubs with a café.");
  holding = true;
  deliver(SIGNED.relaxed);
  await until(() => outbox.length > 1);
  const answered = () => (db.prepare("select last_id from email_addresses where address = ?").get(ADDRESS) as { last_id: string | null }).last_id;
  const whileSending = answered();
  holding = false;
  for (const sent of sending.splice(0)) sent();
  await until(() => answered() !== null);
  is(
    "a reply is written down as answered only once its answer is sent, so one cut off by a restart is answered when it comes again",
    [whileSending, answered()],
    [null, "<abc@example.com>"],
  );
  is(
    "her signed reply is answered in the same thread",
    [outbox[1]?.from, outbox[1]?.subject, outbox[1]?.inReplyTo, outbox[1]?.text.split("\n\nOn ")[0].trim()],
    [ADDRESS, "Re: Tennis 🎾", "<abc@example.com>", "Saturdays it is. I will look for clubs with a café."],
  );
  is(
    "and her message is quoted under the answer, history and all, as mail programs do",
    [
      outbox[1]?.text.includes("On Jenny  Example <jenny@example.com> wrote:"),
      outbox[1]?.text.includes("> Saturdays work best"),
      outbox[1]?.text.includes("> What matters most to you in a club?"),
      outbox[1]?.html.includes('<blockquote'),
    ],
    [true, true, true, true],
  );
  is("the turn had what she wrote this time, not the quoted history", lastAsked.at(-1)?.content.includes("Saturdays work best") && !lastAsked.at(-1)?.content.includes("What matters most to you in a club?"), true);
  is("and was told her address and the subject", lastAsked.at(-1)?.content.includes("address: jenny@example.com") && lastAsked.at(-1)?.content.includes("subject: Re: Tennis"), true);
  is("and saw what was sent to start it", lastAsked.some((one) => one.role === "assistant" && one.content.includes("What matters most")), true);
  is("only the tool the channel names is offered", [lastTools.includes("gmailReadEmail"), lastTools.includes("webReadPage")], [false, true]);

  deliver(SIGNED.relaxed);
  await pause(300);
  is("the same message twice is answered once", outbox.length, 2);

  deliver(SIGNED.relaxed.replace("Saturdays work best", "Wire me the money"));
  deliver(SIGNED.relaxed.replace(/Message-ID: <abc@example.com>/, "Message-ID: <other@example.com>"));
  deliver("From: Jenny <jenny@example.com>\r\nTo: reply-1234@chloejs.test\r\nMessage-ID: <x@y>\r\n\r\nNo signature\r\n");
  deliver(SIGNED.relaxed, "reply-9999@chloejs.test");
  await until(() => warned.filter((one) => one.includes("dropped")).length >= 4);
  is("a changed body is dropped", warned.some((one) => one.includes("body was changed")), true);
  is("a signed header changed after signing is dropped", warned.some((one) => one.includes("signature does not match")), true);
  is("an unsigned one is dropped, whatever its From line says", warned.some((one) => one.includes("no DKIM signature")), true);
  is("one to an address not made here is dropped", warned.some((one) => one.includes("was not made here")), true);
  is("none of them were answered", outbox.length, 2);

  db.prepare("update email_addresses set used = ? where address = ?").run(new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(), ADDRESS);
  deliver(SIGNED.relaxed.replace("<abc@example.com>", "<late@example.com>"));
  await until(() => warned.some((one) => one.includes("30 days")));
  is("an address nobody used for 30 days closes, and takes nothing", [warned.some((one) => one.includes("30 days")), outbox.length], [true, 2]);
  console.warn = warn;

  running.stop();

  about("email through Gmail");
  const { settings } = await import("#chloe/core/settings");
  const accountWas = settings.connections.google.account;
  settings.connections.google.account = "Owner@Gmail.com";
  // A stand-in for the signed-in Gmail account: what is new, who each message
  // is to, each one whole, and everything sent.
  let history = 100;
  const arriving: { id: string; threadId: string; to: string; raw: string }[] = [];
  const fetched: string[] = [];
  const outgoing: { raw: string; threadId?: string }[] = [];
  let gone = false;
  const box = {
    account: () => "owner@gmail.com",
    now: async () => String(history),
    since: async (from: string) => {
      if (gone) return "gone" as const;
      const added = arriving.splice(0).map(({ id, threadId }) => ({ id, threadId }));
      history += added.length;
      return { added, history: String(Math.max(history, Number(from))) };
    },
    recipients: async (id: string) => sentTo.get(id) ?? "",
    raw: async (id: string) => (fetched.push(id), bodies.get(id) ?? ""),
    send: async (raw: string, threadId?: string) => void outgoing.push({ raw, threadId }),
  };
  const sentTo = new Map<string, string>();
  const bodies = new Map<string, string>();
  const arrive = (id: string, to: string, raw: string, threadId = `thread-${id}`) => {
    sentTo.set(id, to);
    bodies.set(id, raw);
    arriving.push({ id, threadId, to, raw });
  };
  const viaGmail = listen({
    agentId: "own",
    channel: "email",
    mailbox: "gmail",
    gmail: box,
    every: 30,
    allowFrom: ["Jenny@Example.com"],
    bound: bind(agent, "email", { tools: [own.webReadPage] }),
    lookUp: dns,
    agent: () => agent,
  });
  const whereUpTo = () => (db.prepare("select history from email_mailbox where agent = 'own'").get() as { history: string } | undefined)?.history;
  await until(() => whereUpTo() !== undefined);
  is("on its first look it only notes where the mailbox is, so old mail is never answered", whereUpTo(), "100");

  const opened = await openEmail("own", "jenny@example.com", "Courts", "Which day suits you?");
  is("a conversation's address is the account with a tag nobody can guess", /^owner\+[a-km-np-z2-9]{8}@gmail\.com$/.test(opened.address), true);
  const first = Buffer.from(outgoing[0].raw, "base64url").toString("utf8");
  is(
    "the first mail goes out through Gmail, under the agent's name, to her alone, with the tagged address to reply to",
    [first.includes('From: "Chloe" <owner@gmail.com>'), first.includes("To: jenny@example.com"), first.includes(`Reply-To: ${opened.address}`), first.includes("Subject: Courts")],
    [true, true, true, true],
  );

  // The signed reply above was written to ADDRESS, so that address is handed to this channel.
  db.prepare("update email_addresses set agent = 'own', used = ?, closed = null, last_id = null where address = ?").run(new Date().toISOString(), ADDRESS);
  answers.push("Saturday, then.");
  arrive("g1", "someone@else.com", "From: a@b.com\r\n\r\nnot for the agent\r\n");
  arrive("g2", `Chloe <${ADDRESS}>`, SIGNED.relaxed, "t9");
  await until(() => outgoing.length > 1);
  is("mail to anybody else in the mailbox is never fetched", fetched, ["g2"]);
  const answer = Buffer.from(outgoing[1]?.raw ?? "", "base64url").toString("utf8");
  is(
    "a signed reply to one of its addresses is answered through Gmail, in the same thread, with her message quoted",
    [outgoing[1]?.threadId, answer.includes("In-Reply-To: <abc@example.com>"), answer.includes("To: jenny@example.com"), answer.includes(`Reply-To: ${ADDRESS}`), answer.includes("Subject: =?UTF-8?B?")],
    ["t9", true, true, true, true],
  );
  await until(() => Number(whereUpTo()) > 100);
  is("and where it is up to moves on once that is done", Number(whereUpTo()) > 100, true);

  const notes: string[] = [];
  const warnWas = console.warn;
  console.warn = (...line: unknown[]) => void notes.push(line.join(" "));
  arrive("g3", `Chloe <${ADDRESS}>`, SIGNED.relaxed.replace("Saturdays work best", "Wire me the money"));
  await until(() => notes.some((one) => one.includes("dropped")));
  is("a reply changed after it was signed is dropped, as on every other way in", [notes.some((one) => one.includes("body was changed")), outgoing.length], [true, 2]);
  gone = true;
  await until(() => notes.some((one) => one.includes("starts from now")));
  gone = false;
  console.warn = warnWas;
  is("a point too old to ask from is said, and it starts again from now", notes.filter((one) => one.includes("starts from now")).length >= 1, true);

  viaGmail.stop();
  settings.connections.google.account = accountWas;

  about("email through a mailbox with a password");
  const { createServer: tcpServer } = await import("node:net");
  const { createServer: tlsServer, TLSSocket } = await import("node:tls");
  const { selfSigned } = await import("#chloe/serve/certificate");
  const { passwordMailbox } = await import("#chloe/connections/mail/mailbox");
  const pem = selfSigned();
  const trust = { ca: pem.cert, checkServerIdentity: () => undefined };
  const portOf = (server: import("node:net").Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as import("node:net").AddressInfo).port)));

  // A stand-in reading server: INBOX, numbered from 1, and every part asked for written down.
  const inbox: { uid: number; raw: string }[] = [];
  let validity = 7;
  let nextUid = 1;
  const parts: string[] = [];
  const imapSaid: string[] = [];
  const imapServer = tlsServer({ key: pem.key, cert: pem.cert }, (socket) => {
    socket.setEncoding("latin1");
    socket.write("* OK stand-in ready\r\n");
    let held = "";
    socket.on("data", (chunk: string) => {
      held += chunk;
      for (let at = held.indexOf("\r\n"); at >= 0; at = held.indexOf("\r\n")) {
        const line = held.slice(0, at);
        held = held.slice(at + 2);
        const [tag, verb, ...rest] = line.split(" ");
        const args = rest.join(" ");
        imapSaid.push(`${verb} ${verb === "LOGIN" ? "..." : args}`);
        if (verb === "LOGIN") socket.write(args === '"pw@chloejs.test" "app-pass"' ? `${tag} OK signed in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (verb === "SELECT") socket.write(`* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY ${validity}]\r\n* OK [UIDNEXT ${nextUid}]\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (verb === "UID" && rest[0] === "SEARCH") {
          const from = Number(rest[2].split(":")[0]);
          const found = inbox.filter((one) => one.uid >= from).map((one) => one.uid);
          // As a real server does, "n:*" holds the last message even when it is before n.
          if (!found.length && inbox.length) found.push(inbox[inbox.length - 1].uid);
          socket.write(`* SEARCH ${found.join(" ")}\r\n${tag} OK done\r\n`);
        } else if (verb === "UID" && rest[0] === "FETCH") {
          const one = inbox.find((m) => m.uid === Number(rest[1]));
          const part = args.match(/BODY\.PEEK\[([^\]]*)\]/)![1];
          parts.push(`${rest[1]}:${part || "whole"}`);
          if (!one) {
            socket.write(`${tag} OK nothing\r\n`);
            continue;
          }
          const head = one.raw.slice(0, one.raw.indexOf("\r\n\r\n") + 2);
          const body = part ? head.split(/\r\n(?![ \t])/).filter((h) => /^(to|cc):/i.test(h)).join("\r\n") + "\r\n\r\n" : one.raw;
          socket.write(`* 1 FETCH (UID ${one.uid} BODY[${part}] {${Buffer.byteLength(body, "latin1")}}\r\n${body})\r\n${tag} OK done\r\n`);
        } else if (verb === "LOGOUT") socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        else socket.write(`${tag} BAD what\r\n`);
      }
    });
    socket.on("error", () => {});
  });
  const imapPort = await portOf(imapServer);

  // A stand-in sending server, plain until STARTTLS as on port 587, writing down each message whole.
  const delivered: { from: string; to: string[]; data: string; signedIn: boolean }[] = [];
  let offersTls = true;
  const smtpServer = tcpServer((raw) => {
    let socket: import("node:net").Socket = raw;
    let held = "";
    let mail = { from: "", to: [] as string[], data: "", signedIn: false };
    let inData = false;
    const onData = (chunk: Buffer) => {
      held += chunk.toString("latin1");
      for (let at = held.indexOf("\r\n"); at >= 0; at = held.indexOf("\r\n")) {
        const line = held.slice(0, at);
        held = held.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            delivered.push(mail);
            mail = { from: "", to: [], data: "", signedIn: mail.signedIn };
            socket.write("250 queued\r\n");
          } else mail.data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          continue;
        }
        if (/^EHLO/.test(line)) socket.write(`250-stand-in\r\n${offersTls && !(socket instanceof TLSSocket) ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`);
        else if (line === "STARTTLS") {
          socket.write("220 go ahead\r\n");
          socket.removeListener("data", onData);
          socket = new TLSSocket(socket, { isServer: true, key: pem.key, cert: pem.cert });
          socket.on("data", onData);
          socket.on("error", () => {});
        } else if (line.startsWith("AUTH PLAIN ")) {
          mail.signedIn = Buffer.from(line.slice(11), "base64").toString() === "\0pw@chloejs.test\0app-pass";
          socket.write(mail.signedIn ? "235 ok\r\n" : "535 no\r\n");
        } else if (line.startsWith("MAIL FROM:")) socket.write(((mail.from = line.slice(11, -1)), "250 ok\r\n"));
        else if (line.startsWith("RCPT TO:")) socket.write((mail.to.push(line.slice(9, -1)), "250 ok\r\n"));
        else if (line === "DATA") socket.write(((inData = true), "354 go\r\n"));
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 what\r\n");
      }
    };
    socket.on("data", onData);
    socket.on("error", () => {});
    socket.write("220 stand-in\r\n");
  });
  const smtpPort = await portOf(smtpServer);

  const signIn = { address: "PW@chloejs.test", password: "app-pass", imap: `127.0.0.1:${imapPort}`, smtp: `127.0.0.1:${smtpPort}`, tls: trust };
  const viaPassword = listen({
    agentId: "pw",
    channel: "email",
    mailbox: "password",
    gmail: passwordMailbox(signIn),
    every: 30,
    allowFrom: ["Jenny@Example.com"],
    bound: bind(agent, "email", { tools: [own.webReadPage] }),
    lookUp: dns,
    agent: () => agent,
  });
  const pwUpTo = () => (db.prepare("select history from email_mailbox where agent = 'pw'").get() as { history: string } | undefined)?.history;
  inbox.push({ uid: nextUid++, raw: "From: a@b.com\r\nTo: pw@chloejs.test\r\n\r\nold mail\r\n" });
  await until(() => pwUpTo() !== undefined);
  is("on its first look it only notes where INBOX is: its numbering, and the number the next message gets", pwUpTo(), "7:2");
  is("it signs in once and keeps the connection", imapSaid.filter((one) => one.startsWith("LOGIN")).length, 1);

  const pwOpened = await openEmail("pw", "jenny@example.com", "Courts", "Which day suits you?");
  is("a conversation's address is the mailbox with a tag", /^pw\+[a-km-np-z2-9]{8}@chloejs\.test$/.test(pwOpened.address), true);
  const firstOut = delivered[0];
  is(
    "the first mail goes out by SMTP, after STARTTLS and signing in, to her alone, under the agent's name, with a Date and a Message-ID",
    [
      firstOut?.signedIn,
      firstOut?.from,
      firstOut?.to,
      firstOut?.data.includes('From: "Chloe" <pw@chloejs.test>'),
      firstOut?.data.includes(`Reply-To: ${pwOpened.address}`),
      /^Date: .+\r\nMessage-ID: <[^>]+@chloejs\.test>\r\n/.test(firstOut?.data ?? ""),
    ],
    [true, "pw@chloejs.test", ["jenny@example.com"], true, true, true],
  );

  db.prepare("update email_addresses set agent = 'pw', used = ?, closed = null, last_id = null where address = ?").run(new Date().toISOString(), ADDRESS);
  answers.push("Saturday, then.");
  inbox.push({ uid: nextUid++, raw: "From: a@b.com\r\nTo: someone@else.com\r\n\r\nnot for the agent\r\n" });
  inbox.push({ uid: nextUid++, raw: SIGNED.relaxed });
  await until(() => delivered.length > 1);
  is("only the To and Cc of what is new are read, and only mail to one of its addresses is fetched whole", parts, ["2:HEADER.FIELDS (TO CC)", "3:HEADER.FIELDS (TO CC)", "3:whole"]);
  is("every fetch is a peek, so nothing is marked read", imapSaid.filter((one) => one.startsWith("UID FETCH")).every((one) => one.includes("BODY.PEEK[")), true);
  is(
    "a signed reply to one of its addresses is answered by SMTP, threaded under hers",
    [delivered[1]?.to, delivered[1]?.data.includes("In-Reply-To: <abc@example.com>"), delivered[1]?.data.includes(`Reply-To: ${ADDRESS}`)],
    [["jenny@example.com"], true, true],
  );
  await until(() => pwUpTo() === "7:4");
  is("and where it is up to moves on once that is done", pwUpTo(), "7:4");

  const pwNotes: string[] = [];
  const pwWarn = console.warn;
  console.warn = (...line: unknown[]) => void pwNotes.push(line.join(" "));
  validity = 8;
  await until(() => pwNotes.some((one) => one.includes("starts from now")));
  console.warn = pwWarn;
  is("a mailbox numbered again is said, and it starts from now", [pwNotes.some((one) => one.includes("starts from now")), pwUpTo()], [true, "8:4"]);
  viaPassword.stop();

  let wrong = "";
  await passwordMailbox({ ...signIn, password: "nope" }).now().catch((error) => (wrong = (error as Error).message));
  is("a wrong password says so", wrong.includes("could not sign in to 127.0.0.1 as pw@chloejs.test: [AUTHENTICATIONFAILED] Invalid credentials"), true);

  offersTls = false;
  const before = delivered.length;
  let clear = "";
  await passwordMailbox(signIn).send(Buffer.from("To: jenny@example.com\r\n\r\nhi\r\n").toString("base64url")).catch((error) => (clear = (error as Error).message));
  is("a sending server that will not start TLS is never sent the password", [clear.includes("does not offer STARTTLS"), delivered.length], [true, before]);

  is("Gmail, iCloud and Fastmail need no servers written", passwordMailbox({ address: "a@icloud.com", password: "x" }).account(), "a@icloud.com");
  let unknown = "";
  await passwordMailbox({ address: "a@nowhere.test", password: "x" }).now().catch((error) => (unknown = (error as Error).message));
  is("any other provider is asked for its reading server", unknown.includes('set imap, like "imap.nowhere.test:993"'), true);
  imapServer.close();
  smtpServer.close();
}
