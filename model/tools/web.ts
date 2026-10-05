// The tool over services/webService.ts: reading one public web page.
//
//   import * as web from "@chloejs/core/tools/web";
//   tools: { webReadPage: web.readPage() }
import { tool } from "ai";
import { z } from "zod";

import * as webService from "#chloe/services/webService";

/** A tool that reads one public web page as plain text. */
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
