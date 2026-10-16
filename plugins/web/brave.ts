// Brave Search, on a key: where web.search sends a query when the key is set.
import { settings } from "#chloe/core/settings";
import type { Connection } from "#chloe/connections/connection";

export const brave: Connection = {
  name: "brave",
  does: "Where web searches go. Without a key they go to DuckDuckGo's results page, which needs none but can stop answering without warning.",
  settings: ["connections.brave.api_key"],
  async missing() {
    return [];
  },
};
