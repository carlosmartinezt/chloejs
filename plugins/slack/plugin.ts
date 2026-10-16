// Slack: an app an agent answers on, over Socket Mode, so nothing here needs a
// way in.
import { allowFrom, inGroups, sendWhileWorking } from "#chloe/channels/catalog";
import type { Plugin } from "#chloe/load/plugin";

declare module "#chloe/core/settings" {
  interface AgentSettings {
    /** The two tokens of the agent's Slack app. Default: both "". */
    slack: {
      /** The bot token. It starts with `xoxb-`. */
      bot_token: string;
      /** The app-level token. It starts with `xapp-`. chloe needs it to connect to Slack (Socket Mode). */
      app_token: string;
    };
  }
}

export const slack: Plugin = {
  name: "slack",
  settings: { agent: { slack: { bot_token: "", app_token: "" } } },
  channels: [
    {
      name: "slack",
      fn: "slackChannel",
      label: "Slack",
      does: "A Slack app. It answers in a direct message or wherever it is invited.",
      fields: [allowFrom("Slack member ids, like U0123ABCD. Leave it empty at first: the bot tells a stranger their id."), inGroups, sendWhileWorking],
      secrets: [
        { path: "slack.bot_token", label: "Bot token (xoxb-)" },
        { path: "slack.app_token", label: "App token (xapp-)" },
      ],
    },
  ],
};
