// Ask the model, run the tools it asked for, put the answers back, ask again.
// Every step is written to the run as it happens, because a job that goes
// wrong at four in the morning is only debuggable if that record exists.
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { db } from "#chloe/core/db.ts";
import { oneLineSummary } from "#chloe/core/markdown.ts";
import type { Agent, Skill } from "#chloe/load/load.ts";
import { ask, type Attachment, type Message, type ToolCall } from "#chloe/model/model.ts";
import { recall, remember } from "#chloe/model/memory.ts";
import { describe, type Approve, type Call, type Tool, type Tools } from "#chloe/model/tool.ts";

export interface Ask {
  agent: Agent;
  prompt: string;
  /** Photos and PDFs that came with the prompt. Seen this turn only: the thread keeps the words. */
  attachments?: Attachment[];
  /** When this job wants one the agent does not normally use. */
  model?: string;
  /** Without one, the turn starts fresh. */
  thread?: string;
  /** What woke it: a job id, a channel name, "studio", "eval". */
  source: string;
  /** Who this run is for, as an address. One column, and the team version reads it. */
  owner?: string;
  /** Answer tools from here instead of running them. For evals. */
  instead?: (name: string, args: unknown) => Promise<unknown> | unknown;
  signal?: AbortSignal;
}

/** What one turn came back with, including every tool call it made on the way. */
export interface Result {
  runId: string;
  text: string;
  steps: number;
  cost: number;
  calls: Call[];
}

/** Dollars, at the size these numbers actually are: $0.0004 and $0.10, not $0.00 and $0.1. */
export function money(amount: number): string {
  return `$${amount.toFixed(4).replace(/(\.\d\d)0+$/, "$1")}`;
}

const MAX_STEPS = 40;

/**
 * Runs a prompt: ask a model, run the tools it asked for, put the answers
 * back, ask again, until it stops asking.
 */
export async function turn({ agent, prompt, attachments, model, thread, source, owner, instead, signal }: Ask): Promise<Result> {
  const runId = randomUUID();
  const using = model ?? agent.model;
  const tools = { ...(agent.tools ?? {}), skill: skillTool(agent.skills) };

  const started = new Date().toISOString();
  db.prepare(
    "insert into runs (id, agent, started, source, model, prompt, kind, owner) values (?, ?, ?, ?, ?, ?, 'turn', ?)",
  ).run(runId, agent.name, started, source, using, prompt, owner ?? null);

  const messages: Message[] = [
    { role: "system", content: systemPrompt(agent) },
    ...(thread ? recall(thread, undefined, { tools: true }) : []),
    { role: "user", content: prompt, attachments },
  ];
  if (thread) remember(thread, "user", prompt);

  const trace: LoopStep[] = [];
  const calls: Result["calls"] = [];
  let cost = 0;
  let steps = 0;

  try {
    const done = await loop({
      model: using,
      messages,
      tools,
      maxSteps: agent.maxSteps ?? MAX_STEPS,
      signal,
      instead,
      onStep: (line) => {
        trace.push(line);
        if (line.tool) calls.push({ tool: line.tool, args: line.args, result: line.result });
        save(runId, trace.filter((one) => (one as { say?: string }).say !== undefined).length, costOf(trace), trace);
      },
    });
    cost = done.cost;
    steps = done.steps;
    if (done.stopped) {
      fail(runId, done.text, steps, cost, trace);
      return { runId, text: done.text, steps, cost, calls };
    }
    finish(runId, done.text, steps, cost, trace);
    if (thread) remember(thread, "assistant", done.text, calls);
    return { runId, text: done.text, steps, cost, calls };
  } catch (error) {
    fail(runId, String(error instanceof Error ? error.message : error), steps, cost, trace);
    throw error;
  }
}

/** What one turn of the loop did: what the model said, or one tool it ran. */
export interface LoopStep {
  step: number;
  say?: string;
  wants?: string[];
  tool?: string;
  args?: unknown;
  result?: unknown;
  failed?: boolean;
  /** Set on a call the job would not allow. It never ran. */
  refused?: boolean;
  cost?: number;
}

/**
 * Ask, run what it asked for, ask again, until it stops asking or hits a limit.
 * Nothing here writes to the database: `turn` records a conversation and a
 * job's agent step records one line, and they both run this.
 *
 * `stopped` says which limit ended it, "steps" or "budget", and is false when
 * it finished. Hitting a limit is an answer and not a crash.
 */
