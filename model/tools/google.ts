// Getting signed in to Google, for an agent that has to guide somebody who is
// not at this machine.
//
// **Nothing binds these on their own.** They come with whatever needs Google:
// `readMail` brings them, and so does `sendEmail` when the mail goes out
// through Google. An agent that can read mail can get itself signed in to read
// mail, which is one decision and not two, and there is nothing to remember to
// add. Signing in is not a thing an agent does, it is part of the thing it
// does.
//
// Two tools rather than one, because they happen minutes or days apart and the
// model has to say something to somebody in between. The first hands back a
// link, the second takes whatever the browser came back with. Where a dashboard
// is catching the answer the second is never needed, and the first says so in
// what it hands back rather than leaving the model to guess.
import { z } from "zod";

import { NeedsClient, finish, setupSteps, signInState, start } from "#chloe/services/googleService";
import { defineTool, type Tools } from "#chloe/model/tool";

/**
 * Start a sign-in, and say where the last one stands.
 *
 * Handing the link back rather than opening anything is the whole point: the
 * person is on a phone somewhere and this machine has no browser.
 */
function googleSignIn() {
  return defineTool({
    id: "googleSignIn",
    description:
      "Get the person signed in to Google, for the mail and anything else of theirs you can reach. Hands back a " +
      "link. Send them that link exactly as it is, tell them what it says to tell them, and stop: do not call this " +
      "again while you wait, and do not retry the thing that failed either. Also use it to check whether a sign-in " +
      "is needed before you tell anybody something is broken.",
    inputSchema: z.object({
      again: z
        .boolean()
        .optional()
        .describe("Sign in again even though one already works. Use this when Google refused the saved one."),
    }),
    execute: async ({ again }) => {
      const state = await signInState();
      if (state.ready && !again) {
        return {
          alreadySignedIn: true,
          needsSetupFirst: false,
          account: state.account,
          say: "That account is already signed in.",
        };
      }
      let started;
      try {
        started = await start({ again: again || !state.ready });
      } catch (error) {
        // The one thing a sign-in cannot start without, and the one thing the
        // agent cannot do for them. Hand over the steps rather than the
        // message: a model that is told "no client" will invent the menus.
        if (error instanceof NeedsClient) {
          const { steps, addresses, why } = setupSteps();
          return {
            alreadySignedIn: false,
            needsSetupFirst: true,
            why,
            steps,
            redirectAddresses: addresses,
            say:
              "Nobody has set this copy up with Google yet. Walk them through these steps in order, one at a time, " +
              "and wait for them at each one. Do not shorten them and do not guess at anything they do not cover.",
          };
        }
        throw error;
      }
      return {
        alreadySignedIn: false,
        needsSetupFirst: false,
        account: started.account,
        link: started.link,
        say: started.say,
        // False means the person has to send something back, and the model
        // needs to know that now rather than after they have closed the tab.
        finishesOnItsOwn: started.relayed,
      };
    },
  });
}

/**
 * Finish a sign-in with what the browser came back with.
 *
 * Takes the whole address or just the code, because a person on a phone sends
 * one or the other and neither of them is wrong.
 */
function finishGoogleSignIn() {
  return defineTool({
    id: "finishGoogleSignIn",
    description:
      "Finish the Google sign-in you started, using what the person sent back: the whole address of the page " +
      "their browser landed on, or just the code out of it. Only after they have answered.",
    inputSchema: z.object({
      answer: z.string().min(1).describe("What the person sent back: the page's address, or the code from it."),
    }),
    execute: ({ answer }) => finish(answer),
  });
}

/**
 * Made once and handed out, so an agent with two Google tools on it gets one
 * copy of these rather than a clash. The loader allows the same tool twice and
 * refuses two different tools of one name, and this is what makes the first of
 * those true.
 */
let made: Tools | undefined;

/** The sign-in, as whatever needs Google adds it to its own set. Never bound on its own. */
export function googleSignInTools(): Tools {
  made ??= { googleSignIn: googleSignIn(), finishGoogleSignIn: finishGoogleSignIn() };
  return made;
}
