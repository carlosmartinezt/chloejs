// The api channel.

import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, row } from "./shared.ts";

{
  about("the api channel");

  const { apiChannel } = await import("#chloe/channels/api");
  const { recall } = await import("#chloe/model/memory");
  const { serve } = await import("#chloe/serve/http");
  const { makeToken, revokeToken, forgetTokens } = await import("#chloe/serve/tokens");

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
    clock: { fire() {}, running: () => [] } as unknown as import("#chloe/core/clock").Clock,
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
