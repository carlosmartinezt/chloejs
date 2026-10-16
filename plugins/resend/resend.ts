// The tool that sends one email through Resend, on the key the config gives
// connections.resend.
//
//   import * as resend from "@chloejs/core/tools/resend";
//   tools: { resendSendEmail: resend.sendEmail({ from, to, when: "..." }) }
import { sendingTool, type SendOptions } from "#chloe/model/tools/sending";

import { resend } from "./connection.ts";

export type { SendOptions };

/**
 * Makes a tool that lets the model send an email through Resend, an email
 * sending service. You set the From line (`from`) and who it goes to (`to`).
 * The model writes only the subject and the body.
 *
 * `from` must be on a domain you have set up in Resend. If `email.provider`
 * in settings is `"none"`, nothing is sent: the subject is only written to
 * the log.
 *
 * Needs the Resend connection: an API key in `connections.resend.api_key`.
 *
 * ```ts
 * tools: { resendSendEmail: resend.sendEmail({ from: "Shop <shop@example.com>", to: ["owner@example.com"], when: "When an order fails." }) }
 * ```
 */
export function sendEmail(options: SendOptions) {
  return Object.assign(sendingTool("resend", options), { needs: resend });
}
