// The tool for an agent on Telegram: sending a message to someone the channel
// already knows, without waiting for them to write first.
//
//   import * as telegram from "@chloejs/core/tools/telegram";
//   tools: { telegramSendMessage: telegram.sendMessage({ who: ["12345"], when: "..." }) }
import { tool } from "ai";
import { z } from "zod";

import { agentOf } from "#chloe/model/tool";
import { deliver } from "#chloe/services/messageService";

/**
 * Makes a tool that lets the model send a Telegram message to someone.
 *
 * The model chooses the recipient and the text. It can write only to people in
 * the `who` list, and only while the agent's Telegram channel is running.
 *
 * Options:
 * - `who`: Telegram user ids the model may send to. Required.
 * - `when`: when the model should use the tool, in your own words. Added to the
 *   tool's description. Required.
 * - `channel`: the `name` of the agent's Telegram channel. Default: `"telegram"`.
 *
 * Needs a `telegramChannel` on the agent.
 */
export function sendMessage({ who, when, channel = "telegram" }: { who: string[]; when: string; channel?: string }) {
  if (who.length === 0) throw new Error("telegram.sendMessage needs at least one user id in who.");
  return Object.assign(tool({
    description: `Send a Telegram message to ${who.join(", ")}. ${when}`,
    inputSchema: z.object({
      to: z.enum(who as [string, ...string[]]).describe("Who to send to."),
      text: z.string().min(1).describe("The message to send."),
    }),
    execute: async ({ to, text }, { context }) => {
      await deliver(`${channel}:${to}`, text, agentOf(context).id);
      return { sent: true, to };
    },
  }), { title: "Send Telegram message" });
}
