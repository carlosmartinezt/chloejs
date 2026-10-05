// The tools of one turn, offered to the Claude Code CLI as an MCP server it
// starts itself, so the model asks for a tool the way it was trained to, as a
// real tool call, rather than writing the request as text to be read back.
//
// It runs nothing. A call is answered with a line saying so, the CLI stops
// after the model's first answer (--max-turns 1), and the route reads the calls
// out of the CLI's own record of that answer. The tools run in chloe, checked
// and written down, as on every other route.
//
// Run as its own process, with the path of a JSON file of tool specs:
// `node toolServer.js tools.json`. It imports nothing, because it is started
// by the CLI and not by the runtime.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as { name: string; description: string; parameters: unknown }[];

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let asked: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
  try {
    asked = JSON.parse(line);
  } catch {
    return;
  }
  // A notification has no id and wants no answer.
  if (asked.id === undefined) return;
  const answer = (result: unknown) => send({ jsonrpc: "2.0", id: asked.id, result });
  if (asked.method === "initialize") {
    return answer({ protocolVersion: asked.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chloe", version: "1" } });
  }
  if (asked.method === "tools/list") {
    return answer({ tools: tools.map((one) => ({ name: one.name, description: one.description, inputSchema: one.parameters })) });
  }
  if (asked.method === "tools/call") {
    return answer({ content: [{ type: "text", text: "Asked for. Its result comes in the next message." }] });
  }
  send({ jsonrpc: "2.0", id: asked.id, error: { code: -32601, message: `${asked.method} is not answered here.` } });
});
