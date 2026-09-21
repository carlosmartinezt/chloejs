// The tool over do/email.ts: sending one email.
//
// The agent binds its own From line and its own recipients. All the model
// writes is the subject and the body.
import { z } from "zod";

import { type Address, send } from "#chloe/do/email.ts";
import { tool } from "#chloe/model/tool.ts";

interface Sender extends Address {
  /** Who it reaches and when to use it, in the agent's own words. Shown to the model. */
  when: string;
}

/**
 * A tool that sends mail from the address the agent was given, to the address
 * it was given.
 */
export function sendEmail({ when, ...address }: Sender) {
  return tool({
    id: "send_email",
    description: `Send an email. ${when}`,
    inputSchema: z.object({
      subject: z.string().min(5).max(120),
      body: z.string().min(20).describe("Plain text. Lead with what happened and what you did."),
    }),
    execute: ({ subject, body }) => send(address, subject, body),
  });
}
