import { asSchema, type Tool, type ToolApprovalConfiguration, type ToolApprovalStatus } from "ai";
import { z } from "zod";

import type { Connection } from "#chloe/connections/connection";

import type { ToolSpec } from "./model.ts";

/**
 * A tool for the model: a tool made with the AI SDK's `tool()`, plus a few
 * optional fields that chloe reads.
 *
 * `tool()` drops fields it does not know, so add these after you make the tool:
 * `Object.assign(tool({ ... }), { needs: google })`.
 */
export type ChloeTool = Tool & {
  /**
   * Returns a few lines about what the tool can reach right now, such as the
   * folders in a memory or the tables in a database.
   *
   * chloe puts this text at the top of the prompt each time the model gets the
   * tool, so the model knows where things are before it starts. It is called
   * again each time. If it throws, its text is left out.
   */
  overview?: () => Promise<string> | string;
  /**
   * The connection this tool works through, such as Google.
   *
   * The Connections page on the dashboard, and the lines chloe prints as it
   * starts, show what that connection still needs. When the tool throws
   * `NeedsSignIn` in a chat, chloe stops the reply and sends the person that
   * connection's sign-in link.
   */
  needs?: Connection;
  /**
   * Set to `true` when the tool only reads or changes the agent's own folder,
   * memory or skills, so nothing it returns came from outside. Off by default.
   *
   * A tool without it counts as reading from outside (mail, a web page, a
   * script, an MCP server). Once such a tool has answered, every
   * `changesAgent` tool is refused for the rest of that reply, because the
   * outside text may be what asked for the change.
   */
  own?: boolean;
  /**
   * Set to `true` to give this tool to the model only when the agent's owner
   * sent the message. Off by default.
   *
   * Replies to anybody else, and markdown jobs, do not get it. Use it for a
   * tool that shows what other people said, such as the agent's past runs.
   */
  forOwner?: boolean;
  /**
   * Set to `true` when the tool changes the agent itself: its instructions,
   * skills or jobs. Off by default.
   *
   * The model gets it only when the agent's owner sent the message and is
   * allowed to change the agent. A job never gets it: an agent step given one
   * fails. It is also refused once a tool that is not `own` has answered in
   * the same reply.
   */
  changesAgent?: boolean;
};

/** Marks each of these tools `own`, and returns them. */
export function ownTools(tools: Tools): Tools {
  for (const one of Object.values(tools)) one.own = true;
  return tools;
}

/** A set of tools. Each key is the name the model calls the tool by, such as `gmailReadEmail`. */
export type Tools = Record<string, ChloeTool>;

/** The connections these tools work through, each once, in the order first met. */
export function connectionsUsed(tools: Tools): Connection[] {
  return [...new Set(Object.values(tools).flatMap((one) => (one.needs ? [one.needs] : [])))];
}

/**
 * Every connection an agent works through, once each: its tools' and its
 * channels'. What the Connections page lists and signs in to, and what a code
 * pasted into a chat can finish.
 */
export function neededBy(agent: { tools?: Tools; channels?: { needs?: Connection }[] }): Connection[] {
  return [...new Set([...connectionsUsed(agent.tools ?? {}), ...(agent.channels ?? []).flatMap((one) => (one.needs ? [one.needs] : []))])];
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
 * What chloe passes to every tool it runs, as `context` in the second argument
 * of `execute`. Read the agent with `agentOf(context)`.
 */
export interface ToolContext {
  /** The agent the tool runs for: its `id`, its `folder`, and its `memory` folder and how it is committed. */
  agent: { id: string; folder: string; memory: { folder: string; commit?: boolean | "each run" } };
  /**
   * Who sent the message, as `channel:id`, such as `telegram:12345`. chloe sets
   * it from the sender, never from the model. Not set in a job.
   */
  user?: string;
}

/**
 * Returns the agent a tool is running for. Pass it the `context` your
 * `execute` got. Throws if the context has no agent.
 */
export function agentOf(context: unknown): ToolContext["agent"] {
  const agent = (context as Partial<ToolContext> | undefined)?.agent;
  if (!agent?.id) throw new Error("This tool was run without the agent it runs for, which chloe hands every tool as its context.");
  return agent;
}

/** One tool call the model made: the tool, what it was called with, and what came back. */
export interface Call {
  /** The name the model called the tool by. */
  toolName: string;
  /** The arguments the model passed. */
  input: unknown;
  /** What the tool returned, or what the model was told when it failed or was refused. */
  output: unknown;
  /**
   * `true` when `toolApproval` or the tool's `needsApproval` did not allow the
   * call. The tool did not run, and `output` is what the model was told.
   */
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
