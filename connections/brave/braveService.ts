// Brave Search, on a key: web results from Brave's own index, through its API.
import { settings } from "#chloe/core/settings";
import type { Found } from "#chloe/services/searchService";

/** Asks Brave for up to `count` results. Throws with Brave's own words when it refuses. */
export async function braveSearch(query: string, count: number): Promise<Found[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": settings.connections.brave.api_key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Brave Search answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (body.web?.results ?? []).map((one) => ({
    title: one.title,
    url: one.url,
    snippet: (one.description ?? "").replace(/<[^>]+>/g, ""),
  }));
}
