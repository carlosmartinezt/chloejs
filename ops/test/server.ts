// The server: the login, the API, and starting a job over it.

import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import type { Agent, Job } from "./shared.ts";
import { agentFor, asked, codeJob, row, sent, work } from "./shared.ts";

{
  about("the login in front of the page");

  const { cookieName, firstPassword, hasPassword, makeLink, resetPassword, seal, setCookie, signIn, signInWithLink, signedIn, suggestPassword } =
    await import("#chloe/serve/login");
  const { settings } = await import("#chloe/core/settings");
  const carrying = (cookie: string) => ({ headers: { cookie } }) as import("node:http").IncomingMessage;
  const cookie = cookieName();
  const refusal = (doing: () => unknown) => {
    try {
      doing();
      return "let through";
    } catch (error) {
      return (error as Error).message;
    }
  };

  is("a fresh copy has no password", hasPassword(), false);
  is("and no password signs in to it", refusal(() => signIn("anything at all", "1.2.3.4")), "This copy has no password, so it opens with a link. Run npx chloe link in its folder.");

  const link = makeLink("http://127.0.0.1:3067");
  is("it opens with a link: the address, and a code after #in=", link.startsWith("http://127.0.0.1:3067/#in="), true);
  const code = link.slice(link.indexOf("#in=") + 4);
  const byLink = signInWithLink(code, "1.2.3.4");
  is("the code signs a browser in", signedIn(carrying(`${cookie}=${byLink}`)), true);
  const usedUp = "That link was used already, or is more than an hour old. Run npx chloe link in its folder for another.";
  is("once", refusal(() => signInWithLink(code, "1.2.3.4")), usedUp);
  is("and not after an hour", refusal(() => signInWithLink(seal("link", { id: "old", until: 1 }), "1.2.3.4")), usedUp);
  const notOurs = "That link was not made by this copy. Run npx chloe link in its folder for one.";
  is("a code somebody edited does not", refusal(() => signInWithLink(`${code.slice(0, -1)}x`, "1.2.3.4")), notOurs);
  is("nor does a session passed off as one", refusal(() => signInWithLink(byLink, "1.2.3.4")), notOurs);
  is("the cookie has the port in its name, so two copies on one machine keep apart", cookie, `chloe_session_${settings.serve.port}`);

  is("one that is too short is refused", refusal(() => firstPassword("short")), "The password must be at least 8 characters.");
  firstPassword("a long enough one");
  is("the first password is set", hasPassword(), true);
  is("and the browser that came in with a link stays in", signedIn(carrying(`${cookie}=${byLink}`)), true);
  is("a second is refused: that takes a shell", refusal(() => firstPassword("another long one")), "A password is already set.");

  const session = signIn("a long enough one", "1.2.3.4");
  is("the right password signs in", signedIn(carrying(`${cookie}=${session}`)), true);
  is("a cookie somebody edited does not", signedIn(carrying(`${cookie}=${session.slice(0, -1)}x`)), false);
  is("nor does one under another copy's name", signedIn(carrying(`chloe_session_1=${session}`)), false);
  is("no cookie does not", signedIn(carrying("")), false);
  is("signing out clears it", setCookie("", true)[0].includes("Max-Age=0"), true);
  is("the cookie is this site's alone, never a family of names", setCookie(session, true)[0].includes("Domain="), false);
  is("so signing out has one cookie to end", setCookie("", true).length, 1);

  // The same value said the other way, for a caller that is not a browser.
  const bearing = (authorization: string) => ({ headers: { authorization } }) as import("node:http").IncomingMessage;
  is("the same value as a bearer signs in", signedIn(bearing(`Bearer ${session}`)), true);
  is("and the word is not case sensitive", signedIn(bearing(`bearer ${session}`)), true);
  is("a bearer somebody edited does not", signedIn(bearing(`Bearer ${session.slice(0, -1)}x`)), false);
  is("an empty bearer does not", signedIn(bearing("Bearer ")), false);
  is("and another scheme does not", signedIn(bearing(`Basic ${session}`)), false);

  const wrong = (() => {
    try {
      signIn("not the password", "1.2.3.4");
      return "signed in";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("the wrong password does not", wrong, "Wrong password.");

  for (let tries = 0; tries < 5; tries++) {
    try {
      signIn("not the password", "9.9.9.9");
    } catch {
      // Counting the failures is the point; the message is checked above.
    }
  }
  const locked = (() => {
    try {
      signIn("a long enough one", "9.9.9.9");
      return "signed in";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("guessing over and over locks that address out", locked.startsWith("Too many tries."), true);
  is("and only that one", Boolean(signIn("a long enough one", "1.2.3.4")), true);

  // The way back in from a forgotten password, which only a shell can do.
  const before = makeLink("http://127.0.0.1:3067").split("#in=")[1];
  resetPassword("a different long one");
  is("a new password from the terminal works", Boolean(signIn("a different long one", "1.2.3.4")), true);
  is("the old one stops working", (() => {
    try {
      signIn("a long enough one", "1.2.3.4");
      return "signed in";
    } catch (error) {
      return (error as Error).message;
    }
  })(), "Wrong password.");
  is("and every session signed on it is over", signedIn(carrying(`${cookie}=${session}`)), false);
  is("and every link made before it", refusal(() => signInWithLink(before, "1.2.3.4")), notOurs);

  const made = suggestPassword();
  is("a password made up here is long enough to be one", made.length >= 8, true);
  is("and two are not the same", made === suggestPassword(), false);

  // One account file for the whole run, so put back the one later blocks sign in with.
  resetPassword("a long enough one");
}

{
  about("the API without a browser");

  const { serve } = await import("#chloe/serve/http");
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map(),
    clock: { fire() {} } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const asked = await fetch(`${at}/api/account`);
  is("whether there is a password is answered with no session", [asked.status, await asked.json()], [200, { exists: true }]);

  const shut = await fetch(`${at}/api/agents`);
  is("and everything else is still shut", [shut.status, await shut.json()], [401, { error: "Sign in first." }]);
  const setting = await fetch(`${at}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a third long one" }) });
  is("setting the first password among them", setting.status, 401);

  const { cookieName, makeLink } = await import("#chloe/serve/login");
  const linked = await fetch(`${at}/api/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: makeLink(at).split("#in=")[1] }),
  });
  is("a link's code signs in over the API", [linked.status, (linked.headers.get("set-cookie") ?? "").startsWith(`${cookieName()}=`)], [200, true]);

  const got = await fetch(`${at}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a long enough one" }),
  });
  const { token } = (await got.json()) as { token?: string };
  is("signing in hands back a token", typeof token === "string" && token.length > 0, true);
  is("and sets the cookie as well", (got.headers.get("set-cookie") ?? "").startsWith(`${cookieName()}=`), true);

  const held = await fetch(`${at}/api/agents`, { headers: { authorization: `Bearer ${token ?? ""}` } });
  is("the token opens the door the cookie opens", held.status, 200);

  const made = await fetch(`${at}/api/agents`, { headers: { authorization: "Bearer not.a.token" } });
  is("one this copy did not sign does not", made.status, 401);

  // The page holds nothing of the agents': it asks the API, which asks for the
  // login. So it is the same file for everybody, at every address.
  const root = await fetch(`${at}/`, { redirect: "manual" });
  const page = await root.text();
  is("the root is the page, signed in or not", [root.status, root.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  is("and it is the runtime's own, built", page.includes('<div id="app">'), true);
  const deep = await fetch(`${at}/agents/someone/memory/notes/a.html`, { redirect: "manual" });
  is("an address inside it is the same page", await deep.text(), page);

  const docs = await fetch(`${at}/api`, { headers: { accept: "text/html" } });
  is("the docs are open, because they are about the API and not in it", docs.status, 200);
  is("and they are that page too", await docs.text(), page);
  const listed = (await (await fetch(`${at}/api`)).json()) as { path: string }[];
  is("and the same list comes back as JSON", listed.some((one) => one.path === "/api/agents/:id/chat"), true);
  is("every route it answers is in that list", listed.length > 15, true);

  server.close();
}

{
  about("an address the server cannot read");

  const { serve } = await import("#chloe/serve/http");
  const server = serve({
    host: "127.0.0.1",
    port: 0,
    agents: () => new Map(),
    clock: { fire() {} } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const port = (server.address() as { port: number }).port;

  // fetch cannot send a request line or Host the server would refuse, so
  // these go through the client, which sends what it is told.
  const { request: httpRequest } = await import("node:http");
  const statusOf = (path: string, host: string) =>
    new Promise<number>((done) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.on("error", () => done(0));
      req.end();
    });

  is("a path the URL parser cannot read is a 400", await statusOf("//", "127.0.0.1"), 400);
  is("and a Host it cannot read is a 400", await statusOf("/api", "%"), 400);
  const ordinary = await fetch(`http://127.0.0.1:${port}/api/account`);
  is("and the server still answers", ordinary.status, 200);

  server.close();
}

{
  about("a channel's own path, through the server");

  const { serve } = await import("#chloe/serve/http");

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
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [route],
  });
  await new Promise<void>((done) => server.once("listening", done));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  is("the runtime hands a channel its path with no session at all", (await fetch(`${at}${route.path}`, { method: "POST", body: "{}" })).status, 200);
  is("and it really was the channel that answered", reached, 1);

  // Only POST is handed over, so the same path asked any other way is not a
  // path this server has. It is not /api, so the page answers it.
  const asked = await fetch(`${at}${route.path}`, { redirect: "manual" });
  is("its path is not open to a GET", [reached, (await asked.text()).includes('<div id="app">')], [1, true]);

  server.close();
}

{
  about("what a job is started with");

  const { work, checkArgs, WrongArgs } = await import("#chloe/core/steps");

  const takes = z.object({
    customer: z.string().min(1),
    source: z.string().default("somewhere"),
    times: z.coerce.number().default(1),
  });

  let saw: unknown;
  const reader = agentFor({
    ...codeJob("reading", async (w) => {
      saw = w.args;
      return { got: (w.args as { customer: string }).customer };
    }),
    args: takes,
  } as Job);

  await work({ agent: reader, job: reader.jobs[0], input: { customer: "c-12" } });
  is("the job is handed what it was started with", saw, { customer: "c-12", source: "somewhere", times: 1 });

  await work({ agent: reader, job: reader.jobs[0], input: { customer: "x", source: "shop", times: "3" } });
  is("a query string's strings are coerced by the shape", saw, { customer: "x", source: "shop", times: 3 });

  // The point of checking before the run exists: the caller is told, rather
  // than left to read a failed run to find out.
  const refused = (sent: unknown) => {
    try {
      checkArgs(reader.jobs[0], sent);
      return "allowed";
    } catch (error) {
      return error instanceof WrongArgs ? "refused" : "wrong error";
    }
  };
  is("a missing required field is refused", refused({}), "refused");
  is("and so is the wrong type", refused({ customer: 5 }), "refused");
  is("what fits is allowed", refused({ customer: "fine" }), "allowed");
  is("and a message beside it does not stand in for a field", refused({ text: "c-12" }), "refused");

  // A job that declares nothing still reads the message: the envelope rides
  // along outside args, so sending it is never a mistake. Anything else is,
  // because quietly dropping it would read as the job ignoring them.
  const plain = agentFor(codeJob("plain", async () => ({})));
  const saidHello = await work({ agent: plain, job: plain.jobs[0], input: { text: "hello" } })
    .then(() => "allowed")
    .catch((error: unknown) => (error instanceof WrongArgs ? "refused" : "wrong error"));
  is("a message on its own is not args", saidHello, "allowed");
  const sentAnyway = await work({ agent: plain, job: plain.jobs[0], input: { customer: "c-12" } })
    .then(() => "allowed")
    .catch((error: unknown) => (error instanceof WrongArgs ? "refused" : "wrong error"));
  is("a job with no args shape is not started with anything else", sentAnyway, "refused");
  is("and starting it with nothing is fine", (await work({ agent: plain, job: plain.jobs[0] })).steps >= 0, true);

  // Written on the run row rather than held in memory, which is what lets a
  // run that stopped to ask somebody come back to the same input.
  const kept = await work({ agent: reader, job: reader.jobs[0], input: { customer: "kept", text: "a message" } });
  is("the run records what it was started with", JSON.parse(row(kept.runId).args), { customer: "kept", source: "somewhere", times: 1 });
  is("and the message beside it", JSON.parse(row(kept.runId).input).text, "a message");
  is("and a run the clock started records nothing", row((await work({ agent: plain, job: plain.jobs[0] })).runId).args, "{}");
}

{
  about("starting a job over the API");

  const { serve } = await import("#chloe/serve/http");
  const { apiChannel } = await import("#chloe/channels/api");
  const { makeToken, forgetTokens } = await import("#chloe/serve/tokens");

  let started: unknown;
  const agent = agentFor({
    ...codeJob("reading", async (w) => {
      started = w.args;
      return {};
    }),
    args: z.object({ customer: z.string().min(1), source: z.string().default("") }),
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
    } as unknown as import("#chloe/core/clock").Clock,
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

  is("a query string starts it", (await start("?customer=c-12&source=myapp")).status, 200);
  is("and is what the job is handed", fired.at(-1)?.input, { customer: "c-12", source: "myapp" });
  is("on the api channel", fired.at(-1)?.channel, "api");

  is("a JSON body does too", (await start("", '{"customer":"from a body"}')).status, 200);
  is("and wins where they overlap", (await start("?customer=query", '{"customer":"body"}')).status, 200);
  is("the body being the one that counts", (fired.at(-1)?.input as { customer: string }).customer, "body");
  const byHand = await fetch(`${at}/api/agents/test/job/reading?customer=x`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-chloe-channel": "terminal" },
  });
  is("npm run agent says it is the terminal", [byHand.status, fired.at(-1)?.channel], [200, "terminal"]);
  fired.pop();

  // Started and not awaited, so a caller that sent the wrong thing has to be
  // told now or it never finds out.
  const wrong = await start("?source=myapp");
  is("input that does not fit is refused before anything runs", wrong.status, 400);
  is("with the reason", ((await wrong.json()) as { error: string }).error.includes("customer"), true);
  is("and nothing was started", fired.length, 3);

  is("a job that agent does not have is still a 404", (await start("").then(() => fetch(`${at}/api/agents/test/job/nope`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }))).status, 404);

  server.close();
}

{
  about("who a request is really from");

  const { from } = await import("#chloe/serve/login");
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
  about("a second copy stops before it starts anything");

  const { claimPort, serve } = await import("#chloe/serve/http");
  const first = await claimPort("127.0.0.1", 0);
  const port = (first.address() as { port: number }).port;
  const server = serve({
    host: "127.0.0.1",
    port,
    agents: () => new Map(),
    clock: { running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
    heldPort: first,
  });
  await new Promise<void>((done) => server.once("listening", done));
  is("the server takes over the port it was handed", (await fetch(`http://127.0.0.1:${port}/api/health`)).status < 500, true);
  const second = await claimPort("127.0.0.1", port).then(
    () => "",
    (error: Error) => error.message,
  );
  is("a second claim on it is refused, saying why", second.startsWith(`Port ${port} on 127.0.0.1 is taken, most likely by chloe already running.`), true);
  server.close();
}

{
  about("npx chloe --remote: HTTPS on the same port, plain HTTP only from this machine");

  const { claimPort, serve } = await import("#chloe/serve/http");
  const { certificate } = await import("#chloe/serve/certificate");
  const { from } = await import("#chloe/serve/login");
  const { request } = await import("node:https");
  const made = certificate();
  is("the certificate is kept, not made again on every start", certificate().fingerprint, made.fingerprint);

  const held = await claimPort("127.0.0.1", 0);
  const port = (held.address() as { port: number }).port;
  serve({
    host: "127.0.0.1",
    port,
    agents: () => new Map(),
    clock: { running: () => [] } as unknown as import("#chloe/core/clock").Clock,
    channels: () => [],
    heldPort: held,
    certificate: made,
  });

  const secure = (path: string) =>
    new Promise<number>((done, fail) => {
      request({ host: "127.0.0.1", port, path, ca: made.cert, checkServerIdentity: () => undefined }, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      })
        .on("error", fail)
        .end();
    });
  is("the page answers over HTTPS, with that certificate", await secure("/api/health"), 401);
  is("and plain HTTP from this machine still answers, for the commands", (await fetch(`http://127.0.0.1:${port}/api/health`)).status, 401);

  const over = (headers: Record<string, string>) =>
    from({ headers, socket: { remoteAddress: "198.51.100.4", encrypted: true } } as unknown as import("node:http").IncomingMessage);
  is("over chloe's own HTTPS a forwarded address is the caller's own, so it is ignored", over({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "1.2.3.4" }), "198.51.100.4");
  held.close();
}
