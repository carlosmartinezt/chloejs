// The tool over openEmail() in channels/email.ts: beginning an email
// conversation with one of the people the agent's email channel allows.
import { tool } from "ai";
import { z } from "zod";

import { openEmail } from "#chloe/channels/email";
import type { Tools } from "#chloe/model/tool";

/**
 * A tool that emails somebody the agent's email channel allows, from an address
 * made for that conversation. Their reply comes back to the agent on that
 * channel. `when` says, in the agent's own words, when to use it.
 */
export function startEmail({ when, channel = "email" }: { when: string; channel?: string }) {
  return (agent: { name: string }): Tools => ({
    startEmail: tool({
      description:
        `Start an email conversation with someone. Their reply comes back to you as a message in that conversation. ${when}`,
      inputSchema: z.object({
        to: z.string().email().describe("Their email address. Only the people your email channel allows."),
        subject: z.string().min(3).max(120),
        text: z.string().min(1).describe("Markdown. Write it to them, as you would in a chat."),
      }),
      execute: async ({ to, subject, text }) => {
        const started = await openEmail(agent.name, to, subject, text, channel);
        return { sent: true, to, subject, conversation: started.thread };
      },
    }),
  });
}
