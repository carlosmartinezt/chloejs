// Discord: a bot an agent answers on, over Discord's gateway, so nothing here
// needs a way in.
import { allowFrom, inGroups, sendWhileWorking } from "#chloe/channels/catalog";
import type { Plugin } from "#chloe/load/plugin";

declare module "#chloe/core/settings" {
  interface AgentSettings {
    /**
     * The token of the agent's Discord bot, from the Bot page of an application
     * at discord.com/developers/applications. Default: "" (no Discord bot).
     */
    discord: string;
  }
}

export const discord: Plugin = {
  name: "discord",
  settings: { agent: { discord: "" } },
  channels: [
    {
      name: "discord",
      fn: "discordChannel",
      label: "Discord",
      does: "A Discord bot. It answers in a direct message, or in a server when it is mentioned.",
      fields: [allowFrom("Discord user ids, like 123456789012345678. Leave it empty at first: the bot tells a stranger their id."), inGroups, sendWhileWorking],
      secrets: [{ path: "discord", label: "Bot token, from the Developer Portal" }],
    },
  ],
};
