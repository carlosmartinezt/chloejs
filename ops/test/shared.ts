// What every file in ops/test/ shares, and imports first.
//
// Nothing here
// touches the real database, the real gateway or a real mail account. The
// database is in memory, the gateway is a server on a loopback port that
// answers whatever the case says, so a model step is exercised without
// spending anything, and mail goes to the log.
//
// These are set rather than declared, because the environment beats the config:
// a box whose chloe.config.ts prefers "claude" would otherwise run every
// case against a real subscription, slowly, and score differently from the
// next box.
process.env.CHLOE_DB = ":memory:";
// Folders of their own, so a case that writes state (an account) or a note
// cannot land in the real ones. Set before any import, like the database above.
process.env.AGENTS_STATE = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/chloe-test-`);
process.env.AGENTS_MEMORY = `${process.env.AGENTS_STATE}/memory`;
process.env.CHLOE_OWNER = "test:somebody";
process.env.AI_GATEWAY_API_KEY = "test";
process.env.MODEL_VIA = "gateway";
// Signing in and getting locked out both mail, and the addresses used here are
// made up. Without this the suite sends two real emails on a box that has a
// mail key, because the alert settings are read from the same file.
process.env.EMAIL_PROVIDER = "none";
// What opencode can run is read by asking it, so an opencode on the path would
// put somebody's own models into what the cases expect. The routing cases point
// this at a stand-in of their own.
process.env.CHLOE_MODEL_PROGRAM_OPENCODE = "/nowhere/opencode";

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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: typeof next === "string" ? { content: next } : next }],
        usage: { cost: 0.0002, prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
});
await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
process.env.AI_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`;

// Imported after the environment is set, and by hand rather than with a plain
// import, because those are hoisted above the lines above: core/db.ts would
// read CHLOE_DB before it was set and every case would write into the real
// run history. That is not hypothetical, it happened while this was written.
export const { answer, db, reachBy, sweep, waitingFor, waitingOn, work } = await import("@chloejs/core");
export type Agent = import("@chloejs/core").Agent;
export type Job = import("@chloejs/core").Job;
export type Line = import("@chloejs/core").Line;
export type Tools = import("@chloejs/core").Tools;

// The runtime's own site, so whether a page package happens to be installed in
// this repo decides nothing here. A setting, so it is written rather than put in
// the environment, which is only read when the settings are.
export const { settings: live } = await import("@chloejs/core");
export const ownPage = (yes: boolean): void => void (live.page = yes ? "builtin" : "");

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
  };
}

export const row = (id: string): any => db.prepare("select * from runs where id = ?").get(id);

/** Push the deadline into the past, which is what waiting does. */
export function timePasses(runId: string): void {
  const parked = { ...JSON.parse(row(runId).parked), expires: new Date(Date.now() - 1000).toISOString() };
  db.prepare("update runs set parked = ? where id = ?").run(JSON.stringify(parked), runId);
}
