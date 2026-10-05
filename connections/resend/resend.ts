// The tool that sends one email through Resend, on the key the config gives
// connections.resend.
//
//   import * as resend from "@chloejs/core/tools/resend";
//   tools: { resendSendEmail: resend.sendEmail({ from, to, when: "..." }) }
import { sendingTool, type SendOptions } from "#chloe/model/tools/sending";

import { resend } from "./connection.ts";

export type { SendOptions };

/** Sends mail through Resend, from the address the agent was given, to the address it was given. */
export function sendEmail(options: SendOptions) {
  return Object.assign(sendingTool("resend", options), { needs: resend });
}
