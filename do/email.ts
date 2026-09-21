// Sending one email.
//
// The caller supplies who it is from and who it is to; this file only knows
// how to send. The key is resend.api_key in settings.local.json.
//
// The tool a model reaches is model/tools/send_email.ts, which calls
// this. A job calls this directly, from a step.

import { setting, settings } from "#chloe/core/settings.ts";

/**
 * Who an agent's mail comes from, who it goes to, and the tag in front of
 * every subject.
 */
export interface Address {
  /** The From line, e.g. "Backups <info@example.com>". */
  from: string;
  /** Who it goes to. */
  to: string[];
  /** Prefix put in front of every subject, so an inbox can be filtered. */
  tag?: string;
}

/** Sends one email and returns its id. The tag is put in front of the subject. */
export async function send(
  { from, to, tag }: Address,
  subject: string,
  body: string,
): Promise<{ sent: true; id?: string; subject: string }> {
  const key = setting(settings.resend.api_key, "RESEND_API_KEY");
  if (!key) throw new Error("No Resend key. Put it in settings.local.json as resend.api_key.");
  // Refuse rather than send nowhere.
  if (to.length === 0) throw new Error("Nobody to send to. The address belongs in settings.local.json.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: tag ? `[${tag}] ${subject}` : subject, text: body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
  }
  const sent = (await response.json()) as { id?: string };
  return { sent: true, id: sent.id, subject };
}
