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
 * A tool that emails somebody the agent's email channel allows, from an address
 * made for that conversation. Their reply comes back to the agent on that
 * channel. `when` says, in the agent's own words, when to use it, and `keep`
 * is a folder in its memory that gets a copy of every email it starts.
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
      const sent = { sent: true, to, subject, conversation: started.thread };
      if (!keep) return sent;
      return { ...sent, copy: await keepCopy(agent, keep, [to], subject, text) };
    },
  });
}
