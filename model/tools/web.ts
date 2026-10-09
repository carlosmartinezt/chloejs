// The tool over services/webService.ts: reading one public web page.
//
//   import * as web from "@chloejs/core/tools/web";
//   tools: { webReadPage: web.readPage() }
import { tool } from "ai";
import { z } from "zod";

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
  return tool({
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
  });
}
