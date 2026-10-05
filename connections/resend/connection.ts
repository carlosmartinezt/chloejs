// Resend, on a key: mail sent from an address on a domain the person owns.
import { settings, whereKeyGoes } from "#chloe/core/settings";
import type { Connection } from "#chloe/connections/connection";

export const resend: Connection = {
  name: "resend",
  does: "Where its mail is sent. Without a key nothing is sent and nothing fails.",
  settings: ["connections.resend.api_key"],
  async missing() {
    return settings.connections.resend.api_key.trim() ? [] : [`connections.resend.api_key is not set: put it ${whereKeyGoes(["connections", "resend", "api_key"])}`];
  },
};
