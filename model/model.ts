// Asking a model, by one of five routes.
//
// A model is a string like "anthropic/claude-sonnet-5": a provider, then the
// model's name. Which route it goes by is `routeFor()` below, unless the
// string ends in one, "openai/gpt-5.5 via gateway":
//
//   claude    the Claude Code CLI, Anthropic models, on a Claude subscription.
//   codex     the Codex CLI, OpenAI models, on a ChatGPT plan.
//   opencode  the opencode CLI, whatever it is signed in to.
//   direct    the provider's own API, on its key in model.keys, charged per
//             call. An AI SDK model an agent's file gave, like
//             anthropic("claude-opus-5-5"), always goes this way, however its
//             package was set up, whatever preferredRoute says.
//   gateway   the Vercel AI Gateway over HTTP, any model, on a key, charged per
//             call. Any gateway that speaks the chat-completions shape works by
//             setting model.gatewayUrl.
//
// The last two go through the AI SDK, in key.ts.
//
// A CLI is the only way to spend a subscription: it authorises the program,
// and there is no key to put in a header. Everything above this file is the
// same either way, which is the reason ask() is the only seam.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { Agent } from "#chloe/load/load";
import { ROUTES, settings } from "#chloe/core/settings";

import { claudeModels, viaClaude } from "./claude.ts";
import { codexModels, viaCodex } from "./codex.ts";
import { anyOwnKey, anySdkModel, learnPrices, ownKey, sdkModel, spelling, viaKey } from "./key.ts";
import { forgetOpencodeModels, opencodeModels, viaOpencode } from "./opencode.ts";

export type { Route } from "#chloe/core/settings";
import type { Route } from "#chloe/core/settings";

const VIA = new RegExp(` via (${ROUTES.join("|")})$`);

/**
 * A model's name without the route it may end in, and that route:
 * "openai/gpt-5.5 via gateway" is "openai/gpt-5.5" and "gateway".
 */
export function viaOf(model: string): { name: string; via?: Route } {
  const found = model.match(VIA);
  return found ? { name: model.slice(0, found.index), via: found[1] as Route } : { name: model };
}

/** The provider in front of a model's name. A name with none is Anthropic's, the way the CLIs write it. */
export function providerOf(model: string): string {
  const at = model.indexOf("/");
  return at < 0 ? "anthropic" : model.slice(0, at);
}

/**
 * Whether a route can run a provider's models at all. The gateway carries any
 * provider, each subscription CLI carries its own, the direct route each
 * provider with a key in `model.keys`, and opencode whatever it is signed in
 * to, which it is asked for rather than told.
 */
function carries(route: Route, provider: string): boolean {
  if (route === "gateway") return true;
  if (route === "direct") return Boolean(ownKey(provider));
  if (route === "claude") return provider === "anthropic";
  if (route === "codex") return provider === "openai";
  return opencodeModels().some((model) => providerOf(model) === provider);
}

/**
 * The route a model goes by: "direct" when an agent's file gave it as an AI SDK
 * model, since the code said exactly how. Then the route its name ends in, as
 * "openai/gpt-5.5 via gateway", whether or not that route is set up, so a
 * missing key is said rather than another account charged. Otherwise the first
 * entry in `model.preferredRoute` that can carry that provider and is set up here.
 *
 * Nothing is left when a box has no credential at all, and then it is the
 * gateway, which says a key is missing rather than handing a model name to a CLI
 * that would refuse it for a second reason.
 */
export function routeFor(model: string): Route {
  const { name, via } = viaOf(model);
  if (sdkModel(name)) return "direct";
  if (via) return via;
  const provider = providerOf(name);
  return settings.model.preferredRoute.find((route) => carries(route, provider) && runnable(route)) ?? "gateway";
}

function gatewayKey(): string {
  return settings.model.key;
}

