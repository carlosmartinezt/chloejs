// The web: reading one public page as plain text, and searching, through
// Brave Search on a key or DuckDuckGo's results page without one.
import type { Plugin } from "#chloe/load/plugin";
import { readPage, search } from "./tools.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the tools `webReadPage` (read one public web page as plain text) and
     * `webSearch` (search the web). Off by default. `webReadPage` reads only
     * public addresses and does not run the page's JavaScript. `webSearch` goes
     * to Brave Search when `connections.brave.api_key` is set, and to
     * DuckDuckGo when it is not. Switch the search tool off on its own to read
     * pages only.
     */
    web?: boolean;
  }
}

declare module "#chloe/core/settings" {
  interface Connections {
    /** Brave Search, where `web.search` sends a query. */
    brave: {
      /**
       * Your Brave Search API key. It is a secret: put it in `.env`.
       * Default: "" (none, so `web.search` asks DuckDuckGo's results page
       * instead, which needs no key but can refuse a machine that searches
       * often).
       */
      api_key: string;
    };
  }
}

export const web: Plugin = {
  name: "web",
  settings: {
    defaults: { connections: { brave: { api_key: "" } } },
    keys: ["connections.brave.api_key"],
  },
  configuration: {
    title: "Brave Search",
    fields: [
      {
        path: "connections.brave.api_key",
        label: "Brave Search API key",
        kind: "secret",
        about: "Optional. Without one, Chloe searches DuckDuckGo, which can stop answering if you search a lot.",
      },
    ],
  },
  abilities: [
    {
      name: "web",
      label: "Web",
      on: false,
      does: "Reads public web pages as plain text, and searches the web.",
      tools: ["webReadPage", "webSearch"],
      make: () => ({ webReadPage: readPage(), webSearch: search() }),
    },
  ],
};
