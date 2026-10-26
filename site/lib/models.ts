import type { Choice } from "../views/components/ContextMenu.tsx";

/** One model on offer, and the way it is reached here. */
export interface Offered {
  model: string;
  route: string;
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