export async function loop(options: {
  model: string;
  messages: Message[];
  tools: Tools;
  maxSteps: number;
  /**
   * The most this may spend, in dollars. Checked between turns, because what a
   * turn costs is only known once it has been paid for, so the turn that goes
   * over the line is paid for.
   */
  budget?: number;
  signal?: AbortSignal;
  instead?: Ask["instead"];
  /** Asked before each tool runs. Without one, everything it was given may run. */
  approve?: Approve;
  onStep?: (line: LoopStep) => void;
}): Promise<{ text: string; steps: number; cost: number; calls: Result["calls"]; stopped: false | "steps" | "budget" }> {
  const specs = Object.entries(options.tools).map(([name, one]) => describe(name, one));
  const calls: Result["calls"] = [];
  let cost = 0;
  let steps = 0;

  for (; steps < options.maxSteps; steps++) {
    const answer = await ask({ model: options.model, messages: options.messages, tools: specs, signal: options.signal });
    cost += answer.cost;
    options.onStep?.({ step: steps, say: answer.text, wants: answer.toolCalls.map((c) => c.function.name), cost: answer.cost });

    if (answer.toolCalls.length === 0) {
      return { text: answer.text, steps: steps + 1, cost, calls, stopped: false };
    }

    // Out of money before running what it asked for, because running the tools
    // only leads to a turn there is nothing left to pay for.
    if (options.budget !== undefined && cost >= options.budget) {
      return { text: `Stopped after spending ${money(cost)} without finishing.`, steps: steps + 1, cost, calls, stopped: "budget" };
    }

    // Has to go back exactly as it came, or the provider rejects the tool
    // answers that follow it.
    options.messages.push({ role: "assistant", content: answer.text, tool_calls: answer.toolCalls });

    for (const call of answer.toolCalls) {
      const { output, args, failed, refused } = await runTool(options.tools, call, options.instead, options.approve);
      calls.push({ tool: call.function.name, args, result: output, ...(refused && { refused }) });
      options.onStep?.({ step: steps, tool: call.function.name, args, result: clip(output), ...(failed && { failed }), ...(refused && { refused }) });
      options.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
  }

  // Out of steps is an answer, not a crash: an empty string here would read as
  // nothing being wrong.
  return { text: `Stopped after ${steps} steps without finishing.`, steps, cost, calls, stopped: "steps" };
}

/** What the trace says has been spent so far, for the record written as it goes. */
function costOf(trace: unknown[]): number {
  return trace.reduce((sum: number, one) => sum + (((one as { cost?: number }).cost) ?? 0), 0);
}

// A missing tool, bad arguments and a tool that threw all go back to the model
// as text it can act on. Dying here loses the work the turn had already done.
async function runTool(
  tools: Tools,
  call: ToolCall,
  instead?: Ask["instead"],
  approve?: Approve,
): Promise<{ output: unknown; args: unknown; failed?: boolean; refused?: boolean }> {
  const name = call.function.name;
  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { output: `${name} was called with arguments that are not valid JSON.`, args: call.function.arguments, failed: true };
  }

  const one = tools[name];
  if (!one) return { output: `There is no tool called ${name}. You have: ${Object.keys(tools).join(", ")}`, args, failed: true };

  const checked = one.inputSchema.safeParse(args);
  if (!checked.success) {
    return { output: `${name} was called wrongly: ${checked.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`, args, failed: true };
  }

  // Asked once the arguments are known and before anything runs, because what
  // makes a call worth stopping is usually the arguments rather than the tool.
  if (approve) {
    let allowed: boolean | string;
    try {
      allowed = await approve({ tool: name, args: checked.data });
    } catch (error) {
      throw new Error(`Deciding whether ${name} could run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (allowed !== true) {
      const why = typeof allowed === "string" && allowed.trim() !== "" ? allowed : "the job did not allow it";
      return {
        output: `${name} was not allowed: ${why}. Try another way, or finish with what you have.`,
        args: checked.data,
        refused: true,
      };
    }
  }

  try {
    const output = instead ? await instead(name, checked.data) : await one.execute(checked.data);
    return { output: output ?? { ok: true }, args: checked.data };
  } catch (error) {
    return { output: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, args: checked.data, failed: true };
  }
}

// The model sees each skill's name and one sentence, and opens the body only
// when it applies. In the system prompt instead, every skill would cost its
// full text on every step of every turn.
function skillTool(skills: Skill[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    id: "skill",
    description:
      "Open one of your skills and read what it says. A skill tells you when to do something and " +
      "how. Open the skill before doing the thing it covers.",
    inputSchema: z.object({ name: z.string().describe("The skill's name, from the list in your instructions.") }),
    execute: ({ name }: { name: string }) => {
      const found = byName.get(name);
      if (!found) throw new Error(`No skill called ${JSON.stringify(name)}. You have: ${[...byName.keys()].join(", ")}`);
      return found.body;
    },
  };
}

function systemPrompt(agent: Agent): string {
  const parts = [agent.instructions];
  if (agent.skills.length > 0) {
    parts.push(
      "## Your skills\n\n" +
        "Open one with the `skill` tool before doing the thing it covers.\n\n" +
        agent.skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n"),
    );
  }
  parts.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
  return parts.join("\n\n");
}

function save(runId: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set steps = ?, cost = ?, trace = ? where id = ?").run(
    steps, cost, JSON.stringify(trace), runId,
  );
}

function finish(runId: string, reply: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, reply = ?, summary = ?, steps = ?, cost = ?, trace = ? where id = ?").run(
    new Date().toISOString(), reply, oneLineSummary(reply), steps, cost, JSON.stringify(trace), runId,
  );
}

function fail(runId: string, error: string, steps: number, cost: number, trace: unknown[]): void {
  db.prepare("update runs set finished = ?, error = ?, steps = ?, cost = ?, trace = ? where id = ?").run(
    new Date().toISOString(), error, steps, cost, JSON.stringify(trace), runId,
  );
}

/** So one tool answer in the record is not a megabyte of HTML. */
function clip(output: unknown): unknown {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.length > 4000 ? `${text.slice(0, 4000)}...[${text.length} bytes]` : output;
}
