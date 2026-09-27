// Asking a model, by one of three routes.
//
// A model is a string like "anthropic/claude-sonnet-5": a provider, then the
// model's name. The provider decides the route, `routeFor()` below:
//
//   gateway  the Vercel AI Gateway over HTTP, any model, on a key. Any gateway
//            that speaks the same shape works by setting AI_GATEWAY_URL.
//   claude   the Claude Code CLI, Anthropic models, on a Claude subscription.
//   codex    the Codex CLI, OpenAI models, on a ChatGPT plan.
//
// A CLI is the only way to spend a subscription: it authorises the program,
// and there is no key to put in a header. Everything above this file is the
// same either way, which is the reason ask() is the only seam.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { Agent } from "#chloe/load/load.ts";
import { setting, settings } from "#chloe/core/settings.ts";

import { viaClaude } from "./claude.ts";
import { viaCodex } from "./codex.ts";

/** One way a model call goes. */
export type Route = "gateway" | "claude" | "codex";

/** The provider in front of a model's name. A name with none is Anthropic's, the way the CLIs write it. */
export function providerOf(model: string): string {
  const at = model.indexOf("/");
  return at < 0 ? "anthropic" : model.slice(0, at);
}

/** Whether a route can run a provider's models at all. */
function carries(route: Route, provider: string): boolean {
  return route === "gateway" || (route === "claude" && provider === "anthropic") || (route === "codex" && provider === "openai");
}

/**
 * The route a model goes by. MODEL_VIA in the environment settles it for one
 * run; then `model.routes` for its provider; then `model.via` when that route
 * can carry the provider; then what the box has: the gateway with a key, or
 * the provider's own CLI.
 */
export function routeFor(model: string): Route {
  const provider = providerOf(model);
  const forced = process.env.MODEL_VIA;
  if (forced) return checked(forced, "MODEL_VIA");
  const byProvider = settings.model.routes[provider];
  if (byProvider) return byProvider;
  const chosen = settings.model.via;
  if (chosen && carries(chosen, provider)) return chosen;
  if (gatewayKey()) return "gateway";
  return provider === "openai" ? "codex" : "claude";
}

/**
 * The route for a model whose provider says nothing, as `model.via` and the
 * environment settle it. What the startup line reports.
 */
export function via(): Route {
  const chosen = setting(settings.model.via, "MODEL_VIA");
  if (chosen) return checked(chosen, "model.via");
  return gatewayKey() ? "gateway" : "claude";
}

function checked(value: string, where: string): Route {
  if (value === "gateway" || value === "claude" || value === "codex") return value;
  throw new Error(`${where} is ${JSON.stringify(value)}. It is "gateway", "claude" or "codex".`);
}

function gatewayKey(): string {
  return setting(settings.model.key, "AI_GATEWAY_API_KEY");
}

/** The program a CLI route runs, as the environment may rename it. */
function programOf(route: Exclude<Route, "gateway">): string {
  return route === "claude" ? setting("claude", "CLAUDE_BIN") : setting("codex", "CODEX_BIN");
}

function onPath(program: string): boolean {
  if (program.includes("/")) return can(program);
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && can(join(dir, program)));
}

function can(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether this box can send a call down a route: a key for the gateway, the program for a CLI. */
export function runnable(route: Route): boolean {
  return route === "gateway" ? Boolean(gatewayKey()) : onPath(programOf(route));
}

/** One model somebody may pick, and the route it would go by here. */
export interface Offered {
  model: string;
  route: Route;
}

/**
 * The models on offer: `model.models` in settings, plus what the agent and its
 * jobs already name, each with its route, and only those this box can run.
 * Order is the settings' order, then the agent's.
 */
export function models(agent?: Agent): Offered[] {
  const named = [...settings.model.models, ...(agent ? [agent.model, ...agent.jobs.flatMap((job) => (job.model ? [job.model] : []))] : [])];
  const out: Offered[] = [];
  for (const model of named) {
    if (out.some((one) => one.model === model)) continue;
    const route = routeFor(model);
    if (carries(route, providerOf(model)) && runnable(route)) out.push({ model, route });
  }
  return out;
}

/** A file handed to the model with a message: a photo or a PDF. */
export interface Attachment {
  /** Like "image/jpeg" or "application/pdf". */
  mediaType: string;
  /** The file, base64. */
  data: string;
  name?: string;
}

/** In the shape the gateway wants it, apart from attachments, which each way turns into its own. */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** On a user message only. */
  attachments?: Attachment[];
  /** On an assistant message: the tools it asked for. */
  tool_calls?: ToolCall[];
  /** On a tool message: which call this answers. */
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Answer {
  text: string;
  toolCalls: ToolCall[];
  /** Dollars, when the gateway says. */
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Ask {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** The chat-completions shape for a message with files: text first, then each file. */
function forGateway({ attachments, ...message }: Message): unknown {
  if (!attachments?.length) return message;
  const url = (a: Attachment) => `data:${a.mediaType};base64,${a.data}`;
  return {
    ...message,
    content: [
      { type: "text", text: message.content },
      ...attachments.map((a) =>
        a.mediaType.startsWith("image/")
          ? { type: "image_url", image_url: { url: url(a) } }
          : { type: "file", file: { filename: a.name ?? "file", file_data: url(a) } },
      ),
    ],
  };
}

/**
 * Asks a model once and returns what it said, by whichever route its
 * provider goes. The only seam between a key and a subscription.
 */
export function ask(request: Ask): Promise<Answer> {
  const route = routeFor(request.model);
  if (route === "claude") return viaClaude(request);
  if (route === "codex") return viaCodex(request);
  return viaGateway(request);
}

async function viaGateway({ model, messages, tools, maxTokens, signal }: Ask): Promise<Answer> {
  const key = gatewayKey();
  if (!key) {
    throw new Error(
      "No gateway key. Put it in settings.local.json as model.key. " +
        'To run on a subscription instead, set model.via to "claude" or "codex", or route the provider in model.routes.',
    );
  }

  const body = {
    model,
    messages: messages.map(forGateway),
    max_tokens: maxTokens ?? 8000,
    ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
  };

  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await wait(Math.min(2 ** attempt, 8) * 1000, signal);

    const response = await fetch(setting(settings.model.gateway, "AI_GATEWAY_URL"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(600_000),
    }).catch((error: unknown) => error as Error);

    if (response instanceof Error) {
      lastError = response.message;
      continue;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      // A bad key or a missing model fails the same way forever: say so now.
      const worthRetrying = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      lastError = `the gateway answered ${response.status}: ${text}`;
      if (!worthRetrying) throw new Error(`Model call refused: ${lastError}`);
      continue;
    }

    const json = (await response.json()) as GatewayAnswer;
    const choice = json.choices?.[0];
    if (!choice) {
      lastError = "the gateway answered with no choices";
      continue;
    }
    return {
      text: choice.message?.content ?? "",
      toolCalls: choice.message?.tool_calls ?? [],
      // The gateway reports cost 0 for a user's own provider key and puts the
      // real number in upstream_inference_cost.
      cost: json.usage?.cost || json.usage?.cost_details?.upstream_inference_cost || 0,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
    };
  }
  throw new Error(`Model call failed after 4 attempts: ${lastError}`);
}

interface GatewayAnswer {
  choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
  usage?: {
    cost?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_details?: { upstream_inference_cost?: number };
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      fail(new Error("stopped"));
    });
  });
}
