// This agent on Telegram. Its token, from @BotFather, goes in .env as
// CHLOE_AGENTS_SHOP_TELEGRAM, and chloe.config.ts hands it over as
// `agents: { shop: { telegram: process.env.CHLOE_AGENTS_SHOP_TELEGRAM } }`.
// Without one the reader says so and does not start.
//
// allowFrom is Telegram user ids, and an empty list answers nobody, which is
// the safe way for this to arrive. Put your own id in it: message the bot, read
// the id out of the log line, and save.
import { telegramChannel } from "@chloejs/core/channels";

export default telegramChannel({ allowFrom: [] });
