// Email: a conversation per address, through a mailbox the agent signs in to,
// on an app password or a plugin's (Google's "gmail"), or one of the owner's
// own. A reply is taken only from the person its address was made for, with a
// DKIM signature that checks out.
import { allowFrom } from "#chloe/channels/catalog";
import type { Plugin } from "#chloe/load/plugin";
import { mailboxNames } from "./email.ts";

declare module "#chloe/core/mail" {
  interface Mailboxes {
    /** The mailbox in `agents.<id>.email`, read with IMAP and sent through with SMTP, on an app password. */
    password: true;
  }
}

declare module "#chloe/core/settings" {
  interface AgentSettings {
    /**
     * The mailbox an email channel signs in to with `mailbox: "password"`.
     * Default: all "".
     */
    email: {
      /** The mailbox's address, which mail goes out from, like "shop@fastmail.com". */
      address: string;
      /**
       * Its password: an app password, which Gmail (with 2-Step Verification),
       * iCloud and Fastmail make in their account settings for a mail program.
       */
      password: string;
      /**
       * The server mail is read from, "host:port", from the provider's help on
       * IMAP. Default: "", which is the provider's own for Gmail, iCloud and Fastmail.
       */
      imap: string;
      /**
       * The server mail is sent through, "host:port", from the provider's help
       * on SMTP. Default: "", which is the provider's own for Gmail, iCloud and Fastmail.
       */
      smtp: string;
    };
  }
}

/** The mailboxes the Channels page offers: each plugin's, then the password one. */
const offered = () => [...mailboxNames(), "password"];

export const email: Plugin = {
  name: "email",
  settings: { agent: { email: { address: "", password: "", imap: "", smtp: "" } } },
  channels: [
    {
      name: "email",
      fn: "emailChannel",
      get starter() {
        return { mailbox: offered()[0] };
      },
      label: "Email",
      does: "A mailbox the agent answers. Mail from anybody else is dropped.",
      get fields() {
        return [
          allowFrom("The addresses it may write to and hear from. Nobody else is ever sent anything.", false, true),
          {
            name: "mailbox",
            label: "Mailbox",
            about: "password uses the address and app password below. Any other is a connection's, like gmail, which uses the Google sign-in.",
            kind: "pick" as const,
            pick: offered(),
            default: offered()[0],
          },
          { name: "start.when", label: "May start a conversation", about: "When it may write to somebody first, said to the model. Empty: it only answers.", kind: "words" as const, default: "" },
          { name: "start.keep", label: "Keep a copy in", about: "A folder in its memory, like outbox, for a copy of each one it starts. Optional.", kind: "words" as const, default: "" },
        ];
      },
      secrets: [
        { path: "email.address", label: "Mailbox address (password mailbox)" },
        { path: "email.password", label: "App password (password mailbox)" },
      ],
    },
  ],
};
