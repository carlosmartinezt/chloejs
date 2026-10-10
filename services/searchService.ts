// Searching the web: Brave Search when `connections.brave.api_key` is set,
// DuckDuckGo's plain results page when it is not.
//
// The tool a model reaches is `search()` in model/tools/web.ts, which calls this.
import { braveSearch } from "#chloe/connections/brave/braveService";
import { settings } from "#chloe/core/settings";

import { htmlToText } from "./webService.ts";

/** One result of `searchWeb`. */
export interface Found {
  title: string;
  /** The page's own address, to read with `readPage`. */
  url: string;
  /** A line or two from the page, as plain text. */
  snippet: string;
}

const text = (html: string) => htmlToText(html.replace(/<\/?b>/g, ""), "https://duckduckgo.com/").text.replace(/\s+/g, " ").trim();

/**
 * Reads the results out of DuckDuckGo's plain HTML results page, leaving out
 * its ads. Each link there goes through DuckDuckGo's redirect, so the page's
 * own address is read off `uddg`.
 */
export function duckDuckGoResults(html: string): Found[] {
  const found: Found[] = [];
  for (const block of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = /class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = link[1].replace(/&amp;/g, "&");
    const url = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
    if (!/^https?:/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
    found.push({ title: text(link[2]), url, snippet: text(snippet) });
  }
  return found;
}

async function duckDuckGo(query: string, count: number): Promise<Found[]> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; chloe)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo answered ${response.status}. Set connections.brave.api_key to search through Brave.`);
  const html = await response.text();
  const found = duckDuckGoResults(html);
  // A page with no results and no "No results" line is DuckDuckGo refusing, usually with a puzzle for a person.
  if (!found.length && !/No results/i.test(html)) {
    throw new Error("DuckDuckGo did not answer with results, which usually means it is refusing this machine for now. Set connections.brave.api_key to search through Brave.");
  }
  return found.slice(0, count);
}

/**
 * Searches the web and returns up to `count` results (default 10, at most
 * 20), each a title, an address and a line from the page.
 *
 * Goes to Brave Search when `connections.brave.api_key` is set, and otherwise
 * to DuckDuckGo, which needs no key but is a page for people rather than an
 * API: it can refuse a machine that searches often. Throws when the service
 * refuses, never returns an empty list for it.
 */
export async function searchWeb(query: string, count = 10): Promise<Found[]> {
  const many = Math.max(1, Math.min(count, 20));
  return settings.connections.brave.api_key.trim() ? braveSearch(query, many) : duckDuckGo(query, many);
}
