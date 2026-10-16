// Google: one sign-in for Gmail, Google Calendar and Google Drive, over plain
// web requests. It adds their three abilities, sends a job's mail when
// `email.provider` is "gmail", is the "gmail" mailbox an email channel can be
// on, and answers the dashboard's routes for setting it up and signing in.
import { z } from "zod";

import { settings } from "#chloe/core/settings";
import { about } from "#chloe/load/options";
import type { Plugin } from "#chloe/load/plugin";
import { body, json } from "#chloe/serve/http";
import * as calendar from "./calendar.ts";
import { google as connection } from "./connection.ts";
import * as drive from "./drive.ts";
import * as gmail from "./gmail.ts";
import { gmailProvider } from "./gmailService.ts";
import { finish, setupSteps, signInState } from "./googleService.ts";
import { gmailMailbox } from "./mailbox.ts";
import { googleSignIn } from "./signIn.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the tools that read the Gmail account Google is signed in to,
     * `emailReadMail`, and with the fields below, `emailReplyMail` and
     * `emailSendMail`. Off by default. `true` reads the inbox of the last 7
     * days and nothing else. Give fields to say which mail, and to let it reply
     * or send. Needs the Google sign-in.
     */
    googleMail?: boolean | GoogleMailAbility;
    /**
     * Adds the tool `calendarListEvents` for a Google calendar, and with
     * `add`, `calendarAddEvent`. Off by default. `true` reads the signed-in
     * account's own calendar for the next 7 days. Needs the Google sign-in.
     */
    googleCalendar?: boolean | GoogleCalendarAbility;
    /**
     * Adds the tools `driveSearchFiles` and `driveReadFile`, which find and read
     * files in Google Drive as text. Off by default. `true` reaches all of
     * Drive: give `search` to keep it to some files. Needs the Google sign-in.
     */
    googleDrive?: boolean | GoogleDriveAbility;
  }
}

declare module "#chloe/core/settings" {
  interface Connections {
    /**
     * Your Google sign-in. The Gmail, Calendar and Drive tools use it, and so
     * do `email.provider: "gmail"` and the email channel with
     * `mailbox: "gmail"`.
     */
    google: {
      /**
       * The Google account to sign in to, like "you@gmail.com". Everything
       * that uses Google works as this account. Default: "" (none, so nothing
       * can sign in to Google).
       *
       * If you change it, someone has to sign in again.
       */
      account: string;
      /**
       * The Google app that chloe signs in with: an OAuth client, which you
       * make once in the Google Cloud console. Give it in one of three forms:
       * - the JSON file the console downloads, pasted here as an object,
       * - the path to that file,
       * - the file's contents as one string.
       *
       * Default: "" (none, so nobody can sign in to Google). It is a secret:
       * put it in `.env`.
       *
       * Keep the file as the console wrote it, with its `web` or `installed`
       * section. That section decides where Google may send the person after
       * they sign in (see `callback`). A client made as a "Web application" is
       * the easiest to use.
       *
       * After a sign-in, chloe saves the key Google gives it in the state
       * folder. You do not set that key anywhere.
       */
      client: string | Record<string, unknown>;
      /**
       * The address Google sends the person to after they approve the sign-in.
       * Default: "" (chloe picks the address from the kind of `client`):
       * - a "web" client: https://chloejs.org/connected, a page that shows a
       *   short code. The person sends that code back to the agent in the chat.
       * - an "installed" (desktop) client: a port on this machine,
       *   http://127.0.0.1:33067/oauth2/callback. The browser shows an error
       *   page there, and the person copies the whole address from the
       *   browser and sends it back to the agent.
       *
       * For a "web" client, you must also add the address to the client in
       * the Google Cloud console.
       */
      callback: string;
    };
  }
  interface EmailProviders {
    /** Sends from the Google account in `connections.google`. */
    gmail: true;
  }
}

declare module "#chloe/core/mail" {
  interface Mailboxes {
    /** The Gmail account Google is signed in to (`connections.google.account`), the same sign-in as the mail tools. */
    gmail: true;
  }
}

/** The fields of `abilities.googleMail`. The model chooses only how far back and which listed message to answer. */
export interface GoogleMailAbility {
  /** A Gmail search that sets which mail the model can see, like `"in:inbox label:orders"`. It cannot change it. Default: `"in:inbox"`. */
  search?: string;
  /** How many days back it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for that mail, like `"order emails"`, said to the model. Default: none. */
  about?: string;
  /** The addresses it may write to. With any, it gets `emailSendMail`, which writes only the subject and the body. Default: none, so it cannot send. */
  sendTo?: string[];
  /** The From line it sends under, like `"Shop <you@gmail.com>"`. Default: the signed-in account. */
  sendFrom?: string;
  /** When it should send, in your words, said to the model. Default: "When asked to." */
  sendWhen?: string;
}
/** The fields of `abilities.googleCalendar`. */
export interface GoogleCalendarAbility {
  /** The ids of the calendars it can see; `"primary"` is the signed-in account's own. Default: `["primary"]`. */
  calendars?: string[];
  /** How many days ahead it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for those calendars, like `"the team calendar"`, said to the model. Default: none. */
  about?: string;
}
/** The fields of `abilities.googleDrive`. */
export interface GoogleDriveAbility {
  /** A Drive search that sets which files the model can see, like `"'folder-id' in parents"`. It cannot change it. Default: all of Drive. */
  search?: string;
  /** A few words for those files, like `"the shared proposals"`, said to the model. Default: none. */
  about?: string;
}

