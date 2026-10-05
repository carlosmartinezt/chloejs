import { asSchema, type Tool, type ToolApprovalConfiguration, type ToolApprovalStatus } from "ai";
import { z } from "zod";

import type { Connector } from "#chloe/connectors/connector";

import type { ToolSpec } from "./model.ts";

/**
 * A tool made with the AI SDK's `tool()`, with two fields of chloe's own, added
 * after making it, `Object.assign(tool({ ... }), { overview })`, because
 * `tool()` does not take a field it does not know.
 *
 * `overview` is what the tool reaches right now, in a few lines (the folders of
 * a memory, the tables of a database), put at the top of every turn and agent
 * step it is handed to, so the model starts out knowing where things are. Asked
 * again each time, never kept. `needs` is the connector it works through: the
 * setup page asks that connector what is missing, and when the tool throws
 * `NeedsSignIn` the runtime runs that connector's sign-in, so an agent that can
 * read mail can get somebody signed in to read it.
 */
export type ChloeTool = Tool & { overview?: () => Promise<string> | string; needs?: Connector };

/** Tools keyed by the name the model calls them by. */
export type Tools = Record<string, ChloeTool>;

/** The connectors these tools work through, each once, in the order first met. */
export function connectorsOf(tools: Tools): Connector[] {
  return [...new Set(Object.values(tools).flatMap((one) => (one.needs ? [one.needs] : [])))];
}

/**
 * The overviews of these tools, one after another, for the top of a prompt.
 * Empty when none has one. One that fails is left out: it is a help to the
 * model, not a reason to stop the turn.
 */
export async function overviewsOf(tools: Tools): Promise<string> {
  const said = await Promise.all(
    [...new Set(Object.values(tools))].map(async (one) => {
      try {
        return (await one.overview?.())?.trim() ?? "";
      } catch {
        return "";
      }
    }),
  );
  return said.filter(Boolean).join("\n\n");
}

/**
 * What every tool chloe runs is handed as its `context`, the second argument
 * to `execute`: the agent it runs for. Read it with `agentOf(context)`.
 */
export interface ToolContext {
  agent: { id: string; folder: string; memory: { folder: string; commit?: boolean | "each run" } };
}

/** The agent a tool is running for, out of the `context` its `execute` was handed. */
export function agentOf(context: unknown): ToolContext["agent"] {
  const agent = (context as Partial<ToolContext> | undefined)?.agent;
  if (!agent?.id) throw new Error("This tool was run without the agent it runs for, which chloe hands every tool as its context.");
  return agent;
}

/** One tool a model asked for: what it was called with, what came back, and whether it was allowed to run at all. */
export interface Call {
  toolName: string;
  input: unknown;
  output: unknown;
  /** Set when `toolApproval` or `needsApproval` would not let it run, in which case nothing ran and `output` is what the model was told. */
  refused?: boolean;
}

/**
 * Whether one call may run, as the AI SDK decides it: `toolApproval` first,
 * then the tool's own `needsApproval`. `run` to run it, `denied` with the
 * reason the model is told, or `person` when somebody has to say yes first,
 * which is "user-approval" or a `needsApproval` that says so. Throwing out of
 * either fails the step rather than refusing the call.
 */
export async function approval(
  tools: Tools,
  name: string,
  input: unknown,
  toolCallId: string,
  context: ToolContext,
  toolApproval?: ToolApprovalConfiguration<any, any>,
): Promise<{ run: true } | { denied: string } | { person: string }> {
  const one = tools[name];
  let status: ToolApprovalStatus;
  if (typeof toolApproval === "function") {
    status = await toolApproval({ toolCall: { type: "tool-call", toolCallId, toolName: name, input }, tools, toolsContext: { [name]: context }, runtimeContext: {}, messages: [] });
  } else {
    const own = toolApproval?.[name];
    status = typeof own === "function" ? await own(input, { toolCallId, messages: [], toolContext: context, runtimeContext: {} } as never) : own;
  }
  const type = typeof status === "object" ? status.type : status;
  const reason = (typeof status === "object" ? status.reason?.trim() : undefined) ?? "";
  if (type === "approved") return { run: true };
  if (type === "denied") return { denied: reason || "it was denied" };
  if (type === "user-approval") return { person: reason };
  const needs =
    typeof one.needsApproval === "function" ? await one.needsApproval(input, { toolCallId, messages: [], context } as never) : one.needsApproval;
  return needs ? { person: "" } : { run: true };
}

/**
 * Why a tool cannot be run as it was given, or "" when it can: one with no
 * `execute` is one the AI SDK hands back to a page to run.
 */
export function cannotRun(name: string, one: unknown): string {
  return typeof (one as Tool)?.execute !== "function" ? `tool ${name} is not a tool: it has no execute.` : "";
}

/** A zod schema, which chloe reads itself so its messages stay its own, rather than another the AI SDK takes. */
function isZod(schema: unknown): schema is z.ZodType {
  return typeof (schema as z.ZodType)?.safeParse === "function";
}

/** What the model is told a tool is for. A tool may work it out when asked, and is asked with no context. */
export function descriptionOf(one: Tool): string {
  const said = one.description;
  return typeof said === "function" ? said({ context: undefined }) : (said ?? "");
}

export async function describe(name: string, one: Tool): Promise<ToolSpec> {
  const schema = (isZod(one.inputSchema) ? z.toJSONSchema(one.inputSchema, { io: "input" }) : await asSchema(one.inputSchema).jsonSchema) as Record<string, any>;
  // $schema means nothing to a provider and some reject it.
  delete schema.$schema;
  return { name, description: descriptionOf(one), parameters: schema };
}

/** The arguments a model chose, checked against the tool's schema: the value to run it with, or what was wrong. */
export async function check(one: Tool, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
  if (isZod(one.inputSchema)) {
    const checked = one.inputSchema.safeParse(args);
    return checked.success
      ? { ok: true, value: checked.data }
      : { ok: false, why: checked.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ") };
  }
  const validate = asSchema(one.inputSchema).validate;
  if (!validate) return { ok: true, value: args };
  const checked = await validate(args);
  return checked.success ? { ok: true, value: checked.value } : { ok: false, why: checked.error.message };
}

/**
 * Runs a tool once. It is handed the call's id and its `context` as its second argument, and
 * one that streams its answer is read to the end and its last
 * part kept, which is what the SDK hands the model too.
 */
export async function run(one: Tool, args: unknown, callId: string, context: ToolContext): Promise<unknown> {
  const output = await (one.execute as (input: unknown, options: unknown) => unknown)(args, { toolCallId: callId, messages: [], context });
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    let last: unknown;
    for await (const part of output as AsyncIterable<unknown>) last = part;
    return last;
  }
  return output;
}
