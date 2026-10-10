// The tools over services/webService.ts and services/searchService.ts:
// reading one public web page, and searching the web.
//
//   import * as web from "@chloejs/core/tools/web";
//   tools: { webReadPage: web.readPage(), webSearch: web.search() }
import { tool } from "ai";
import { z } from "zod";

import { brave } from "#chloe/connections/brave/connection";
import * as searchService from "#chloe/services/searchService";
import * as webService from "#chloe/services/webService";

/**
 * Makes a tool that lets the model read one public web page as plain text,
 * with links written as `[text](url)`. A long page comes back in parts of
 * about 20,000 characters, and the model asks for the next part.
 *
 * It reads only public addresses: it refuses this machine, your local network
 * and other private addresses, even through a redirect. It does not run the
 * page's JavaScript, so a page built in the browser comes back nearly empty.
 *
 * Takes no options and needs no connection.
 *
 * ```ts
 * tools: { webReadPage: web.readPage() }
 * ```
 */
export function readPage() {
  return Object.assign(tool({
    description:
      "Read a public web page as plain text. Links come back as `[text](url)`: to follow one, pass that url " +
      "exactly as it came back, never one you rebuilt by hand, because one changed character can make a site " +
      "quietly show a different page. A long page comes back in slices: pass `from` as the `next` it gave you. " +
      "Only a page that came back nearly empty was built by JavaScript in the browser; if a page came back " +
      "full but wrong, say what you asked for and what you got, and do not guess why.",
    inputSchema: z.object({
      url: z.url(),
      from: z.number().int().min(0).optional().describe("Where to start, from the last slice's `next`."),
    }),
    execute: ({ url, from }) => webService.readPage(url, from ?? 0),
  }), { onlyReads: true });
}

/**
 * Makes a tool that lets the model search the web, and get back up to 20
 * results, each a title, an address and a line from the page. It reads a
 * result with `readPage`.
 *
 * The query goes to Brave Search when `connections.brave.api_key` is set, and
 * to DuckDuckGo's results page when it is not. DuckDuckGo needs no key but can
 * refuse a machine that searches often, and then the tool says so.
 *
 * Takes no options.
 *
 * ```ts
 * tools: { webReadPage: web.readPage(), webSearch: web.search() }
 * ```
 */
export function search() {
  const search = tool({
    description:
      "Search the web. Gives back results, each a title, a url and a line from the page: to read one, pass " +
      "its url exactly as it came back. A line from a page is not the page, so read it " +
      "before saying what it says.",
    inputSchema: z.object({
      query: z.string().min(1),
      count: z.number().int().min(1).max(20).optional().describe("How many results, 10 if not said."),
    }),
    execute: ({ query, count }) => searchService.searchWeb(query, count),
  });
  return Object.assign(search, { needs: brave, onlyReads: true });
}
