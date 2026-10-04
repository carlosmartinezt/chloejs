import { asSchema, type Tool as SdkTool } from "ai";
import { z } from "zod";

import type { ToolSpec } from "./model.ts";

/**
 * What a model can be handed: an id, a description a model reads, a schema for
 * its arguments, and one function.
 */
export interface ToolConfig<Input = any> {
  id: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<unknown> | unknown;
  /**
   * What it reaches right now, in a few lines: the folders of a memory, the
   * tables of a database. Put at the top of every turn and agent step it is
   * handed to, so the model starts out knowing where things are rather than
   * spending calls finding out. Asked again each time, never kept.
   */
  overview?: () => Promise<string> | string;
}

/** The type of `execute`'s argument comes from the schema. */
export function tool<Input = any>(definition: ToolConfig<Input>): ToolConfig<Input> {
  return definition;
}

/**
 * Keyed by the name the model calls them by. A tool made with the AI SDK's
 * `tool()` goes here as it is, with its key as its name, and runs in chloe's
 * own loop like any other.
 */
export type Tools = Record<string, ToolConfig | SdkTool>;

/**
 * The overviews of these tools, one after another, for the top of a prompt.
 * Empty when none has one. One that fails is left out: it is a help to the
 * model, not a reason to stop the turn.
 */
export async function overviewsOf(tools: Tools): Promise<string> {
  const said = await Promise.all(
    [...new Set(Object.values(tools))].map(async (one) => {
      try {
        return (await (one as ToolConfig).overview?.())?.trim() ?? "";
      } catch {
        return "";
      }
    }),
  );
  return said.filter(Boolean).join("\n\n");
}

/** One tool a model asked for: what it was called with, what came back, and whether it was allowed to run at all. */
export interface Call {
  tool: string;
  args: unknown;
  result: unknown;
  /** Set when `approve` would not let it run, in which case nothing ran and `result` is what the model was told. */
  refused?: boolean;
}

/**
 * Asked before a tool runs, with the arguments the model chose. Return `true`
 * to let it run. Anything else stops that one call, and a string is the reason
 * the model is told, so do not answer "yes" when you mean true. Nothing runs
 * while it is deciding, and what it decides is written into the run beside the
 * call. It is your code, so throwing out of it fails the step rather than
 * refusing the call.
 */
export type Approve = (call: { tool: string; args: unknown }) => Promise<boolean | string> | boolean | string;

/**
 * Why a tool cannot be run as it was given, or "" when it can. An AI SDK tool
 * with no `execute` is one the SDK hands back to a page to run, and one with
 * `needsApproval` would run here without asking, because chloe asks with
 * `approve` instead, so both are refused rather than half honoured.
 */
export function cannotRun(name: string, one: unknown): string {
  if (typeof (one as ToolConfig)?.execute !== "function") return `tool ${name} is not a tool.`;
  if ((one as SdkTool).needsApproval) {
    return `tool ${name} has needsApproval, which chloe does not read, so it would run without asking. Take it off, and ask before a tool runs with approve in work.agent().`;
  }
  return "";
}

/** A zod schema, which chloe reads itself so its messages stay its own, rather than one the AI SDK made. */
function isZod(schema: unknown): schema is z.ZodType {
  return typeof (schema as z.ZodType)?.safeParse === "function";
}

/** What the model is told a tool is for. An AI SDK tool may work it out when asked, and is asked with no context. */
export function descriptionOf(one: ToolConfig | SdkTool): string {
  const said = one.description;
  return typeof said === "function" ? said({ context: undefined }) : (said ?? "");
}

export async function describe(name: string, one: ToolConfig | SdkTool): Promise<ToolSpec> {
  const schema = (isZod(one.inputSchema) ? z.toJSONSchema(one.inputSchema, { io: "input" }) : await asSchema(one.inputSchema).jsonSchema) as Record<string, any>;
  // $schema means nothing to a provider and some reject it.
  delete schema.$schema;
  return { name, description: descriptionOf(one), parameters: schema };
}

/** The arguments a model chose, checked against the tool's schema: the value to run it with, or what was wrong. */
export async function check(one: ToolConfig | SdkTool, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
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
 * Runs a tool once. An AI SDK tool is handed the call's id as its second
 * argument, and one that streams its answer is read to the end and its last
 * part kept, which is what the SDK hands the model too.
 */
export async function run(one: ToolConfig | SdkTool, args: unknown, callId: string): Promise<unknown> {
  const output = await (one.execute as (input: unknown, options: unknown) => unknown)(args, { toolCallId: callId, messages: [] });
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    let last: unknown;
    for await (const part of output as AsyncIterable<unknown>) last = part;
    return last;
  }
  return output;
}
