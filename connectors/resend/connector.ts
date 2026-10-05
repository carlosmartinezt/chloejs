// Resend, on a key: mail sent from an address on a domain the person owns.
import { settings } from "#chloe/core/settings";
import type { Connector } from "#chloe/connectors/connector";

export const resend: Connector = {
  name: "resend",
  does: "Where its mail is sent. Without a key nothing is sent and nothing fails.",
  settings: ["resend.api_key"],
  async missing() {
    return settings.resend.api_key.trim() ? [] : ["resend.api_key is not set: put it in .env as CHLOE_RESEND_API_KEY"];
  },
};
