// The tool that sends one email through Resend, on CHLOE_CONNECTIONS_RESEND_API_KEY.
import { sendingTool, type SendOptions } from "#chloe/model/tools/email";

import { resend } from "./connection.ts";

/** Sends mail through Resend, from the address the agent was given, to the address it was given. */
export function resendSendEmail(options: SendOptions) {
  return Object.assign(sendingTool("resend", options), { needs: resend });
}
