// What every file in ops/test/ shares, and imports first.
//
// Nothing here
// touches the real database, the real gateway or a real mail account. The
// database is in memory, the gateway is a server on a loopback port that
// answers whatever the case says, so a model step is exercised without
// spending anything, and mail goes to the log.
//
// Where things are kept is read from the environment as the runtime loads, so
// it is set here before any import. The rest is held over the config further
// down, because the suite runs inside whichever project installed the runtime,
// and that project's config would otherwise run every case against a real
// subscription and send real mail.
process.env.CHLOE_DB = ":memory:";
process.env.CHLOE_STATE = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/chloe-test-`);
process.env.CHLOE_MEMORY = `${process.env.CHLOE_STATE}/memory`;

import { createServer } from "node:http";
import { tmpdir } from "node:os";

import { z } from "zod";

// A stand-in gateway, up before anything reads AI_GATEWAY_URL. An answer is
// either what the model said, or a whole message when a case needs it to ask
// for a tool.
type Said = string | { content?: string; tool_calls?: unknown[] };
export const answers: Said[] = [];
export let asked = 0;
/** Counts the calls from zero again. `asked` cannot be assigned from another file. */
export function startCounting(): void {
  asked = 0;
}
/** The messages the last call was sent, for a case that checks what a model was shown. */
export let lastAsked: { role: string; content: string }[] = [];
/** The names of the tools the last call offered. */
export let lastTools: string[] = [];
export const gateway = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const sent = JSON.parse(raw || "{}") as { messages?: typeof lastAsked; tools?: { function?: { name?: string } }[] };
    const messages = sent.messages ?? [];
    // Naming a new conversation runs beside the turn, so it is answered here
    // and never takes an answer a case queued for the agent.
    const naming = messages[0]?.content.startsWith("Name this conversation");
    if (!naming) {
      asked++;
      lastAsked = messages;
      lastTools = (sent.tools ?? []).map((one) => one.function?.name ?? "");
    }
    const next = naming ? `"Late orders."` : (answers.shift() ?? "{}");
    const usage = { cost: 0.0002, prompt_tokens: 10, completion_tokens: 10 };
    const message = typeof next === "string" ? { content: next } : next;
    if ((sent as { stream?: boolean }).stream) {
      // Streamed, the words come in two pieces, so a case can see that they came as they were written.
      const words = message.content ?? "";
      const half = Math.ceil(words.length / 2);
      const chunk = (delta: object, end?: string) =>
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: end ?? null }], ...(end && { usage }) })}\n\n`;
      const calls = (message.tool_calls ?? []).map((one, index) => ({ index, ...(one as object) }));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        (words ? chunk({ role: "assistant", content: words.slice(0, half) }) + chunk({ content: words.slice(half) }) : "") +
          (calls.length ? chunk({ tool_calls: calls }) : "") +
          chunk({}, calls.length ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }], usage }));
  });
});
await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
export const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`;

// Imported after the environment is set, and by hand rather than with a plain
// import, because those are hoisted above the lines above: core/db.ts would
// read CHLOE_DB before it was set and every case would write into the real
// run history. That is not hypothetical, it happened while this was written.
export const { answer, db, reachBy, sweep, waitingFor, waitingOn, work } = await import("@chloejs/core");
(await import("#chloe/core/settings")).holdSettings({
  model: {
    key: "test",
    preferredRoute: ["gateway"],
    gatewayUrl,
    // What opencode can run is read by asking it, so an opencode on the path
    // would put somebody's own models into what the cases expect. The routing
    // cases point this at a stand-in of their own.
    program: { opencode: "/nowhere/opencode" },
  },
  // Signing in and getting locked out both mail, and the addresses used here
  // are made up.
  email: { provider: "none" },
  owner: "test:somebody",
});
await (await import("@chloejs/core")).loadSettings();
export type Agent = import("@chloejs/core").Agent;
export type Job = import("@chloejs/core").Job;
export type Line = import("@chloejs/core").Line;
export type Tools = import("@chloejs/core").Tools;

// The runtime's own site, so whether a page package happens to be installed in
// this repo decides nothing here. A setting, so it is written rather than put in
// the environment, which is only read when the settings are.
export const { settings: live } = await import("@chloejs/core");
export const ownPage = (yes: boolean): void => void (live.dashboard.local = yes ? "builtin" : "");

export const sent: string[] = [];
reachBy("test", async (to, text) => void sent.push(`${to}: ${text}`));

export function codeJob(id: string, run: Job["run"], state?: z.ZodType, response?: Job["response"]): Job {
  return { agent: "test", id, cron: "* * * * *", timezone: "UTC", prompt: "", run, state, response, files: [] };
}

export function agentFor(job: Job): Agent {
  return {
    id: "test",
    folder: tmpdir(),
    memory: { folder: `${tmpdir()}/memory-of-test` },
    description: "",
    model: "anthropic/claude-haiku-4.5",
    instructions: "",
    skills: [],
    jobs: [job],
    channels: [],
    connections: [],
  };
}

export const row = (id: string): any => db.prepare("select * from runs where id = ?").get(id);

/** Push the deadline into the past, which is what waiting does. */
export function timePasses(runId: string): void {
  const parked = { ...JSON.parse(row(runId).parked), expires: new Date(Date.now() - 1000).toISOString() };
  db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), runId);
}
