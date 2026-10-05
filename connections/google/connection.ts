// Google: one sign-in for the mail, the calendar and the files, over plain
// web requests. Every Gmail, Calendar and Drive tool needs it.
import { settings } from "#chloe/core/settings";
import type { Connection } from "#chloe/connections/connection";

import { signInState } from "./googleService.ts";
import { googleSignIn } from "./signIn.ts";

export const google: Connection = {
  name: "google",
  does: "The account its mail, calendar and files are reached as. Somebody signs in once, from a chat with the agent or from the dashboard.",
  settings: ["connections.google.account", "connections.google.client"],
  signIn: googleSignIn,
  async missing() {
    const client = settings.connections.google.client;
    const filled = typeof client === "object" ? Object.keys(client).length > 0 : Boolean(client?.trim());
    if (!filled) return ["connections.google.client is not set: the client file Google's console gives you, or its path"];
    const state = await signInState();
    return state.ready ? [] : [state.missing];
  },
};
