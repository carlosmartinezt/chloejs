// Subscriptions: reaching a model through a program on this box, on that
// program's own plan rather than a key charged per call. One route per
// program: the Claude Code CLI, the Codex CLI, the Antigravity CLI and
// opencode. Taking this plugin out leaves the routes on a key, "direct" and
// "gateway".
//
// The terms of these plans may not cover agents running on their own, which is
// why the startup line says so and setup marks each "for dev purposes only".
import type { Plugin } from "#chloe/load/plugin";
import { providerOf, type ModelRoute } from "#chloe/model/model";
import { antigravityModels, viaAntigravity } from "./antigravity.ts";
import { claudeModels, claudeQuick, viaClaude } from "./claude.ts";
import { codexModels, viaCodex } from "./codex.ts";
import { forgetOpencodeModels, opencodeModels, viaOpencode } from "./opencode.ts";

declare module "#chloe/core/settings" {
  interface Routes {
    /** The Claude Code CLI, on a Claude subscription. Anthropic models only. */
    claude: true;
    /** The Codex CLI, on a ChatGPT plan. OpenAI models only. */
    codex: true;
    /** The Antigravity CLI, on a Google AI Pro plan. Google models only. */
    antigravity: true;
    /** The opencode CLI, with any provider it is signed in to. */
    opencode: true;
  }
  interface Programs {
    /** The command for the "claude" route. Default: "claude". */
    claude: string;
    /** The command for the "codex" route. Default: "codex". */
    codex: string;
    /** The command for the "antigravity" route. Default: "agy". */
    antigravity: string;
    /** The command for the "opencode" route. Default: "opencode". */
    opencode: string;
  }
}

/**
 * A route whose program says what it runs when asked, and runs one provider's
 * models. `quick` picks its quick model from that list.
 */
function listing(
  name: ModelRoute["name"],
  provider: string,
  ask: ModelRoute["ask"],
  models: () => Promise<string[]>,
  quick?: (known: string[]) => string | undefined,
): Omit<ModelRoute, "says" | "setup"> {
  let known: string[] = [];
  return {
    name,
    carries: (asked) => asked === provider,
    listed: () => known,
    quick: () => (known.length ? quick?.(known) : undefined),
    learn: async () => void (known = await models()),
    ask,
  };
}

/** Codex says no model is its quick one, so this one is, while Codex lists it. */
const CODEX_QUICK = "openai/gpt-6-luna";

const claude: ModelRoute = {
  ...listing("claude", "anthropic", viaClaude, claudeModels, claudeQuick),
  says: "Claude, on a subscription",
  subscription: true,
  setup: { what: "Claude subscription (for dev purposes only)", model: "anthropic/claude-sonnet-5.5" },
};

const codex: ModelRoute = {
  ...listing("codex", "openai", viaCodex, codexModels, (known) => known.find((one) => one === CODEX_QUICK)),
  says: "Codex, on a ChatGPT plan",
  subscription: true,
  setup: { what: "ChatGPT subscription (for dev purposes only)", model: "openai/gpt-6-luna" },
};

const antigravity: ModelRoute = {
  ...listing("antigravity", "google", viaAntigravity, antigravityModels),
  says: "Antigravity, on a Google AI Pro plan",
  subscription: true,
  setup: {
    what: "Google AI Pro subscription (for dev purposes only)",
    question: "Which of the Antigravity CLI's models?",
    empty: "The Antigravity CLI is here but signed in to nothing. Sign in with it, then run npx chloe setup again.",
  },
};

// opencode carries whatever it is signed in to, so it is asked rather than told,
// once per process, because routeFor cannot wait.
const opencode: ModelRoute = {
  name: "opencode",
  says: "opencode, on whatever it is signed in to",
  carries: (provider) => opencodeModels().some((model) => providerOf(model) === provider),
  listed: () => opencodeModels(),
  learn: async () => forgetOpencodeModels(),
  ask: viaOpencode,
  setup: { what: "opencode subscription (for dev purposes only)", question: "Which of opencode's models?", empty: "opencode is here but signed in to nothing. Run: opencode providers" },
};

export const subscriptions: Plugin = {
  name: "subscriptions",
  settings: {
    routes: ["claude", "codex", "antigravity", "opencode"],
    defaults: { model: { program: { claude: "claude", codex: "codex", antigravity: "agy", opencode: "opencode" } } },
  },
  modelRoutes: [claude, codex, antigravity, opencode],
};
