// The tools over webService.ts and searchService.ts: reading one public web
// page, saving the pictures on one, and searching the web.
//
//   import * as web from "@chloejs/core/tools/web";
//   tools: { webReadPage: web.readPage(), webSavePictures: web.savePictures(), webSearch: web.search() }
import { tool } from "ai";
import { z } from "zod";

import { agentOf } from "#chloe/model/tool";

import { brave } from "./brave.ts";
import * as searchService from "./searchService.ts";
import * as webService from "./webService.ts";

/**
 * Makes a tool that lets the model read one public web page as plain text,
 * with links written as `[text](url)`. A long page comes back in parts of
 * about 20,000 characters, and the model asks for the next part, or gives
 * words to find and gets only the passages around them.
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
      "Looking for something in a long page, a date, a price, a name, pass `find` and get only the passages that " +
      "have it, rather than reading every slice. " +
      "Only a page that came back nearly empty was built by JavaScript in the browser; if a page came back " +
      "full but wrong, say what you asked for and what you got, and do not guess why. `pictures` lists the pictures " +
      "on the page, the one that stands for it first.",
    inputSchema: z.object({
      url: z.url(),
      from: z.number().int().min(0).optional().describe("Where to start, from the last slice's `next`."),
      find: z.string().optional().describe("A word or a few, as the page would write them: only the passages around them come back."),
    }),
    execute: ({ url, from, find }) => webService.readPage(url, from ?? 0, find),
  }), { title: "Read page", onlyReads: true, kind: "fetch" as const });
}

/**
 * Makes a tool that lets the model save pictures from public addresses, up to
 * 8 at a time, so it can send them or use them in a file it makes. It gets back
 * the path of each. The same rule as `readPage` on what it may reach.
 *
 * Takes no options and needs no connection.
 *
 * ```ts
 * tools: { webSavePictures: web.savePictures() }
 * ```
 */
export function savePictures() {
  return Object.assign(tool({
    description:
      "Save pictures from the web, so you can show them in this chat. Pass addresses that came back from reading a " +
      "page, never ones you made up. Answers with the path of each, to send as a file, or the problem with it.",
    inputSchema: z.object({
      urls: z.array(z.url()).min(1).max(8),
    }),
    execute: ({ urls }, { context }) => webService.savePictures(agentOf(context).id, urls),
  }), { title: "Save pictures", onlyReads: true, kind: "fetch" as const });
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
      "before saying what it says. Reading a page also lists its pictures.",
    inputSchema: z.object({
      query: z.string().min(1),
      count: z.number().int().min(1).max(20).optional().describe("How many results, 10 if not said."),
    }),
    execute: ({ query, count }) => searchService.searchWeb(query, count),
  });
  return Object.assign(search, { title: "Search the web", needs: brave, onlyReads: true, kind: "search" as const });
}
