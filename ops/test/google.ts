// Signing in to Google, and reading what Google sends back.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import type { Tools } from "./shared.ts";

{
  about("what Google says when a person has to sign in");
  const { callback, codeFrom, explain, failure, signInState, SHOWS_THE_CODE, start } = await import("#chloe/connections/google/googleService");
  const { settings } = await import("@chloejs/core");

  // Every one of these is fixed by one sign-in, which the runtime starts when
  // it meets NeedsSignIn, so none of them may send anybody to the machine.
  const { NeedsSignIn } = await import("#chloe/connections/connection");
  for (const [what, text] of [
    ["a sign-in Google has taken back", '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'],
    ["nobody having signed in yet", "no sign-in"],
    ["a sign-in that was not allowed this", "Request had insufficient authentication scopes."],
  ] as const) {
    const thrown = failure(text);
    is(`${what} is a sign-in to do, for google`, thrown instanceof NeedsSignIn && thrown.connection, "google");
    is(`${what} does not send anybody to the box`, /auth login|on the box|paste/i.test(thrown.message), false);
  }
  is("a service switched off is not a sign-in to do", failure("Gmail API has not been used in project 1 before or it is disabled") instanceof NeedsSignIn, false);

  is("a service switched off in the console is not a sign-in either", explain("Gmail API has not been used in project 1 before or it is disabled").includes("Library"), true);

  const was = settings.connections.google.account;
  settings.connections.google.account = "";
  const { googleApi } = await import("#chloe/connections/google/googleService");
  let noAccount = "";
  try {
    await googleApi("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  } catch (error) {
    noAccount = (error as Error).message;
  }
  is("no account is the one thing a sign-in cannot fix, so it names the setting", noAccount.includes("connections.google.account"), true);
  const nobody = await signInState();
  is("and the state says so without running anything", nobody.ready, false);
  is("naming the setting that is missing", nobody.missing.includes("connections.google.account"), true);

  let refused = "";
  try {
    await start();
  } catch (error) {
    refused = (error as Error).message;
  }
  is("a sign-in with nobody to sign in is refused", refused.includes("connections.google.account"), true);
  settings.connections.google.account = was;

  about("where Google is told to send its answer");
  const callbackWas = settings.connections.google.callback;

  // Set outright, not left to whatever ran before this: the client decides the
  // address when nobody says one, so a case about the address has to pin it.
  const clientWas = settings.connections.google.client;
  settings.connections.google.callback = "";
  settings.connections.google.client = "";
  is("with no client and nothing set, the answer goes to this machine", callback().url, "");

  // With nothing said, the kind of client decides, because that is what decides
  // which addresses Google will take.
  settings.connections.google.client = { web: { client_id: "a", client_secret: "b" } };
  is("a web client gets the page that shows a code, unasked", callback().url, SHOWS_THE_CODE);
  settings.connections.google.client = { installed: { client_id: "a", client_secret: "b" } };
  is("a desktop client gets the loopback address, the only one Google will take", callback().url, "");
  settings.connections.google.client = "";
  is("and with no client there is nothing to go on", callback().url, "");
  settings.connections.google.client = clientWas;

  // Said outright, for an address somebody opened themselves.
  settings.connections.google.callback = SHOWS_THE_CODE;
  is("the page that shows a code is the address Google is told", callback().url, "https://chloejs.org/connected");
  settings.connections.google.callback = "https://example.com/somewhere/of/mine";
  is("and any other address somebody set is told as it is", callback().url, "https://example.com/somewhere/of/mine");

  settings.connections.google.callback = callbackWas;

  about("what a reply reads off the message it is answering");
  const { marked } = await import("#chloe/connections/google/googleService");
  const { rawMail, replyTo } = await import("#chloe/connections/google/gmailService");

  // Somebody else's words on their way to a model are marked as theirs, with
  // an id fresh each time, so text inside cannot close a marker it did not open.
  const one = marked("hi");
  const id = /id="([^"]+)"/.exec(one)?.[1];
  is("a field is marked as somebody else's words", one, `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nhi\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`);
  is("with an id of its own each time", marked("hi") === one, false);

  is("the address and the subject of an ordinary message", replyTo({
    from: '"Johnson, Cynthia" <cynthia_johnson1@intuit.com>',
    subject: "Intuit - FDE Role in NYC",
  }), { to: "cynthia_johnson1@intuit.com", subject: "Re: Intuit - FDE Role in NYC" });

  is("a Reply-To beats the From", replyTo({ reply_to: "her@example.com", from: "him@example.com", subject: "Hi" }).to, "her@example.com");
  is("an empty Reply-To falls through to the From", replyTo({ reply_to: "", from: "him@example.com", subject: "Hi" }).to, "him@example.com");

  is("a subject already answered is not answered twice", replyTo({ from: "a@b.com", subject: "RE: your invoice" }).subject, "RE: your invoice");
  is("a message with no subject says so", replyTo({ from: "a@b.com" }).subject, "Re: (no subject)");
  is("a subject folded across lines becomes one line", replyTo({ from: "a@b.com", subject: "a very long\n  subject line" }).subject, "Re: a very long subject line");
  is("and carries no newline", /[\r\n]/.test(replyTo({ from: "a@b.com", subject: "one\ntwo" }).subject), false);

  // A mail is written here, so a header is one line or nothing is sent.
  const mail = (fields: Parameters<typeof rawMail>[0]) => Buffer.from(rawMail(fields), "base64url").toString("utf8");
  is("a subject that is not plain ASCII is written the way headers carry it", mail({ to: ["a@b.co"], subject: "Café", text: "hi" }).includes("Subject: =?UTF-8?B?"), true);
  is("a reply carries the headers that thread it", mail({ to: ["a@b.co"], subject: "Re: x", text: "hi", inReplyTo: "<1@x>", references: "<0@x> <1@x>" }).includes("In-Reply-To: <1@x>\r\nReferences: <0@x> <1@x>"), true);
  is("an HTML mail carries the plain text beside it", mail({ to: ["a@b.co"], subject: "x", text: "hi", html: "<p>hi</p>" }).includes("multipart/alternative"), true);
  let broke = "";
  try {
    rawMail({ to: ["a@b.co"], subject: "x\r\nBcc: them@example.com", text: "hi" });
  } catch (error) {
    broke = (error as Error).message;
  }
  is("a header with a line break in it sends nothing", broke.includes("nothing was sent"), true);

  // A subject is the one piece of the sender's words that comes back to a
  // model as this tool's own answer, so it is held to the length of a subject.
  is("a subject the length of a letter is cut short", replyTo({ from: "a@b.com", subject: "x".repeat(900) }).subject.length, 204);

  // The address is the whole of what makes replying safer than sending, so
  // each of these is a way of being talked into mailing somebody else.
  for (const [what, from] of [
    ["an address hidden in the display name", '"<them@example.com>" <her@example.com>'],
    ["an address hidden in a display name with escaped quotes", '"she said \\"<them@example.com>\\"" <her@example.com>'],
  ] as const) {
    is(`${what} is not who it reaches`, replyTo({ from, subject: "Hi" }).to, "her@example.com");
  }

  for (const [what, from] of [
    ["two addresses", '"Her" <her@example.com>, <them@example.com>'],
    ["two bare addresses", "her@example.com, them@example.com"],
    ["an address with a space in it", "<her@example.com them@example.com>"],
    ["a group", "undisclosed-recipients:;"],
    ["nothing at all", ""],
    ["no address", '"Her" <>'],
  ] as const) {
    let refused = "";
    try {
      replyTo({ from, subject: "Hi" });
    } catch (error) {
      refused = (error as Error).message;
    }
    is(`${what} is refused rather than guessed at`, refused.includes("nothing was sent"), true);
  }

  about("what a Google tool brings with it");
  const gmail = await import("@chloejs/core/tools/gmail");
  const resend = await import("@chloejs/core/tools/resend");

  // A sign-in is the runtime's to run, so no model is handed one: a model asked
  // to copy a sign-in link rewrote it and left out the mail.
  const { defineAgent: define } = await import("@chloejs/core");
  const { resolveAgent: resolve } = await import("#chloe/load/load");
  const toolsOf = async (tools: Tools) =>
    Object.keys((await resolve(define({ id: "mail", folder: await mkdtemp(join(tmpdir(), "chloe-mail-")), model: "m", description: "", instructions: "Hi.", features: { memory: false, selfImprovement: false }, tools }))).tools ?? {}).sort();
  is("gmailReadEmail comes with no sign-in tool", await toolsOf({ gmailReadEmail: gmail.readEmail({ search: "in:inbox" }) }), ["gmailReadEmail"]);
  const sender = { when: "it reaches nobody", from: "a@b.co", to: ["c@d.co"] };
  is("resendSendEmail has nothing to sign in to", await toolsOf({ resendSendEmail: resend.sendEmail(sender) }), ["resendSendEmail"]);

  about("a connection of an agent's own");
  const { connectionsOf } = await import("#chloe/serve/inside");
  const shop: import("@chloejs/core").Connection = {
    name: "shop",
    does: "The shop's orders.",
    settings: ["agents.mail.shop"],
    signIn: { start: async () => ({ say: "Open this.", link: "https://shop.example/sign-in" }), answers: () => false, finish: async () => "Signed in." },
    missing: async () => ["nobody has signed in to the shop"],
  };
  const orders = Object.assign(tool({ description: "Read the orders.", inputSchema: z.object({}), execute: async () => [] }), { needs: shop });
  is("its tools are what the agent named, and no more", await toolsOf({ shopReadOrders: orders }), ["shopReadOrders"]);
  const reached = await connectionsOf({ id: "mail", model: "m", tools: { shopReadOrders: orders, again: orders } } as any);
  is("the setup page lists it once, with what is missing", reached.filter((one) => one.name === "shop"), [
    { name: "shop", does: "The shop's orders.", needs: "agents.mail.shop", ready: false, missing: ["nobody has signed in to the shop"], signIn: true },
  ]);
  const { signInOf } = await import("#chloe/serve/inside");
  const shopper = { id: "mail", model: "m", tools: { shopReadOrders: orders } } as any;
  is("the page starts the same sign-in a chat does", await signInOf(shopper, "shop").start(), { say: "Open this.", link: "https://shop.example/sign-in" });
  let unknown = "";
  try {
    signInOf(shopper, "bank");
  } catch (error) {
    unknown = (error as Error).message;
  }
  is("and a connection the agent does not have is not found", unknown.includes("no connection called"), true);

  const { emailChannel } = await import("#chloe/channels/email");
  const onGmail = { id: "mailer", model: "m", tools: {}, channels: [emailChannel({ allowFrom: ["a@b.co"], mailbox: "gmail" })] } as any;
  is(
    "an agent whose only use of Google is an email channel on Gmail still has Google on its page, to sign in to",
    (await connectionsOf(onGmail)).filter((one) => one.name === "google").map((one) => one.signIn),
    [true],
  );
  is("and the page can start that sign-in", typeof signInOf(onGmail, "google").start, "function");
  const ownBox = { address: async () => "", send: async () => {}, receive: async () => {} };
  const onItsOwn = { id: "mailer", model: "m", tools: {}, channels: [emailChannel({ allowFrom: ["a@b.co"], mailbox: ownBox })] } as any;
  is("one on a mailbox of its own needs no Google", (await connectionsOf(onItsOwn)).some((one) => one.name === "google"), false);

  about("what the person is told to do");
  const { whatToDo } = await import("#chloe/connections/google/googleService");

  // Two endings, and these words are the whole of what the person
  // experiences. The one that reads as a fault is the default, so saying so
  // before they see it is the difference between a step and a broken page.
  const page = "https://chloejs.org/connected";
  is(
    "with a page in front of it, the person sends a code",
    whatToDo("a@b.co", { url: page }).includes("short code"),
    true,
  );
  const loopback = whatToDo("a@b.co", { url: "" });
  is("and on this machine, that the page will not load is said first", loopback.includes("will not load"), true);
  is("with the reason, which is that the address is not theirs", loopback.includes("not yours"), true);
  is(
    "an address that happens to be localhost is the same case",
    whatToDo("a@b.co", { url: "http://localhost:9/x" }).includes("will not load"),
    true,
  );

  about("a sign-in that is started");
  {
    const before = { account: settings.connections.google.account, client: settings.connections.google.client, callback: settings.connections.google.callback };
    settings.connections.google.account = "somebody@example.com";
    settings.connections.google.client = { web: { client_id: "the-id", client_secret: "the-secret" } };
    settings.connections.google.callback = "";
    const started = await start();
    const link = new URL(started.link);
    is("the link is Google's", link.host, "accounts.google.com");
    is("it asks for a key that lasts", [link.searchParams.get("access_type"), link.searchParams.get("prompt")], ["offline", "consent"]);
    is("for the account in settings", link.searchParams.get("login_hint"), "somebody@example.com");
    is("with the code locked to this machine", link.searchParams.get("code_challenge_method"), "S256");
    is("and asks who approved, besides mail, the calendar and Drive", (link.searchParams.get("scope") ?? "").split(" ").slice(0, 2), ["openid", "email"]);
    is("a web client is sent to the page that shows a code", link.searchParams.get("redirect_uri"), SHOWS_THE_CODE);
    const pending = JSON.parse(await (await import("node:fs/promises")).readFile(join(process.env.CHLOE_STATE!, "google", "pending.json"), "utf8"));
    is("what the second half needs is written down", typeof pending.verifier === "string" && pending.state === link.searchParams.get("state"), true);
    const state = await signInState();
    is("and the state says it is waiting", [state.ready, state.waiting], [false, true]);
    Object.assign(settings.connections.google, before);
  }

  about("what a person sends back");
  const waiting = {
    account: "somebody@example.com",
    services: "gmail",
    redirect: "http://127.0.0.1:33067/oauth2/callback",
    state: "the-state",
    verifier: "v",
    started: new Date().toISOString(),
  };
  is("the code is read out of the whole address", codeFrom("http://127.0.0.1:33067/oauth2/callback?code=abc&state=the-state", waiting), "abc");
  is("a phone that selects only the code is fine", codeFrom("abc123", waiting), "abc123");
  is("and code= in front of it is not part of the code", codeFrom("code=xyz", waiting), "xyz");
  for (const [what, answer] of [
    ["an address from another sign-in", "http://127.0.0.1:33067/oauth2/callback?code=abc&state=another"],
    ["an address where Google said no", "http://127.0.0.1:33067/oauth2/callback?error=access_denied&state=the-state"],
    ["an address with no code", "http://127.0.0.1:33067/oauth2/callback?state=the-state"],
    ["a sentence", "here you go: abc"],
  ] as const) {
    let refused = "";
    try {
      codeFrom(answer, waiting);
    } catch (error) {
      refused = (error as Error).message;
    }
    is(`${what} is refused`, refused.length > 0, true);
  }

  about("a whole sign-in, and mail, against a stand-in for Google");
  {
    const { finish, start, signInState } = await import("#chloe/connections/google/googleService");
    const { readEmailMessages, readOneEmailMessage, replyGmail } = await import("#chloe/connections/google/gmailService");
    const before = { account: settings.connections.google.account, client: settings.connections.google.client, callback: settings.connections.google.callback };
    settings.connections.google.account = "somebody@example.com";
    settings.connections.google.client = { web: { client_id: "the-id", client_secret: "the-secret" } };
    settings.connections.google.callback = "";
    const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
    let approvedBy = "somebody@example.com";
    const everything = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly";
    let granted = everything;
    const traded: URLSearchParams[] = [];
    const sent: { raw: string; threadId?: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.href === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(String(init?.body));
        traded.push(form);
        if (form.get("grant_type") === "authorization_code") {
          return json({ access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: granted, id_token: idToken({ aud: "the-id", email: approvedBy, email_verified: true }) });
        }
        return json({ access_token: "a2", expires_in: 3600 });
      }
      if ((init?.headers as Record<string, string>)?.authorization !== "Bearer a2") return new Response("no", { status: 401 });
      if (url.pathname.endsWith("/messages") && init?.method !== "POST") return json({ messages: [{ id: "m1" }] });
      if (url.pathname.endsWith("/profile")) return json({ historyId: "55" });
      if (url.pathname.endsWith("/history")) {
        if (url.searchParams.get("startHistoryId") === "1") return new Response('{"error":{"code":404,"message":"Requested entity was not found."}}', { status: 404 });
        return json({ history: [{ messagesAdded: [{ message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } }, { message: { id: "d1", labelIds: ["DRAFT"] } }] }], historyId: "56" });
      }
      if (url.pathname.endsWith("/messages/m1") && url.searchParams.get("format") === "raw") return json({ raw: Buffer.from("From: her@example.com\r\n\r\nShall we?").toString("base64url") });
      if (url.pathname.endsWith("/messages/m1")) {
        return json({
          id: "m1",
          threadId: "t1",
          snippet: "hello",
          payload: {
            headers: [
              { name: "From", value: "Her <her@example.com>" },
              { name: "To", value: "Somebody <somebody+abc@example.com>" },
              { name: "Subject", value: "Lunch" },
              { name: "Message-ID", value: "<1@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Shall we?").toString("base64url") },
          },
        });
      }
      if (url.pathname.endsWith("/messages/send")) {
        sent.push(JSON.parse(String(init?.body)));
        return json({ id: "s1" });
      }
      return new Response("not here", { status: 404 });
    }) as typeof fetch;
    try {
      await start();
      approvedBy = "somebody-else@example.com";
      let refused = "";
      try {
        await finish("the-code");
      } catch (error) {
        refused = (error as Error).message;
      }
      is("a sign-in approved by another account is thrown away", refused.includes("somebody-else@example.com"), true);
      is("and nothing is kept", (await signInState()).ready, false);

      approvedBy = "somebody@example.com";
      granted = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.readonly";
      await start();
      refused = "";
      try {
        await finish("the-code");
      } catch (error) {
        refused = (error as Error).message;
      }
      is("a sign-in Google allowed less than it asked for is not kept", refused.includes("without mail and the calendar"), true);
      is("and nothing is kept for it either", (await signInState()).ready, false);

      granted = everything;
      const { isAnswer } = await import("#chloe/connections/google/googleService");
      const { link: sentLink } = await start();
      const state = new URL(sentLink).searchParams.get("state");
      is("a code in Google's form is the answer to a waiting sign-in", isAnswer("4/0AXlqoi4qRgcvmk6CUrHYNhoeVWqkRv0RGZWY87"), true);
      is("so is the page's address with its state", isAnswer(`https://chloejs.org/connected?code=4/abc&state=${state}`), true);
      is("but not one with another sign-in's state", isAnswer("https://chloejs.org/connected?code=4/abc&state=other"), false);
      is("and never a word, which goes to the model", [isAnswer("hello"), isAnswer("check my gmail")], [false, false]);
      is("one approved by the account in settings is kept", await finish("the-code"), { account: "somebody@example.com", signedIn: true });
      is("with the code traded under its lock", (traded.at(-1)?.get("code_verifier")?.length ?? 0) > 40, true);
      is("and the state says it is ready", (await signInState()).ready, true);

      const listed = await readEmailMessages({ search: "in:inbox", days: 7, limit: 5 });
      is("mail is listed with a key traded for the lasting one", listed.messages.map((one) => one.id), ["m1"]);
      is("and what somebody else wrote is marked as theirs", listed.messages[0].subject?.includes("EXTERNAL_UNTRUSTED_CONTENT"), true);
      const one = (await readOneEmailMessage({ search: "in:inbox", what: "the inbox", messageId: "m1" })).message as { body: string };
      is("a message is read in full", one.body.includes("Shall we?"), true);

      const reply = await replyGmail({ search: "in:inbox", what: "the inbox", messageId: "m1", body: "Yes, at one." });
      is("a reply goes to the sender, with the subject answered", [reply.to, reply.subject], ["her@example.com", "Re: Lunch"]);
      const mail = Buffer.from(sent[0].raw, "base64url").toString("utf8");
      is("in the same thread", sent[0].threadId, "t1");
      is("and threaded by its headers", mail.includes("In-Reply-To: <1@example.com>"), true);

      const { gmailMailbox } = await import("#chloe/connections/google/mailbox");
      is("the email channel asks Gmail where the mailbox is up to", await gmailMailbox.now(), "55");
      is("and what was added since, leaving drafts out", await gmailMailbox.since("55"), { added: [{ id: "m1", threadId: "t1" }], history: "56" });
      is("a point Gmail no longer keeps is said as gone, not as a failure", await gmailMailbox.since("1"), "gone");
      is("who a message is to is read from its headers alone", (await gmailMailbox.recipients("m1")).includes("somebody+abc@example.com"), true);
      is("and a message it takes is fetched whole", (await gmailMailbox.raw("m1")).includes("Shall we?"), true);
      await gmailMailbox.send("cmF3", "t1");
      is("sending names the thread", sent.at(-1), { raw: "cmF3", threadId: "t1" });
    } finally {
      globalThis.fetch = real;
      await (await import("node:fs/promises")).rm(join(process.env.CHLOE_STATE!, "google"), { recursive: true, force: true });
      Object.assign(settings.connections.google, before);
    }
  }
}
