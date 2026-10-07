// Every agent this copy runs, and how the runtime behaves. An agent is on this
// list or it does not exist.
//
// `settings` is every choice, as deep as it goes, and what it leaves out is the
// default. This file is in source control, so a key goes in .env beside it and
// is named here as `process.env.` and its name in .env. chloe reads no key it
// is not handed here.
import { defineConfig } from "@chloejs/core";

import shop from "./agent.ts";

export default defineConfig({
  agents: [shop],
  settings: {
    // What an agent asks when its own agent.ts names none, and the gateway's key.
    model: { defaultModel: "anthropic/claude-sonnet-5", key: process.env.CHLOE_MODEL_KEY },
    // The shop's own channels: its Telegram bot and its WhatsApp number.
    agents: {
      shop: {
        telegram: process.env.CHLOE_AGENTS_SHOP_TELEGRAM,
        whatsapp: {
          phone_number_id: process.env.CHLOE_AGENTS_SHOP_WHATSAPP_PHONE_NUMBER_ID,
          token: process.env.CHLOE_AGENTS_SHOP_WHATSAPP_TOKEN,
          app_secret: process.env.CHLOE_AGENTS_SHOP_WHATSAPP_APP_SECRET,
        },
      },
    },
  },
});