export const google: Plugin = {
  name: "google",
  settings: {
    defaults: { connections: { google: { account: "", client: "", callback: "" } } },
    keys: ["connections.google.client"],
    oneOf: { "email.provider": ["gmail"] },
    checks: {
      "connections.google.client": (said) =>
        typeof said === "string" || (!!said && typeof said === "object" && !Array.isArray(said)) ? "" : "is the client file, its path, or its contents as one string.",
    },
  },
  abilities: [
    {
      name: "googleMail",
      label: "Google Mail",
      on: false,
      does: "Reads the Gmail it may see, and can reply to it or write to people you name.",
      tools: ["emailReadMail", "emailReplyMail", "emailSendMail"],
      needs: connection,
      fields: [
        { name: "search", label: "Mail it may read", about: "A Gmail search, like in:inbox label:orders. It cannot change it.", kind: "words", default: "in:inbox" },
        { name: "days", label: "Days back", about: "How far back it looks when it does not say.", kind: "number", default: 7 },
        about("that mail"),
        { name: "sendTo", label: "May write to", about: "Addresses it may send mail to. Empty: it cannot send.", kind: "list", default: [] },
        { name: "sendFrom", label: "Send as", about: "The From line, like Shop <you@gmail.com>. Empty: the signed-in account.", kind: "words", default: "" },
        { name: "sendWhen", label: "When to send", about: "When it should write, said to the model.", kind: "words", default: "When asked to." },
      ],
      preview: { sendTo: ["you@example.com"] },
      make: (_home, v) => {
        const search = v.search as string;
        const what = (v.about as string) || (search === "in:inbox" ? undefined : `mail matching ${search}`);
        const options = { search, days: v.days as number, what };
        const to = v.sendTo as string[];
        return {
          emailReadMail: gmail.readEmail(options),
          emailReplyMail: gmail.replyEmail(options),
          ...(to.length
            ? { emailSendMail: gmail.sendEmail({ from: (v.sendFrom as string) || settings.connections.google.account, to, when: v.sendWhen as string }) }
            : {}),
        };
      },
    },
    {
      name: "googleCalendar",
      label: "Google Calendar",
      on: false,
      does: "Reads events on the Google calendars it may see, and can add one.",
      tools: ["calendarListEvents", "calendarAddEvent"],
      needs: connection,
      fields: [
        { name: "calendars", label: "Calendars", about: "The ids of the calendars it may see. primary is the signed-in account's own.", kind: "list", default: ["primary"] },
        { name: "days", label: "Days ahead", about: "How far ahead it looks when it does not say.", kind: "number", default: 7 },
        about("those calendars"),
      ],
      make: (_home, v) => {
        const calendars = v.calendars as string[];
        const what = (v.about as string) || undefined;
        return {
          calendarListEvents: calendar.listEvents({ calendars, days: v.days as number, what }),
          calendarAddEvent: calendar.addEvent({ calendar: calendars[0] ?? "primary", what }),
        };
      },
    },
    {
      name: "googleDrive",
      label: "Google Drive",
      on: false,
      does: "Finds and reads files in Google Drive as text.",
      tools: ["driveSearchFiles", "driveReadFile"],
      needs: connection,
      fields: [
        { name: "search", label: "Files it may see", about: "A Drive search, like one folder. Empty: all of Drive. It cannot change it.", kind: "words", default: "" },
        about("those files"),
      ],
      make: (_home, v) => {
        const search = v.search as string;
        const what = (v.about as string) || (search ? `Drive files matching ${search}` : "Drive");
        return { driveSearchFiles: drive.searchFiles({ search, what }), driveReadFile: drive.readFile({ search, what }) };
      },
    },
  ],
  email: { gmail: { label: "Gmail, as the Google account", ...gmailProvider } },
  configuration: { title: "Google", about: "Get Gmail, Google Calendar and Google Drive.", fields: [] },
  mailboxes: { gmail: { inbox: () => gmailMailbox, needs: connection } },
  routes: [
    // Where Google stands, and finishing a sign-in with what the person got
    // back. A sign-in starts from a chat or from a connection's own route.
    {
      method: "GET",
      path: "/api/google",
      does: "Whether Google can be reached: which account, what is missing, and whether a sign-in is waiting for its answer.",
      handle: async ({ response }) => json(response, await signInState()),
    },
    {
      method: "GET",
      path: "/api/google/setup",
      does: "The steps to make a Google client in Google's console, and the redirect addresses to give it, exactly as written.",
      handle: ({ response }) => json(response, setupSteps()),
    },
    {
      method: "POST",
      path: "/api/google/sign-in",
      does: "Start signing in to Google, and hand back what to tell the person and the link to open. Finished with /api/google/finish.",
      handle: async ({ response }) => json(response, await googleSignIn.start()),
    },
    {
      method: "POST",
      path: "/api/google/finish",
      does: "Finish the sign-in this runtime started, with the address the browser landed on or the code out of it.",
      takes: '{"answer": "http://127.0.0.1:.../oauth2/callback?code=..."}',
      handle: async ({ request, response }) => {
        const { answer } = await body(request, z.object({ answer: z.string().trim().min(1) }));
        json(response, await finish(answer));
      },
    },
  ],
};
