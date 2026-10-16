// Telegram: a bot an agent answers on, polled or on a webhook, and the tool
// that sends a message through it.
import { allowFrom, inGroups, sendWhileWorking } from "#chloe/channels/catalog";
import type { Plugin } from "#chloe/load/plugin";

declare module "#chloe/core/settings" {
  interface AgentSettings {
    /**
     * The token of the agent's Telegram bot. To get one, message @BotFather in
     * Telegram and send `/newbot`. Default: "" (no Telegram bot).
     */
    telegram: string;
  }
}

export const telegram: Plugin = {
  name: "telegram",
  settings: { agent: { telegram: "" } },
  channels: [
    {
      name: "telegram",
      fn: "telegramChannel",
      label: "Telegram",
      does: "A Telegram bot. Anyone it is told to listen to can talk to this agent.",
      fields: [
        allowFrom("Telegram user ids. Leave it empty at first: the bot tells a stranger their id, and the first id here is the owner.", true),
        inGroups,
        sendWhileWorking,
        { name: "stackWithin", label: "Wait, in seconds", about: "How long it waits for more messages in a row before answering them as one. 0 answers each on its own.", kind: "number", default: 1 },
      ],
      secrets: [{ path: "telegram", label: "Bot token, from @BotFather" }],
    },
  ],
};
