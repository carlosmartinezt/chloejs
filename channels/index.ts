// The ways an agent is reached. Each is a function an agent calls in the
// `channels` list of its agent.ts.
//
//   import { telegramChannel, apiChannel } from "@chloejs/core/channels";
//
// A channel chloe does not ship is written in the agent's own channels/
// folder, and hands each message to `receive`. Same rule as `index.ts`:
// adding a name here is publishing it.

export { telegramChannel, type TelegramOptions } from "./telegram.ts";
export { slackChannel, type SlackOptions } from "./slack.ts";
export { apiChannel } from "./api.ts";
export { receive, commands, type Incoming, type Rules, type While, type Handled } from "./shared.ts";
