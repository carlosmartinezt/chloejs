// What the dashboard knows about the channels chloe ships: what each is
// called, which options it takes as plain values, the settings its tokens live
// in, and the function that makes it. The loader does not read this: a channel
// is the object its function made, under its own name in `channels`, the same
// for one chloe ships and one you wrote. This only lets the page show a form
// for the plain values inside the call, and add or remove the call.
import type { Agent } from "#chloe/load/load";
import type { OptionSpec } from "#chloe/load/options";
import { PLUGINS } from "#chloe/plugins/index";

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
  /** What the page says about this agent's channel of this kind, when it has one, in place of `does`. */
  doing?(agent: Agent): string | undefined;
  /** Options the channel cannot work without, written when the page adds it. */
  starter?: Record<string, unknown>;
}

export const allowFrom = (about: string, numbers = false, required = false): OptionSpec => ({
  name: "allowFrom",
  label: "Who may talk to it",
  about,
  kind: "list",
  default: [],
  numbers,
  required,
});

export const inGroups: OptionSpec = {
  name: "inGroups",
  label: "In a group",
  about: "when-addressed answers a command, a mention or a reply to it. always answers everything from the people allowed.",
  kind: "pick",
  pick: ["when-addressed", "always"],
  default: "when-addressed",
};

export const sendWhileWorking: OptionSpec = {
  name: "sendWhileWorking",
  label: "Say what it is doing",
  about: "Send what the model writes before its final answer, as it writes it.",
  kind: "yesno",
  default: false,
};

/** The API channel, which every agent may bind, then each plugin's. */
const API: ChannelKind = {
  name: "api",
  fn: "apiChannel",
  label: "API",
  does: "Lets a token chat to the agent and start its jobs.",
  fields: [],
  secrets: [],
};

/** Every channel chloe ships: each plugin's, in the list's order, then the API channel. */
export function channelKinds(): ChannelKind[] {
  return [...PLUGINS.flatMap((one) => one.channels ?? []), API];
}