/** The program a CLI route runs, which `model.program` may rename. */
function programOf(route: Exclude<Route, "gateway" | "direct">): string {
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
 * Whether this box can send a call down a route: a key for the gateway, at
 * least one in `model.keys` for the direct route, the program for a CLI. An AI
 * SDK model can whatever this says, as far as chloe knows: its package holds
 * the key and says so when it is missing.
 */
export function runnable(route: Route): boolean {
  if (route === "direct") return anyOwnKey();
  return route === "gateway" ? Boolean(gatewayKey()) : onPath(programOf(route));
}

/** Whether this box can run one model: an AI SDK model always, a name when its route is set up for its provider. */
function canRun(model: string): boolean {
  if (sdkModel(viaOf(model).name)) return true;
  const route = routeFor(model);
  return carries(route, providerOf(model)) && runnable(route);
}

/** The gateway's own list, once it has answered. Empty until then, and it is only an offer. */
let fromGateway: string[] = [];

/** What the claude and codex commands said they run, when last asked. */
let fromCli: Partial<Record<Route, string[]>> = {};

/** A route's own list of models, or nothing for one that has none and runs whatever its provider has. */
function listOf(route: Route): string[] | undefined {
  const list = route === "gateway" ? fromGateway : route === "opencode" ? opencodeModels() : (fromCli[route] ?? []);
  return list.length ? list : undefined;
}

/**
 * How a route spells one model, or nothing when it does not run it. A route
 * with a list runs only what is on it, matched without the gateway's dot for a
 * dash, "claude-opus-5.5" for "claude-opus-5-5", and in its own spelling,
 * because that is the name it is handed.
 */
function spelledBy(route: Route, model: string): string | undefined {
  const list = listOf(route);
  if (!list) return route !== "gateway" && route !== "opencode" && carries(route, providerOf(model)) ? model : undefined;
  return list.find((one) => spelling(one) === spelling(model));
}

/**
 * The same model on each route set up here besides its own, in
 * `model.preferredRoute`'s order, as "<model> via <route>" in that route's
 * spelling.
 */
function otherRoutes(model: string): Offered[] {
  if (sdkModel(model) || viaOf(model).via) return [];
  const own = routeFor(model);
  return settings.model.preferredRoute.flatMap((route) => {
    const named = route !== own && runnable(route) ? spelledBy(route, model) : undefined;
    return named ? [{ model: `${named} via ${route}`, route }] : [];
  });
}

/**
 * What to offer when nobody wrote a shortlist: everything each route this box has
 * says it can run, once each however many routes spell it. Hundreds, usually,
 * which is why `model.models` exists to cut it down. The direct route has no
 * list of its own, so it offers the gateway's for each provider it has a key for.
 */
function shortlist(): string[] {
  if (settings.model.models.length) return settings.model.models;
  const listed = gatewayKey() ? fromGateway : fromGateway.filter((model) => ownKey(providerOf(model)));
  const cli = (route: Route) => (runnable(route) ? (fromCli[route] ?? []) : []);
  const all = [...cli("claude"), ...cli("codex"), ...(runnable("opencode") ? opencodeModels() : []), ...listed];
  const seen = new Set<string>();
  return all.filter((model) => !seen.has(spelling(model)) && seen.add(spelling(model))).sort();
}

/**
 * Asks each route what it runs, and fetches the gateway's prices.
 *
 * The lists are what people can pick a model from (with `/models` in a chat, or
 * on the dashboard) when `model.models` in settings is empty: the claude and
 * codex commands are asked, and the gateway at `model.gatewayUrl` with
 * `/chat/completions` at the end changed to `/models`. The prices are used to
 * work out what a call on a provider's own key cost.
 *
 * chloe's server calls this when it starts and each time it reloads the
 * config. Call it yourself only in a script that asks models without the
 * server. It never throws: a route that does not answer offers nothing of its
 * own until the next try.
 */
export async function learnModels(): Promise<void> {
  forgetOpencodeModels();
  const [claude, codex] = await Promise.all([
    runnable("claude") ? claudeModels() : [],
    runnable("codex") ? codexModels() : [],
    learnGateway(),
  ]);
  fromCli = { claude, codex };
}

async function learnGateway(): Promise<void> {
  const key = gatewayKey();
  if (!key && !anyOwnKey()) fromGateway = [];
  if (!key && !anySdkModel() && !anyOwnKey()) return;
  try {
    const response = await fetch(settings.model.gatewayUrl.replace(/\/chat\/completions\/?$/, "/models"), {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { data?: { id?: string; pricing?: Record<string, string> }[] };
    learnPrices(body.data ?? []);
    if (!key && !anyOwnKey()) return;
    fromGateway = (body.data ?? []).map((one) => one.id).filter((id): id is string => typeof id === "string" && id.includes("/"));
  } catch {
    // A gateway that cannot be reached is not an error here: it only means the
    // list somebody picks from is shorter until the next reload.
  }
}

/** One model somebody may pick, and the route it would go by here. A route other than the one it would take is in its name. */
export interface Offered {
  model: string;
  route: Route;
}

/**
 * The models on offer: `model.models` in settings, plus what the agent and its
 * jobs already name, each with its route, and only those this box can run.
 * Each is followed by the same model on every other route set up to run it,
 * named "<model> via <route>". Order is the settings' order, then the agent's.
 */
export function models(agent?: Agent): Offered[] {
  const named = [...shortlist(), ...(agent ? [agent.model, ...agent.jobs.flatMap((job) => (job.model ? [job.model] : []))] : [])];
  const out: Offered[] = [];
  for (const model of named) {
    if (out.some((one) => one.model === model)) continue;
    if (!canRun(model)) continue;
    out.push({ model, route: routeFor(model) });
    for (const other of otherRoutes(model)) if (!out.some((one) => one.model === other.model)) out.push(other);
  }
  return out;
}

/** A file sent to the model with a message, such as a photo or a PDF. */
export interface Attachment {
  /** The file's type, such as `"image/jpeg"` or `"application/pdf"`. Required. */
  mediaType: string;
  /** The file's contents, as base64 text. Required. */
  data: string;
  /** The file's name, if you know it. */
  filename?: string;
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
 * Thrown when the subscription a model is reached through, such as a Claude
 * plan, has hit its usage limit. Every call fails until the limit resets.
 *
 * The message is written for the person waiting for a reply, and a chat sends
 * it to them as the reply.
 */
export class UsageLimit extends Error {}

export interface Ask {
  /** A model's name. An AI SDK model is named by nameOf() first. */
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Handed the words as they are written, on a route on a key. The CLI routes answer whole and never call it. */
  onText?: (delta: string) => void;
}

/**
 * Asks a model once and returns what it said, by whichever route its
 * provider goes. The only seam between a key and a subscription.
 */
export function ask(request: Ask): Promise<Answer> {
  const route = routeFor(request.model);
  const named = { ...request, model: viaOf(request.model).name };
  if (route === "claude") return viaClaude(named);
  if (route === "codex") return viaCodex(named);
  if (route === "opencode") return viaOpencode(named);
  return viaKey(named, route);
}
