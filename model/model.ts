// Asking a model, two ways.
//
// A model is a string like "anthropic/claude-sonnet-5". By default it goes to
// the Vercel AI Gateway over HTTP, so changing provider is changing that
// string, and any gateway that speaks the same shape works by setting
// AI_GATEWAY_URL.
//
// MODEL_VIA=claude sends it through the Claude Code CLI instead, which is the
// only way to spend a Claude subscription: a subscription authorises the CLI
// and is not an API key. See claude.ts. Everything above this file is the same
// either way, which is the reason ask() is the only seam.

import { setting, settings } from "#chloe/core/settings.ts";

import { viaClaude } from "./claude.ts";

/**
 * Which way a model call goes. A box with a key uses it; a box with only a
 * subscription falls through to the CLI, so a fresh clone runs either way
 * without being told. MODEL_VIA settles it when both are there.
 */
export function via(): "gateway" | "claude" {
  const chosen = setting(settings.model.via, "MODEL_VIA");
  if (chosen === "gateway" || chosen === "claude") return chosen;
  if (chosen) throw new Error(`model.via is ${JSON.stringify(chosen)}. It is "gateway" or "claude".`);
  return gatewayKey() ? "gateway" : "claude";
}

function gatewayKey(): string {
  return setting(settings.model.key, "AI_GATEWAY_API_KEY");
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
 * Asks a model once and returns what it said, whichever way `model.via` sends
 * it. The only seam between a key and a subscription.
 */
export function ask(request: Ask): Promise<Answer> {
  return via() === "claude" ? viaClaude(request) : viaGateway(request);
}

async function viaGateway({ model, messages, tools, maxTokens, signal }: Ask): Promise<Answer> {
  const key = gatewayKey();
  if (!key) {
    throw new Error(
      "No gateway key. Put it in settings.local.json as model.key. " +
        'To run on a Claude subscription instead, set model.via to "claude".',
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
