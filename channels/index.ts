// The ways an agent is reached. Each is a function an agent calls in the
// `channels` list of its agent.ts.
//
//   import { telegramChannel, apiChannel, webChannel } from "@chloejs/core/channels";
//
// A channel chloe does not ship is written in the agent's own channels/
// folder, and hands each message to `receive`. Same rule as `index.ts`:
// adding a name here is publishing it.

export { telegramChannel, type TelegramOptions } from "#chloe/plugins/telegram/telegram";
export { slackChannel, type SlackOptions } from "#chloe/plugins/slack/slack";
export { discordChannel, type DiscordOptions } from "#chloe/plugins/discord/discord";
export { whatsappChannel, type WhatsAppOptions } from "#chloe/plugins/whatsapp/whatsapp";
export { emailChannel, openEmail, type EmailOptions, type Mailbox, type OutgoingMail, type Started } from "#chloe/plugins/email/email";
export { apiChannel } from "./api.ts";
export { webChannel, type WebOptions, type WebLimits } from "#chloe/plugins/web-channel/web";
export {
  defineChannel,
  rulesOf,
  receive,
  commands,
  inPieces,
  type Shared,
  type Answering,
  type Starting,
  type Bound,
  type Incoming,
  type Files,
  type Rules,
  type While,
  type Handled,
  type Button,
} from "./shared.ts";
export type { FileToSend } from "#chloe/model/tools/chat";
