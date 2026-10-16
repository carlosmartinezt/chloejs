// Sending one email through Resend, on `connections.resend.api_key`.
import { settings, whereKeyGoes } from "#chloe/core/settings";
import type { EmailProvider } from "#chloe/services/emailService";

export const resendProvider: EmailProvider = {
  async send({ from, to, replyTo, subject, body, html }) {
    const key = settings.connections.resend.api_key;
    if (!key) throw new Error(`No Resend key. Put it ${whereKeyGoes(["connections", "resend", "api_key"])}.`);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, reply_to: replyTo, subject, text: body, html }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as { id?: string };
  },
};
