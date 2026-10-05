// Sending one email through Resend, on `resend.api_key`.
import { settings } from "#chloe/core/settings";
import type { EmailProvider } from "#chloe/services/emailService";

export const resendProvider: EmailProvider = {
  async send({ from, to, replyTo, subject, body, html }) {
    const key = settings.resend.api_key;
    if (!key) throw new Error("No Resend key. Put it in .env as CHLOE_RESEND_API_KEY.");
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
