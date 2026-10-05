// Google, through gog: one sign-in for the mail, the calendar, the files and
// the documents. gmailReadEmail, gmailReplyEmail and gmailSendEmail need it.
import { settings } from "#chloe/core/settings";
import type { Connector } from "#chloe/connectors/connector";

import { signInState } from "./googleService.ts";
import { googleSignInTools } from "./signIn.ts";

export const google: Connector = {
  name: "google",
  does: "The account its mail is read and sent as. Somebody has to sign in once, which the agent can ask them to do.",
  settings: ["google.account", "google.client", "google.gog"],
  signIn: googleSignInTools,
  async missing() {
    const state = await signInState();
    if (state.ready) return [];
    const client = settings.google.client;
    const filled = typeof client === "object" ? Object.keys(client).length > 0 : Boolean(client?.trim());
    return [
      ...(filled ? [] : ["google.client is not set: the client file Google's console gives you, or its path"]),
      state.missing,
    ];
  },
};
