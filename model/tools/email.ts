// Email, as tools: beginning a conversation through the agent's email channel,
// and what gmailSendEmail and resendSendEmail share for sending one email
// through services/emailService.ts by one provider. Only
// emailStartConversation is published: each provider's sending tool is in its
// own file.
import { tool } from "ai";
import { z } from "zod";

import { openEmail } from "#chloe/channels/email";
import { agentOf } from "#chloe/model/tool";
import { type EmailSender, type SendingProvider, deliverEmail } from "#chloe/services/emailService";
import { writeFiles } from "#chloe/services/filesService";

/**
 * A tool that emails somebody the agent's email channel allows, from an address
 * made for that conversation. Their reply comes back to the agent on that
 * channel. `when` says, in the agent's own words, when to use it.
 */
export function emailStartConversation({ when, channel = "email" }: { when: string; channel?: string }) {
  return tool({
    description:
      `Start an email conversation with someone. Their reply comes back to you as a message in that conversation. ${when}`,
    inputSchema: z.object({
      to: z.string().email().describe("Their email address. Only the people your email channel allows."),
      subject: z.string().min(3).max(120),
      text: z.string().min(1).describe("Markdown. Write it to them, as you would in a chat."),
    }),
    execute: async ({ to, subject, text }, { context }) => {
      const started = await openEmail(agentOf(context).id, to, subject, text, channel);
      return { sent: true, to, subject, conversation: started.thread };
    },
  });
}

// Sending: the agent binds its own From line and its own recipients. All the
// model writes is the subject and the body.

export interface SendOptions extends EmailSender {
  /** Who it reaches and when to use it, in the agent's own words. Shown to the model. */
  when: string;
  /**
   * A folder in the agent's memory, like "outbox". Every email sent is copied
   * there as `2026-09-23-0715-<subject>.md`, so the agent can see what it
   * already said before saying it again. Unsaid, nothing is kept.
   */
  keep?: string;
}

/**
 * A tool that sends mail through `provider`, from the address the agent was
 * given, to the address it was given.
 */
export function sendingTool(provider: SendingProvider, { when, keep, ...sender }: SendOptions) {
  return tool({
    description: `Send an email. ${when}`,
    inputSchema: z.object({
      subject: z.string().min(5).max(120),
      body: z
        .string()
        .min(20)
        .describe(`${sender.markdown ? "Markdown" : "Plain text"}. Lead with what happened and what you did.`),
    }),
    execute: async ({ subject, body }, { context }) => {
      const sent = await deliverEmail(sender, subject, body, provider);
      if (!keep) return sent;
      const at = new Date().toISOString();
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      const copy = `---\nto: ${sender.to.join(", ")}\nsubject: ${sent.subject}\nsent: ${at}\n---\n\n${body}\n`;
      const agent = agentOf(context);
      const { folder, commit } = agent.memory;
      // With "each run", the end of the run commits the copy with everything else it wrote.
      const kept = await writeFiles(folder, `${keep}/${at.slice(0, 16).replace("T", "-").replace(":", "")}-${slug}.md`, copy, {
        commit: commit === true,
        message: `Sent: ${sent.subject}`,
        author: agent.id,
        in: "memory",
      });
      return { ...sent, copy: kept.path };
    },
  });
}
