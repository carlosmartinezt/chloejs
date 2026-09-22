// Sending one email.
//
// The caller supplies who it is from and who it is to. Which provider carries
// it is email.provider in settings, and each provider reads its own section
// of settings.local.json for its key (resend.api_key for Resend).
//
// The tool a model reaches is model/tools/send_email.ts, which calls
// this. A job calls this directly, from a step.

import { setting, settings } from "#chloe/core/settings.ts";

/**
 * Who an agent's mail comes from, who it goes to, and the tag in front of
 * every subject.
 */
export interface EmailSender {
  /** The From line, e.g. "Backups <info@example.com>". */
  from: string;
  /** Who it goes to. */
  to: string[];
  /** Prefix put in front of every subject, so an inbox can be filtered. */
  tag?: string;
}

/** One message, ready to go: the tag is already in the subject. */
export interface Email {
  from: string;
  to: string[];
  subject: string;
  body: string;
}

/** Something that can carry an email. Returns the provider's id for it, if it gives one. */
export interface EmailProvider {
  send(email: Email): Promise<{ id?: string }>;
}

const resend: EmailProvider = {
  async send({ from, to, subject, body }) {
    const key = setting(settings.resend.api_key, "RESEND_API_KEY");
    if (!key) throw new Error("No Resend key. Put it in settings.local.json as resend.api_key.");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text: body }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as { id?: string };
  },
};

/** Every provider email.provider can name. Adding one is an entry here and in the settings schema. */
const providers: Record<typeof settings.email.provider, EmailProvider> = { resend };

/** Sends one email through the configured provider and returns its id. The tag is put in front of the subject. */
export async function sendEmail(
  { from, to, tag }: EmailSender,
  subject: string,
  body: string,
): Promise<{ sent: true; id?: string; subject: string }> {
  // Refuse rather than send nowhere.
  if (to.length === 0) throw new Error("Nobody to send to. Give the sender at least one address in to.");
  const { id } = await providers[settings.email.provider].send({
    from,
    to,
    subject: tag ? `[${tag}] ${subject}` : subject,
    body,
  });
  return { sent: true, id, subject };
}
