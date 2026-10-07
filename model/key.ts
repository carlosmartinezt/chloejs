// Asking a model on a key, through the AI SDK: the gateway on its key, or a
// model an agent's file gave as an AI SDK model, like anthropic("claude-opus-5-5"),
// which reaches its provider however that package was set up.
//
// Tools are handed over as schemas with nothing to run, so the SDK hands the
// calls back after one step and core/turn.ts runs them. That loop is where
// toolApproval, stopWhen, the budget and the per-step record are, so it stays ours.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema, RetryError, streamText, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";

import { settings, whereKeyGoes } from "#chloe/core/settings";

import type { Answer, Ask, Message, ToolCall } from "./model.ts";

/** A model made by an AI SDK provider package, like anthropic("claude-opus-5-5"). */
export type SdkModel = Exclude<LanguageModel, string>;

/** Every AI SDK model an agent or job has named, by the name it has everywhere else. */
const given = new Map<string, SdkModel>();

/**
 * The name a model goes by in the run record, a chat's choice and the page,
 * which is how everything above ask() can keep talking in names. An AI SDK
 * model is its provider and the provider's own name for it,
 * "anthropic/claude-opus-5-5", and from then on that name means that model on
 * this box, whichever agent asks for it. A gateway model is already named that way.
 */
export function nameOf(model: string | SdkModel): string {
  if (typeof model === "string") return model;
  const name = model.modelId.includes("/") ? model.modelId : `${model.provider.split(".")[0]}/${model.modelId}`;
  given.set(name, model);
  return name;
}

/** The AI SDK model a name stands for, when an agent's file gave one. */
export function sdkModel(name: string): SdkModel | undefined {
  return given.get(name);
}

/** Whether any agent named an AI SDK model. */
export function anySdkModel(): boolean {
  return given.size > 0;
}

/** Dollars per token, as the gateway's list of models writes them. */
interface Price {
  input?: string;
  output?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

/** Each model's price from the gateway's list, kept since it last answered, by its name as `spelling` writes it. */
let prices = new Map<string, Price>();

/**
 * A model's name with the difference between the gateway's and a provider's
 * spelling taken out: the gateway writes "claude-opus-5.5" where Anthropic
 * writes "claude-opus-5-5".
 */
function spelling(name: string): string {
  return name.toLowerCase().replace(/\./g, "-");
}

/**
 * Keeps the prices from the gateway's list of models, which is what a call on
 * a provider's own key is charged at, since that provider says tokens and not
 * dollars. A model missing from the list costs 0 in the record.
 */
export function learnPrices(list: { id?: string; pricing?: Price }[]): void {
  prices = new Map(list.flatMap((one) => (one.id && one.pricing ? [[spelling(one.id), one.pricing]] : [])));
}

/** What a call on a provider's own key cost, in dollars, or 0 when the gateway's list has no price for it. */
export function priced(model: string, usage: LanguageModelUsage): number {
  const price = prices.get(spelling(model));
  if (!price) return 0;
  const per = (one: string | undefined, fallback = 0) => (one === undefined ? fallback : Number(one) || 0);
  const input = per(price.input);
  const { noCacheTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = usage.inputTokenDetails;
  const plain = noCacheTokens ?? (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens;
  return (
    plain * input +
    cacheReadTokens * per(price.input_cache_read, input) +
    cacheWriteTokens * per(price.input_cache_write, input) +
    (usage.outputTokens ?? 0) * per(price.output)
  );
}

/**
 * The gateway as a provider. It speaks the chat-completions shape, so any
 * gateway that does works, and it puts its price in `usage.cost`, which is
 * picked out of the answer here because the SDK only reads tokens.
 */
function gateway(apiKey: string): (id: string) => LanguageModel {
  const costOf = (body: unknown) => {
    const usage = (body as { usage?: { cost?: number; cost_details?: { upstream_inference_cost?: number } } })?.usage;
    // The gateway reports cost 0 for a user's own provider key and puts the
    // real number in upstream_inference_cost.
    return usage?.cost || usage?.cost_details?.upstream_inference_cost || 0;
  };
  let streamed = 0;
  return createOpenAICompatible({
    name: "gateway",
    baseURL: settings.model.gatewayUrl.replace(/\/chat\/completions\/?$/, ""),
    apiKey,
    includeUsage: true,
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }) => ({ gateway: { cost: costOf(parsedBody) } }),
      createStreamExtractor: () => ({
        processChunk: (chunk) => void (streamed = costOf(chunk) || streamed),
        buildMetadata: () => ({ gateway: { cost: streamed } }),
      }),
    },
  });
}

