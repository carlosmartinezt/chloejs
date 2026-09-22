// The tool over services/emailService.ts: sending one email.
//
// The agent binds its own From line and its own recipients. All the model
// writes is the subject and the body.
import { z } from "zod";

import { type EmailSender, sendEmail } from "#chloe/services/emailService.ts";
import { tool } from "#chloe/model/tool.ts";

interface Options extends EmailSender {
  /** Who it reaches and when to use it, in the agent's own words. Shown to the model. */
  when: string;
}

/**
 * A tool that sends mail from the address the agent was given, to the address
 * it was given.
 */
export function send_email({ when, ...sender }: Options) {
  return tool({
    id: "send_email",
    description: `Send an email. ${when}`,
    inputSchema: z.object({
      subject: z.string().min(5).max(120),
      body: z.string().min(20).describe("Plain text. Lead with what happened and what you did."),
    }),
    execute: ({ subject, body }) => sendEmail(sender, subject, body),
  });
}
