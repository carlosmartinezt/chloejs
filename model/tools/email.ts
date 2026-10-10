// The tool for an agent on the email channel: beginning a conversation with
// somebody, whose reply comes back on that channel. Sending one email with no
// conversation is gmail.sendEmail or resend.sendEmail.
//
//   import * as email from "@chloejs/core/tools/email";
//   tools: { emailStartConversation: email.startConversation({ when: "..." }) }
import { tool } from "ai";
import { z } from "zod";

import { openEmail } from "#chloe/channels/email";
import { agentOf } from "#chloe/model/tool";
import { keepCopy } from "./sending.ts";

/**
 * Makes a tool that lets the model start an email conversation with someone.
 * Each conversation gets its own reply address, so when the person replies,
 * the reply comes back to the agent as a message on its email channel.
 *
 * The model chooses the address, the subject and the text. It can write only
 * to people in the `allowFrom` list of the agent's email channel, and only
 * while that channel is running.
 *
 * Options:
 * - `when`: when the model should use the tool, in your own words. Added to
 *   the tool's description for the model. Required.
 * - `channel`: the `name` of the agent's email channel. Default: `"email"`.
 * - `keep`: a folder in the agent's memory, such as `"outbox"`. A copy of each
 *   email it starts is saved there. Not set by default: no copies are kept.
 *
 * Needs an `emailChannel` on the agent.
 */
export function startConversation({ when, channel = "email", keep }: { when: string; channel?: string; keep?: string }) {
  return tool({
    description:
      `Start an email conversation with someone. Their reply comes back to you as a message in that conversation. ${when}`,
    inputSchema: z.object({
      to: z.string().email().describe("Their email address. Only the people your email channel allows."),
      subject: z.string().min(3).max(120),
      text: z.string().min(1).describe("Markdown. Write it to them, as you would in a chat."),
    }),
    execute: async ({ to, subject, text }, { context }) => {
      const agent = agentOf(context);
      const started = await openEmail(agent.id, to, subject, text, channel);
      // Held back in a trial run: nothing went and no conversation was made.
      if (!started.thread) return { sent: false, held: true, to, subject };
      const sent = { sent: true, to, subject, conversation: started.thread };
      if (!keep) return sent;
      return { ...sent, copy: await keepCopy(agent, keep, [to], subject, text) };
    },
  });
}
