// Getting somebody signed in to Google from a chat, which the runtime runs and
// no model does.
//
// When a Gmail, Calendar or Drive call throws `NeedsSignIn`, the turn stops
// and the runtime calls `start()` and sends what it says, the link exactly as
// it is. The answer the person sends back is matched by `answers()` and
// finished by `finish()` before any model sees it. Where a dashboard catches
// Google's answer there is nothing to send back, and `start()` says so.
import type { SignIn } from "#chloe/connectors/connector";

import { NeedsClient, finish, isAnswer, setupSteps, start } from "./googleService.ts";

export const googleSignIn: SignIn = {
  async start() {
    try {
      const started = await start();
      return { say: started.say, link: started.link };
    } catch (error) {
      // The one thing a sign-in cannot start without, and the one thing the
      // agent cannot do for them. The steps, written down once, rather than
      // anybody improvising the menus of Google's console.
      if (!(error instanceof NeedsClient)) throw error;
      const { steps, addresses, why } = setupSteps();
      return {
        say: [
          `${why} Nobody has done that here yet. These are the steps:`,
          ...steps.map((one, i) => `${i + 1}. ${one}`),
          "",
          "The redirect addresses:",
          ...addresses,
        ].join("\n"),
      };
    }
  },
  answers: isAnswer,
  async finish(text) {
    const done = await finish(text);
    return `Signed in to Google as ${done.account}.`;
  },
};
