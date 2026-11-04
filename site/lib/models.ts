import type { Choice } from "../views/components/ContextMenu.tsx";

/** One model on offer, and the way it is reached here. */
export interface Offered {
  model: string;
  route: string;
  /** The owner named it in `model.models`, so a chat's menu is these and no others. */
  short?: boolean;
}

const word = (one: string) => one.charAt(0).toUpperCase() + one.slice(1);

/**
 * What a model is called on the page, in the words its maker's own app uses:
 * "Claude Opus 5.5", "ChatGPT 6 Luna", "Gemini 3.8 Flash". An effort on the end
 * of a name is left off. A model of anybody else's stays as it is written, and
 * so does a route named after it.
 */
export function modelName(model: string): string {
  const [id, via] = model.split(" via ");
  const name = id.slice(id.indexOf("/") + 1).replace(/-(low|medium|high)$/, "");
  const claude = id.startsWith("anthropic/") && /^claude-([a-z]+)-(\d+)(?:[-.](\d+))?/.exec(name);
  const gpt = id.startsWith("openai/") && /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(name);
  const gemini = id.startsWith("google/") && /^gemini-(\d+(?:\.\d+)?)-(.+)$/.exec(name);
  const said = claude
    ? `Claude ${word(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`
    : gpt
      ? `ChatGPT ${gpt[1]}${gpt[2] ? ` ${gpt[2].split("-").map(word).join(" ")}` : ""}`
      : gemini
        ? `Gemini ${gemini[1]} ${gemini[2].split("-").map(word).join(" ")}`
        : id;
  return via ? `${said} via ${via}` : said;
}

/**
 * The models on offer as menu choices, one group for each way to reach them,
 * the shortest group first: a gateway can list hundreds, and the few a
 * subscription runs would be lost under them. Each name is shown without the
 * " via <route>" its group already says.
 */
export function modelChoices(offered: Offered[], pick: (model: string) => void, current?: string): Choice[] {
  const groups = new Map<string, string[]>();
  for (const { model, route } of offered) groups.set(route, [...(groups.get(route) ?? []), model]);
  return [...groups]
    .sort((a, b) => a[1].length - b[1].length)
    .flatMap(([route, models]): Choice[] => [
      "line",
      { head: route },
      ...models.map((one): Choice => ({ label: one.replace(` via ${route}`, ""), run: () => pick(one), current: one === current })),
    ]);
}

/** The models the owner named, by what they are called, for a chat's menu. Empty when they named none. */
export function shortChoices(offered: Offered[], pick: (model: string) => void, current?: string): Choice[] {
  return offered
    .filter((one) => one.short)
    .map((one): Choice => ({ label: modelName(one.model), title: one.model, run: () => pick(one.model), current: one.model === current }));
}
