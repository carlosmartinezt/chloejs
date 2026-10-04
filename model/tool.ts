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

/** Keyed by the name the model calls them by. */
export type Tools = Record<string, ToolConfig>;

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

export function describe(name: string, one: ToolConfig): ToolSpec {
  const schema = z.toJSONSchema(one.inputSchema, { io: "input" }) as Record<string, any>;
  // $schema means nothing to a provider and some reject it.
  delete schema.$schema;
  return { name, description: one.description, parameters: schema };
}
