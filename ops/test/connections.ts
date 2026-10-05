// An agent's connections: a service's MCP server, its tools asked for as the
// agent loads. The server here is a stand-in on a loopback port.

import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";

{
  about("an MCP connection");
  const { defineAgent } = await import("@chloejs/core");
  const { mcpConnection } = await import("@chloejs/core/tools");
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
    defineAgent({ id: "mcp", folder: await mkdtemp(join(tmpdir(), "chloe-mcp-")), model: "m", description: "", instructions: "Hi.", features: { memory: false }, connections: [github] }) as any,
  );
  is("its tools are named like chloe's own, and only the ones it was given", Object.keys(agent.tools ?? {}), ["githubListIssues"]);
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
    defineAgent({ id: "mcp2", folder: await mkdtemp(join(tmpdir(), "chloe-mcp-")), model: "m", description: "", instructions: "Hi.", features: { memory: false }, connections: [gone] }) as any,
  );
  is("a server that does not answer leaves the agent loading without its tools", Object.keys(without.tools ?? {}), []);
  is("and the setup page says why", (await connectionsOf(without)).find((one) => one.name === "gone")?.ready, false);
}
