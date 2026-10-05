// The tool that sends one email through Resend, on CHLOE_RESEND_API_KEY.
import { sendingTool, type SendOptions } from "./email.ts";

/** Sends mail through Resend, from the address the agent was given, to the address it was given. */
export function resendSendEmail(options: SendOptions) {
  return Object.assign(sendingTool("resend", options), { needs: "resend" as const });
}
