import { defineAgent, startChloe } from "@chloejs/core";
import { telegramChannel } from "@chloejs/core/channels";
import * as gmail from "@chloejs/core/tools/gmail";

const inbox = defineAgent({
  id: "inbox",
  description: "Answers questions about your email.",
  instructions: "You help me keep on top of my email. Be brief.",
  model: "anthropic/claude-sonnet-5",
  tools: { gmailReadEmail: gmail.readEmail() },
  channels: [telegramChannel({ allowFrom: [123456789] })],
});

await startChloe({
  agents: [inbox],
  settings: {
    connections: { google: { account: "you@gmail.com", client: process.env.GOOGLE_CLIENT } },
    agents: { inbox: { telegram: process.env.TELEGRAM_TOKEN } },
  },
});
