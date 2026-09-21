// The tool over do/web.ts: reading one public web page.
import { z } from "zod";

import { readPage } from "#chloe/do/web.ts";
import { tool } from "#chloe/model/tool.ts";

/** A tool that reads one public web page as plain text. */
export function readWeb() {
  return tool({
    id: "read_page",
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
    execute: ({ url, from }) => readPage(url, from ?? 0),
  });
}
