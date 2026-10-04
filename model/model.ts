// Asking a model, by one of five routes.
//
// A model is a string like "anthropic/claude-sonnet-5": a provider, then the
// model's name. Which route it goes by is `routeFor()` below:
//
//   claude    the Claude Code CLI, Anthropic models, on a Claude subscription.
//   codex     the Codex CLI, OpenAI models, on a ChatGPT plan.
//   opencode  the opencode CLI, whatever it is signed in to.
//   direct    an AI SDK model an agent's file gave, like
//             anthropic("claude-opus-5-5"), however its package was set up.
//             Never set in settings: naming the model in code is what says it.
//   gateway   the Vercel AI Gateway over HTTP, any model, on a key, charged per
//             call. Any gateway that speaks the chat-completions shape works by
//             setting model.gateway.
//
// The last two go through the AI SDK, in key.ts.
//
// A CLI is the only way to spend a subscription: it authorises the program,
// and there is no key to put in a header. Everything above this file is the
// same either way, which is the reason ask() is the only seam.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { Agent } from "#chloe/load/load";
import { nameInEnv, settingInEnv, settings } from "#chloe/core/settings";

import { viaClaude } from "./claude.ts";
import { viaCodex } from "./codex.ts";
import { anySdkModel, learnPrices, sdkModel, viaKey } from "./key.ts";
import { forgetOpencodeModels, opencodeModels, viaOpencode } from "./opencode.ts";

export type { Route } from "#chloe/core/settings";
import { ROUTES, type Route } from "#chloe/core/settings";

/** The provider in front of a model's name. A name with none is Anthropic's, the way the CLIs write it. */
export function providerOf(model: string): string {
  const at = model.indexOf("/");
  return at < 0 ? "anthropic" : model.slice(0, at);
}

/**
 * Whether a route can run a provider's models at all. The gateway carries any
 * provider, each subscription CLI carries its own, and opencode carries whatever
 * it is signed in to, which it is asked for rather than told.
 */
function carries(route: Route, provider: string): boolean {
  if (route === "gateway") return true;
  if (route === "claude") return provider === "anthropic";
  if (route === "codex") return provider === "openai";
  return opencodeModels().some((model) => providerOf(model) === provider);
}

/** How a model is reached: a route in settings, or "direct" for an AI SDK model an agent's file gave. */
export type Reach = Route | "direct";

/**
 * The route a model goes by: "direct" when an agent's file gave it as an AI SDK
 * model, since the code said exactly how. Otherwise `model.routes` for its provider, else the first
 * entry in `model.prefer` that can carry that provider and is set up here. The
 * environment settles it for a whole run, so it beats a provider's own route.
 *
 * Nothing is left when a box has no credential at all, and then it is the
 * gateway, which says a key is missing rather than handing a model name to a CLI
 * that would refuse it for a second reason.
 */
export function routeFor(model: string): Reach {
  if (sdkModel(model)) return "direct";
  const provider = providerOf(model);
  const forced = settingInEnv(process.env, ["model", "prefer"]);
  if (forced) {
    const first = forced.split(",").map((one) => one.trim()).filter(Boolean)[0] ?? "";
    return checked(first, nameInEnv(["model", "prefer"]));
  }
  const byProvider = settings.model.routes[provider];
  if (byProvider) return byProvider;
  return settings.model.prefer.find((route) => carries(route, provider) && runnable(route)) ?? "gateway";
}

function checked(value: string, where: string): Route {
  if ((ROUTES as readonly string[]).includes(value)) return value as Route;
  throw new Error(`${where} is ${JSON.stringify(value)}. It is ${ROUTES.map((one) => JSON.stringify(one)).join(", ")}.`);
}

function gatewayKey(): string {
  return settings.model.key;
}

/** The program a CLI route runs, which `model.program` may rename. */
function programOf(route: Exclude<Route, "gateway">): string {
  return settings.model.program[route];
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

/**
 * Whether this box can send a call down a route: a key for the gateway, the
 * program for a CLI. An AI SDK model always can, as far as chloe knows: its
 * package holds the key and says so when it is missing.
 */
export function runnable(route: Reach): boolean {
  if (route === "direct") return true;
  return route === "gateway" ? Boolean(gatewayKey()) : onPath(programOf(route));
}

/** The gateway's own list, once it has answered. Empty until then, and it is only an offer. */
let fromGateway: string[] = [];

/**
 * What to offer when nobody wrote a shortlist: everything each route this box has
 * says it can run. Hundreds, usually, which is why `model.models` exists to cut
 * it down.
 */
function shortlist(): string[] {
  if (settings.model.models.length) return settings.model.models;
  return [...new Set([...fromGateway, ...(runnable("opencode") ? opencodeModels() : [])])].sort();
}

/**
 * Ask the gateway what it carries, for the list somebody picks from, and what
 * each model costs, for a call on a provider's own key. Called at startup and on
 * each reload, never from a request: a slow gateway must not hold up a page, and
 * until it answers the offer is the shortlist and the agents' own models. The
 * address is the chat one with its last part swapped, which is the same for
 * every gateway that speaks this shape. Asked with no gateway key too when an
 * agent names an AI SDK model, because the list is public and its prices are
 * what such a call is charged at.
 */
export async function learnModels(): Promise<void> {
  forgetOpencodeModels();
  const key = gatewayKey();
  if (!key) fromGateway = [];
  if (!key && !anySdkModel()) return;
  try {
    const response = await fetch(settings.model.gateway.replace(/\/chat\/completions\/?$/, "/models"), {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { data?: { id?: string; pricing?: Record<string, string> }[] };
    learnPrices(body.data ?? []);
    if (!key) return;
    fromGateway = (body.data ?? []).map((one) => one.id).filter((id): id is string => typeof id === "string" && id.includes("/"));
  } catch {
    // A gateway that cannot be reached is not an error here: it only means the
    // list somebody picks from is shorter until the next reload.
  }
}

/** One model somebody may pick, and the route it would go by here. */
export interface Offered {
  model: string;
  route: Reach;
}

/**
 * The models on offer: `model.models` in settings, plus what the agent and its
 * jobs already name, each with its route, and only those this box can run.
 * Order is the settings' order, then the agent's.
 */
export function models(agent?: Agent): Offered[] {
  const named = [...shortlist(), ...(agent ? [agent.model, ...agent.jobs.flatMap((job) => (job.model ? [job.model] : []))] : [])];
  const out: Offered[] = [];
  for (const model of named) {
    if (out.some((one) => one.model === model)) continue;
    const route = routeFor(model);
    if ((route === "direct" || carries(route, providerOf(model))) && runnable(route)) out.push({ model, route });
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

/** A message in the chat-completions shape, apart from attachments, which each route turns into its own. */
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
  /** What a CLI model wrote after its requests as if they had run. Never acted on. */
  dropped?: string;
  /** Dollars: what the gateway says, or a provider's tokens at the gateway's list price, or 0 when neither is known. */
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The plan behind a route has run out for now, so every call fails until it
 * resets. The message is written to be shown to whoever is waiting on a reply.
 */
export class UsageLimit extends Error {}

export interface Ask {
  /** A model's name. An AI SDK model is named by nameOf() first. */
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Asks a model once and returns what it said, by whichever route its
 * provider goes. The only seam between a key and a subscription.
 */
export function ask(request: Ask): Promise<Answer> {
  const route = routeFor(request.model);
  if (route === "claude") return viaClaude(request);
  if (route === "codex") return viaCodex(request);
  if (route === "opencode") return viaOpencode(request);
  return viaKey(request, route);
}