/** chloe's messages in the SDK's shape. A tool's answer names its tool, which chloe's only says on the call. */
function toSdk(messages: Message[]): ModelMessage[] {
  const names = new Map<string, string>();
  return messages.map((message): ModelMessage => {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "user") {
      if (!message.attachments?.length) return { role: "user", content: message.content };
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...message.attachments.map((a) => ({ type: "file" as const, data: a.data, mediaType: a.mediaType, ...(a.filename && { filename: a.filename }) })),
        ],
      };
    }
    if (message.role === "assistant") {
      const calls = message.tool_calls ?? [];
      for (const call of calls) names.set(call.id, call.function.name);
      if (!calls.length) return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.function.name, input: parsed(call.function.arguments) })),
        ],
      };
    }
    const id = message.tool_call_id ?? "";
    return {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, toolName: names.get(id) ?? "", output: { type: "text", value: message.content } }],
    };
  });
}

/** A call's arguments as the model wrote them: an object when they parse, else the text, so nothing is lost. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Asks once on a key, by the gateway or the AI SDK model an agent's file gave,
 * and answers in chloe's shape. With `onText` the answer is streamed and its
 * words handed over as they come; what it costs is read at the end either way.
 */
export async function viaKey({ model, messages, tools, maxOutputTokens, signal, onText }: Ask, route: "gateway" | "direct"): Promise<Answer> {
  let reach: LanguageModel;
  let where: string;
  if (route === "gateway") {
    if (!settings.model.key) {
      throw new Error(
        `No gateway key. Put it ${whereKeyGoes(["model", "key"])}. ` +
          "To run on a subscription instead, put that route first in model.preferredRoute.",
      );
    }
    reach = gateway(settings.model.key)(model);
    where = "the gateway";
  } else {
    const found = sdkModel(model);
    if (!found) throw new Error(`No agent on this box names ${model} as an AI SDK model.`);
    reach = found;
    where = found.provider.split(".")[0];
  }

  try {
    const call = {
      model: reach,
      messages: toSdk(messages),
      allowSystemInMessages: true,
      ...(tools?.length && {
        tools: Object.fromEntries(tools.map((one) => [one.name, tool({ description: one.description, inputSchema: jsonSchema(one.parameters) })])),
      }),
      maxOutputTokens: maxOutputTokens ?? 8000,
      // Four tries in all, for a busy or failing provider. A bad key or a
      // missing model fails the same way forever and is not tried again.
      maxRetries: 3,
      abortSignal: signal ?? AbortSignal.timeout(600_000),
    };
    const result = onText ? await streamed(call, onText) : await generateText(call);
    const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
      id: call.toolCallId,
      type: "function",
      function: { name: call.toolName, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) },
    }));
    // The gateway says what a call cost, ours and the AI SDK's own alike. A
    // provider says tokens, which are priced from the gateway's list.
    const said = Number(result.providerMetadata?.gateway?.cost);
    return {
      text: result.text,
      toolCalls,
      cost: said > 0 ? said : route === "gateway" ? 0 : priced(model, result.usage),
      tokensIn: result.usage.inputTokens ?? 0,
      tokensOut: result.usage.outputTokens ?? 0,
    };
  } catch (error) {
    throw new Error(explained(error, where), { cause: error });
  }
}

/**
 * One call streamed, its words handed to `onText` as they arrive, and the same
 * four things generateText would have answered once it ends. A failure in the
 * middle is thrown, not left as a short answer.
 */
async function streamed(call: Parameters<typeof streamText>[0], onText: (delta: string) => void) {
  let failed: unknown;
  const result = streamText({ ...call, onError: ({ error }) => void (failed = error) });
  for await (const delta of result.textStream) onText(delta);
  if (failed) throw failed;
  const [text, toolCalls, usage, providerMetadata] = await Promise.all([result.text, result.toolCalls, result.usage, result.providerMetadata]);
  return { text, toolCalls, usage, providerMetadata };
}

/** What went wrong, in the words a run record shows. */
function explained(error: unknown, where: string): string {
  const answered = (one: APICallError) => `${where} answered ${one.statusCode ?? "nothing"}: ${(one.responseBody ?? one.message).slice(0, 500)}`;
  if (RetryError.isInstance(error)) {
    const last = error.lastError;
    return `Model call failed after ${error.errors.length} attempts: ${APICallError.isInstance(last) ? answered(last) : String((last as Error)?.message ?? last)}`;
  }
  if (APICallError.isInstance(error)) return `Model call refused: ${answered(error)}`;
  return `Model call refused: ${(error as Error)?.message ?? String(error)}`;
}
