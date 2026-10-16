// WhatsApp: a number on WhatsApp's own API, which pushes each message to a
// route of its own that the owner's web server passes on.
import { allowFrom, sendWhileWorking } from "#chloe/channels/catalog";
import type { Plugin } from "#chloe/load/plugin";

declare module "#chloe/core/settings" {
  interface AgentSettings {
    /**
     * The agent's WhatsApp number, on WhatsApp's own API. You find all three
     * values on your app's pages at developers.facebook.com. Default: all "".
     */
    whatsapp: {
      /** The id of the phone number. This is not the phone number itself. */
      phone_number_id: string;
      /** A permanent access token for the app. */
      token: string;
      /**
       * The app secret. chloe uses it to check that each message really comes
       * from Meta. Without it, every message is refused.
       */
      app_secret: string;
    };
  }
}

export const whatsapp: Plugin = {
  name: "whatsapp",
  settings: { agent: { whatsapp: { phone_number_id: "", token: "", app_secret: "" } } },
  channels: [
    {
      name: "whatsapp",
      fn: "whatsappChannel",
      label: "WhatsApp",
      does: "A number on WhatsApp's own API. It answers one-to-one messages, and WhatsApp allows no groups on it.",
      fields: [
        allowFrom("Phone numbers in full form, like +447700900123. Leave it empty at first: the number tells a stranger theirs."),
        sendWhileWorking,
        { name: "publicUrl", label: "Public address", about: "Where this server is reached from the internet, only to write the address to register with Meta in the log.", kind: "words", default: "" },
      ],
      secrets: [
        { path: "whatsapp.phone_number_id", label: "Phone number id" },
        { path: "whatsapp.token", label: "Access token" },
        { path: "whatsapp.app_secret", label: "App secret" },
      ],
    },
  ],
};
