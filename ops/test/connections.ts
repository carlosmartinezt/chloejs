// An agent's connections: one of its own with a sign-in, and a service's MCP
// server, its tools asked for as the agent loads. The server here is a
// stand-in on a loopback port.

import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";

{
  about("a connection of an agent's own");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const { defineAgent: define } = await import("@chloejs/core");
  const { resolveAgent: resolve } = await import("#chloe/load/load");
  const toolsOf = async (tools: import("@chloejs/core").Tools) => {
    const made = await resolve(define({ id: "mail", folder: await mkdtemp(join(tmpdir(), "chloe-mail-")), model: "m", identity: "", purpose: "Hi.", tools }));
    return Object.keys(made.tools ?? {}).filter((name) => !made.toolsFrom?.[name]).sort();
  };
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
}

{
  about("an MCP connection");
  const { defineAgent } = await import("@chloejs/core");
  const { mcpConnection } = await import("@chloejs/core/connections");
  const { resolveAgent } = await import("#chloe/load/load");
  const { connectionsOf } = await import("#chloe/serve/inside");
  const { run } = await import("#chloe/model/tool");

  // Enough of the protocol for a client: say hello, list two tools, answer one.
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    seen.push(request.headers.authorization ?? "");
    if (request.method !== "POST") return void response.writeHead(405).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id?: number; method: string; params?: any };
    if (message.id === undefined) return void response.writeHead(202).end();
    const answer = (result: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      return answer({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1" } });
    }
    if (message.method === "tools/list") {
      return answer({
        tools: [
          { name: "list_issues", description: "List the issues.", inputSchema: { type: "object", properties: { state: { type: "string" } } } },
          { name: "delete_repo", description: "Delete a repository.", inputSchema: { type: "object", properties: {} } },
        ],
      });
    }
    if (message.method === "tools/call") {
      if (message.params.arguments?.state === "broken") return answer({ content: [{ type: "text", text: "no such state" }], isError: true });
      return answer({ content: [{ type: "text", text: `issues that are ${message.params.arguments?.state}` }] });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

  const github = mcpConnection({ name: "github", url, token: "ghp_test", tools: ["list_issues"] });
  const agent = await resolveAgent(
    defineAgent({ id: "mcp", folder: await mkdtemp(join(tmpdir(), "chloe-mcp-")), model: "m", identity: "", purpose: "Hi.", connections: [github] }) as any,
  );
  is("its tools are named like chloe's own, and only the ones it was given", Object.keys(agent.tools ?? {}).filter((one) => agent.toolsFrom?.[one]?.startsWith("connection ")), ["githubListIssues"]);
  is("the key goes as a bearer key", seen.includes("Bearer ghp_test"), true);
  const context = { agent: { id: "mcp", folder: agent.folder, memory: agent.memory } };
  is("a call reaches the server and hands back its words", await run(agent.tools!.githubListIssues, { state: "open" }, "c1", context), "issues that are open");
  let refused = "";
  try {
    await run(agent.tools!.githubListIssues, { state: "broken" }, "c2", context);
  } catch (error) {
    refused = (error as Error).message;
  }
  is("an error from the server is an error, in its words", refused, "no such state");
  is("the setup page lists it, ready", (await connectionsOf(agent)).filter((one) => one.name === "github").map((one) => one.ready), [true]);

  const empty = mcpConnection({ name: "linear", url, token: process.env.NOTHING_SETS_THIS ?? "" });
  is("one whose key is empty says so", await empty.missing(), ["linear has no key: the token it was handed is empty"]);

  server.close();
  const gone = mcpConnection({ name: "gone", url });
  const without = await resolveAgent(
    defineAgent({ id: "mcp2", folder: await mkdtemp(join(tmpdir(), "chloe-mcp-")), model: "m", identity: "", purpose: "Hi.", connections: [gone] }) as any,
  );
  is("a server that does not answer leaves the agent loading without its tools", Object.keys(without.tools ?? {}).filter((one) => without.toolsFrom?.[one]?.startsWith("connection ")), []);
  is("and the setup page says why", (await connectionsOf(without)).find((one) => one.name === "gone")?.ready, false);
}
