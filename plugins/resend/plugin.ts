// Resend: sending mail on a key, from an address on a domain of the owner's.
// It sends a job's mail when `email.provider` is "resend", the
// `resendSendEmail` ability and tool, and the alerts.
import { settings } from "#chloe/core/settings";
import type { Plugin } from "#chloe/load/plugin";
import type { Tools } from "#chloe/model/tool";
import { deliverEmail } from "#chloe/services/emailService";
import { resend as connection } from "./connection.ts";
import { sendEmail as resendSendEmail } from "./resend.ts";
import { resendProvider } from "./resendService.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the tool `resendSendEmail`, which sends one email through Resend to
     * people you name. Off by default, and adds nothing until `from` and `to`
     * are filled in. Needs `connections.resend.api_key`: without it nothing is
     * sent and nothing fails.
     */
    resend?: boolean | ResendAbility;
  }
}

declare module "#chloe/core/settings" {
  interface Connections {
    /** Resend, a service that sends email. */
    resend: {
      /**
       * Your Resend API key. Everything sent through Resend needs it: the
       * `resend.sendEmail` tool, `deliverEmail()` when `email.provider` is
       * "resend", and the alerts. It is a secret: put it in `.env`.
       * Default: "" (none). Without it, sending through Resend fails with an
       * error that says where to put the key.
       */
      api_key: string;
      /**
       * Turns on alert emails. chloe sends one when:
       * - someone signs in to the dashboard from an IP address it has not seen before,
       * - an IP address is locked out after too many wrong passwords,
       * - a job starts failing, and again when it works (one email each time,
       *   not one per failure).
       *
       * On by default. An alert is sent only when `api_key`, `email_to` and
       * `email_from` are all set. Alerts always go through Resend, even when
       * `email.provider` is "gmail". With alerts off, each sign-in is still
       * recorded.
       */
      alerts: boolean;
      /**
       * Where alerts go: one email address, or several separated by commas.
       * Default: "" (none, so no alerts are sent).
       */
      email_to: string;
      /**
       * The From line of an alert, like "Chloe <info@example.com>". It must be
       * on a domain your Resend account can send from. Default: "" (none, so
       * no alerts are sent).
       */
      email_from: string;
    };
  }
  interface EmailProviders {
    /** Sends through Resend, with `connections.resend.api_key`. */
    resend: true;
  }
}

/** The fields of `abilities.resend`, the same shape as a bound Resend tool. */
export interface ResendAbility {
  /** The From line it sends under, like `"Shop <shop@example.com>"`. Must be on a domain set up in Resend. Required. */
  from?: string;
  /** The addresses it may write to. Required. */
  to?: string[];
  /** When it should send, in your words, said to the model. Required. */
  when?: string;
  /** The addresses a reply goes to. Empty: the `from` address. */
  replyTo?: string[];
  /** Put in front of every subject, `[tag]`, so an inbox can filter it. Default: none. */
  tag?: string;
  /** Send the body as HTML with a plain text copy. Default: off. */
  markdown?: boolean;
  /** A folder in its memory, like `"outbox"`, that gets a copy of each email sent. Default: none. */
  keep?: string;
}

export const resend: Plugin = {
  name: "resend",
  settings: {
    defaults: { email: { provider: "resend" }, connections: { resend: { api_key: "", alerts: true, email_to: "", email_from: "" } } },
    keys: ["connections.resend.api_key"],
    oneOf: { "email.provider": ["resend"] },
  },
  abilities: [
    {
      name: "resend",
      label: "Send email (Resend)",
      on: false,
      does: "Sends one email through Resend to people you name. Nothing is sent without a key.",
      tools: ["resendSendEmail"],
      needs: connection,
      fields: [
        { name: "from", label: "Send as", about: "The From line, like Shop <shop@example.com>. Must be on a domain set up in Resend.", kind: "words", default: "", required: true },
        { name: "to", label: "May write to", about: "The addresses it may send to.", kind: "list", default: [], required: true },
        { name: "when", label: "When to send", about: "When it should write, said to the model.", kind: "words", default: "", required: true },
        { name: "replyTo", label: "Replies go to", about: "The addresses a reply goes to. Empty: the From line.", kind: "list", default: [] },
        { name: "tag", label: "Subject tag", about: "Put in front of every subject, like [orders], so an inbox can filter it.", kind: "words", default: "" },
        { name: "markdown", label: "Send as HTML", about: "Send the body as HTML with a plain text copy.", kind: "yesno", default: false },
        { name: "keep", label: "Keep a copy in", about: "A folder in its memory, like outbox, for a copy of each email sent.", kind: "words", default: "" },
      ],
      preview: { from: "you@example.com", to: ["you@example.com"], when: "When asked to." },
      make: (_home, v): Tools => {
        const from = v.from as string;
        const to = v.to as string[];
        const when = v.when as string;
        if (!from || to.length === 0 || !when) return {};
        const replyTo = v.replyTo as string[];
        return {
          resendSendEmail: resendSendEmail({
            from,
            to,
            when,
            ...(replyTo.length ? { replyTo } : {}),
            ...(v.tag ? { tag: v.tag as string } : {}),
            markdown: Boolean(v.markdown),
            ...(v.keep ? { keep: v.keep as string } : {}),
          }),
        };
      },
    },
  ],
  email: { resend: { label: "Resend", ...resendProvider } },
  configuration: {
    title: "Resend",
    about: "Sends email, and the alerts: someone signed in from a new place, or a job started or stopped failing.",
    fields: [
      { path: "connections.resend.api_key", label: "Resend API key", kind: "secret" },
      { path: "connections.resend.alerts", label: "Send alerts", kind: "switch" },
      { path: "connections.resend.email_to", label: "Alerts go to", placeholder: "you@example.com" },
      { path: "connections.resend.email_from", label: "Alerts come from", placeholder: "Chloe <alerts@example.com>", about: "Must be on a domain your Resend account can send from." },
    ],
  },
  alerts: {
    say() {
      const { alerts, api_key, email_to, email_from } = settings.connections.resend;
      if (!alerts) return "off";
      const missing = [!api_key && "connections.resend.api_key", !email_to.trim() && "connections.resend.email_to", !email_from && "connections.resend.email_from"].filter(Boolean);
      if (missing.length) return `on, but none can be sent: ${missing.join(", ")} not set`;
      return `on, to ${email_to}`;
    },
    async send(subject, body) {
      const { alerts, api_key, email_to, email_from } = settings.connections.resend;
      const to = email_to.split(",").map((one) => one.trim()).filter(Boolean);
      if (!alerts || !api_key || !to.length || !email_from) return;
      await deliverEmail({ from: email_from, to, tag: "chloe" }, subject, body, "resend");
    },
  },
};
