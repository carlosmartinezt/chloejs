// What the dashboard knows about the channels chloe ships: what each is
// called, which options it takes as plain values, the settings its tokens live
// in, and the function that makes it. The loader does not read this: a channel
// is the object its function made, under its own name in `channels`, the same
// for one chloe ships and one you wrote. This only lets the page show a form
// for the plain values inside the call, and add or remove the call.
import type { OptionSpec } from "#chloe/load/options";

/** One channel chloe ships. */
export interface ChannelKind {
  /** The key it has in `channels`, and its name in the log. */
  name: string;
  /** What the dashboard calls it. */
  label: string;
  does: string;
  /** The options that are plain values, which the dashboard shows as a form. Others (a job, the tools it may use) are written in the file. */
  fields: OptionSpec[];
  /** The secrets it reads, each a setting under `agents.<id>`, like `telegram` or `slack.bot_token`. */
  secrets: { path: string; label: string }[];
  /** The function in `@chloejs/core/channels` that makes it, like `telegramChannel`. */
  fn: string;
  /** Options the channel cannot work without, written when the page adds it. */
  starter?: Record<string, unknown>;
}

const allowFrom = (about: string, numbers = false, required = false): OptionSpec => ({
  name: "allowFrom",
  label: "Who may talk to it",
  about,
  kind: "list",
  default: [],
  numbers,
  required,
});

const inGroups: OptionSpec = {
  name: "inGroups",
  label: "In a group",
  about: "when-addressed answers a command, a mention or a reply to it. always answers everything from the people allowed.",
  kind: "pick",
  pick: ["when-addressed", "always"],
  default: "when-addressed",
};

const sendWhileWorking: OptionSpec = {
  name: "sendWhileWorking",
  label: "Say what it is doing",
  about: "Send what the model writes before its final answer, as it writes it.",
  kind: "yesno",
  default: false,
};

export const CHANNELS: ChannelKind[] = [
  {
    name: "telegram",
    fn: "telegramChannel",
    label: "Telegram",
    does: "A Telegram bot. Anyone it is told to listen to can talk to this agent.",
    fields: [
      allowFrom("Telegram user ids. Leave it empty at first: the bot tells a stranger their id, and the first id here is the owner.", true),
      inGroups,
      sendWhileWorking,
      { name: "stackWithin", label: "Wait, in seconds", about: "How long it waits for more messages in a row before answering them as one. 0 answers each on its own.", kind: "number", default: 1 },
    ],
    secrets: [{ path: "telegram", label: "Bot token, from @BotFather" }],
  },
  {
    name: "slack",
    fn: "slackChannel",
    label: "Slack",
    does: "A Slack app. It answers in a direct message or wherever it is invited.",
    fields: [allowFrom("Slack member ids, like U0123ABCD. Leave it empty at first: the bot tells a stranger their id."), inGroups, sendWhileWorking],
    secrets: [
      { path: "slack.bot_token", label: "Bot token (xoxb-)" },
      { path: "slack.app_token", label: "App token (xapp-)" },
    ],
  },
  {
    name: "discord",
    fn: "discordChannel",
    label: "Discord",
    does: "A Discord bot. It answers in a direct message, or in a server when it is mentioned.",
    fields: [allowFrom("Discord user ids, like 123456789012345678. Leave it empty at first: the bot tells a stranger their id."), inGroups, sendWhileWorking],
    secrets: [{ path: "discord", label: "Bot token, from the Developer Portal" }],
  },
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
  {
    name: "email",
    fn: "emailChannel",
    starter: { mailbox: "gmail" },
    label: "Email",
    does: "A mailbox the agent answers. Mail from anybody else is dropped.",
    fields: [
      allowFrom("The addresses it may write to and hear from. Nobody else is ever sent anything.", false, true),
      { name: "mailbox", label: "Mailbox", about: "gmail uses the Google sign-in. password uses the address and app password below.", kind: "pick", pick: ["gmail", "password"], default: "gmail" },
      { name: "start.when", label: "May start a conversation", about: "When it may write to somebody first, said to the model. Empty: it only answers.", kind: "words", default: "" },
      { name: "start.keep", label: "Keep a copy in", about: "A folder in its memory, like outbox, for a copy of each one it starts. Optional.", kind: "words", default: "" },
    ],
    secrets: [
      { path: "email.address", label: "Mailbox address (password mailbox)" },
      { path: "email.password", label: "App password (password mailbox)" },
    ],
  },
  {
    name: "web",
    fn: "webChannel",
    label: "Chat box on a website",
    does: "A chat box on a web page, for anybody who visits the sites you name. Visitors are strangers.",
    fields: [
      { name: "origins", label: "Sites that may show it", about: "Each a scheme and a host with no path, like https://myshop.com.", kind: "list", default: [], required: true },
      { name: "greeting", label: "Greeting", about: "What the chat box shows before anybody has written.", kind: "words", default: "" },
      { name: "pictures", label: "Pictures", about: "Let a visitor send pictures, up to 2 in one message.", kind: "yesno", default: false },
      { name: "limits.perVisitor.messages", label: "Messages for each visitor", about: "The most in 24 hours.", kind: "number", default: 30 },
      { name: "limits.perVisitor.dollars", label: "Dollars for each visitor", about: "The most it may spend on one visitor in 24 hours.", kind: "number", default: 0.5 },
      { name: "limits.perDay.dollars", label: "Dollars for all visitors", about: "The most it may spend on all visitors together in 24 hours.", kind: "number", default: 5 },
    ],
    secrets: [],
  },
  {
    name: "api",
    fn: "apiChannel",
    label: "API",
    does: "Lets a token chat to the agent and start its jobs.",
    fields: [],
    secrets: [],
  },
];
