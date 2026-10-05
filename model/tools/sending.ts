// What gmail.sendEmail and resend.sendEmail share: one email sent through
// services/emailService.ts by one provider, and a copy of what was sent kept in
// the agent's memory. Not an entrance: each provider's tool is in its own file.
import { tool } from "ai";
import { z } from "zod";

import { agentOf } from "#chloe/model/tool";
import { type EmailSender, type SendingProvider, deliverEmail } from "#chloe/services/emailService";
import { writeFiles } from "#chloe/services/filesService";

// The agent binds its own From line and its own recipients. All the
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
      return { ...sent, copy: await keepCopy(agentOf(context), keep, sender.to, sent.subject, body) };
    },
  });
}

/** Writes a sent email into `keep` in the agent's memory, as `2026-09-23-0715-<subject>.md`, and gives back its path. */
export async function keepCopy(agent: ReturnType<typeof agentOf>, keep: string, to: string[], subject: string, body: string): Promise<string> {
  const at = new Date().toISOString();
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const copy = `---\nto: ${to.join(", ")}\nsubject: ${subject}\nsent: ${at}\n---\n\n${body}\n`;
  const { folder, commit } = agent.memory;
  // With "each run", the end of the run commits the copy with everything else it wrote.
  const kept = await writeFiles(folder, `${keep}/${at.slice(0, 16).replace("T", "-").replace(":", "")}-${slug}.md`, copy, {
    commit: commit === true,
    message: `Sent: ${subject}`,
    author: agent.id,
    in: "memory",
  });
  return kept.path;
}
