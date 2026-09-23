// The tool over services/emailService.ts: sending one email.
//
// The agent binds its own From line and its own recipients. All the model
// writes is the subject and the body.
import { z } from "zod";

import { type EmailSender, sendEmail } from "#chloe/services/emailService.ts";
import { writeFiles } from "#chloe/services/filesService.ts";
import { tool, type Tools } from "#chloe/model/tool.ts";

interface Options extends EmailSender {
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
 * A tool that sends mail from the address the agent was given, to the address
 * it was given.
 */
export function send_email({ when, keep, ...sender }: Options) {
  return (agent: { memory: { folder: string; commit?: boolean } }): Tools => ({
    send_email: tool({
      id: "send_email",
      description: `Send an email. ${when}`,
      inputSchema: z.object({
        subject: z.string().min(5).max(120),
        body: z
          .string()
          .min(20)
          .describe(`${sender.markdown ? "Markdown" : "Plain text"}. Lead with what happened and what you did.`),
      }),
      execute: async ({ subject, body }) => {
        const sent = await sendEmail(sender, subject, body);
        if (!keep) return sent;
        const at = new Date().toISOString();
        const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
        const copy = `---\nto: ${sender.to.join(", ")}\nsubject: ${sent.subject}\nsent: ${at}\n---\n\n${body}\n`;
        const { folder, commit } = agent.memory;
        const kept = await writeFiles(folder, `${keep}/${at.slice(0, 16).replace("T", "-").replace(":", "")}-${slug}.md`, copy, {
          commit,
          message: `Sent: ${sent.subject}`,
        });
        return { ...sent, copy: kept.path };
      },
    }),
  });
}
