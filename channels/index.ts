// The ways an agent is reached. Each is a function an agent calls in the
// `channels` list of its agent.ts.
//
//   import { telegramChannel, apiChannel, webChannel } from "@chloejs/core/channels";
//
// A channel chloe does not ship is written in the agent's own channels/
// folder, and hands each message to `receive`. Same rule as `index.ts`:
// adding a name here is publishing it.

export { telegramChannel, type TelegramOptions } from "./telegram.ts";
export { slackChannel, type SlackOptions } from "./slack.ts";
export { whatsappChannel, type WhatsAppOptions } from "./whatsapp.ts";
export { emailChannel, openEmail, type EmailOptions, type Mailbox, type OutgoingMail, type Started } from "./email.ts";
export { apiChannel } from "./api.ts";
export { webChannel, type WebOptions, type WebLimits } from "./web.ts";
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
  type Rules,
  type While,
  type Handled,
  type Button,
} from "./shared.ts";
