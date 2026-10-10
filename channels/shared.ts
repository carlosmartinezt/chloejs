// What every channel shares: what happens to a message, whichever channel it
// came in on. A channel turns its platform's message into an `Incoming`, calls
// receive(), and sends back the text it returns. Everything else is decided
// here, once, so Telegram, the API and any channel written later behave the
// same way. A channel written in an agent's own folder imports it too:
//
//   import { receive, type Incoming } from "@chloejs/core/channels";
//
// In order, and the first that applies decides:
//
//   1. Somebody not in allowFrom gets nothing. While allowFrom is empty, a
//      private message is told the sender's id, which is what goes in it.
//   2. The answer to a sign-in the runtime started (a code, or the address
//      the browser landed on) goes to the connection that started it, and is
//      never shown to a model. What was asked before it is then asked again.
//      An answer to a job waiting on this chat goes to that job.
//   3. In a group, a message that is not for the agent is left alone, unless
//      the channel's inGroups is "always".
//   4. "/<job id> ..." runs that job. "_" stands for "-", because some
//      platforms allow no hyphens in a command. The words after it fill the
//      job's `args` in order, the last field taking the rest of the line. "/models" and "/model" are
//      the agent's own, and pick which model answers.
//   5. Anything else is a turn, shown the chat's recent conversation. Its
//      reply is only ever sent: one that reads "/<job id>" starts nothing,
//      because the model may have read a page or a mail written to ask for it.
//      A job starts on its schedule or from a command a person sent.
//
// On a channel for strangers (`strangers` in Rules), there is no sign-in in 2
// and nothing in 4: a slash is only text, and the message is a turn.
//
// A channel can narrow 5, or replace it, with the two options every channel
// takes (`Answering`): `tools`, the only tools its turns have, and `job`, a
// job every message starts in place of a turn. With a job there is no model
// pick, no sign-in and no /command either: the job decides.
//
// What a job said in a chat is kept in that chat's conversation, so the next
// turn knows it happened.
import { z } from "zod";

import type { Agent, Channel, ChatHistory, Job, Running } from "#chloe/load/load";
import type { JobConfig } from "#chloe/load/job";
import type { Attachment } from "#chloe/model/model";
import { choices, choose, chosen, modelFor, type Scope } from "#chloe/model/choices";
import { forget, remember } from "#chloe/model/memory";
import { models, UsageLimit } from "#chloe/model/model";
import { clock, type Fired, ran } from "#chloe/core/clock";
import { settings } from "#chloe/core/settings";
import { answer, waitingOn, WrongArgs } from "#chloe/core/steps";
import { turn } from "#chloe/core/turn";
import type { Connection } from "#chloe/connections/connection";
import { neededBy, type ChloeTool } from "#chloe/model/tool";

/**
 * One message, in the form `receive()` takes from every channel. Your channel
 * turns each message from its platform into one of these.
 */
export interface Incoming {
  /**
   * The channel's name, like "telegram". It shows in the log, and it is the
   * first part of every address on the channel, like `telegram:123456789`.
   */
  channel: string;
  /**
   * The id of the chat the message was sent in, as the platform writes it. A
   * job asks somebody here with the address `<channel>:<chat>`.
   */
  chat: string;
  /**
   * The id of the conversation the message belongs to, usually one per chat,
   * or one per topic in a forum. The agent remembers the conversation under
   * this id. Make it unique, like `<agent id>/<channel>-<chat>`. An empty
   * string means nothing is remembered.
   */
  thread: string;
  /** Who sent the message: their id on the platform, and a name to show. `allowFrom` is checked against `id`. */
  from: { id: string; name: string };
  /** The words of the message. */
  text: string;
  /** `true` for a one-to-one chat, `false` for a group. */
  private: boolean;
  /**
   * In a group: `true` when the message mentions the agent or replies to it.
   * A group message that is not addressed (and is not a `/command`) gets no
   * answer, unless the channel's `inGroups` is "always".
   */
  addressed?: boolean;
  /** The group's title, if it has one. A job reads it as `work.input.chatTitle`. */
  chatTitle?: string;
  /** The text of the message this one replies to, if it is a reply. A job reads it as `work.input.replyTo`. */
  replyTo?: string;
  /**
   * Facts about where the message was sent, like `chat_type` and
   * `chat_title`. The model gets them before the message, with the sender's
   * name. Leave this out when the sender is a program: the model then gets
   * the message alone.
   */
  context?: Record<string, string>;
  /**
   * Fetches the files on the message. It is only called when the model is
   * going to read them.
   *
   * - `attachments`: files the model receives, like pictures and PDFs.
   * - `text`: the text of text files, added after the message.
   * - `notes`: short lines added after the message, like "(Attached: plan.pdf)".
   */
  files?: () => Promise<{ attachments?: Attachment[]; text?: string; notes?: string[] }>;
  /** The model to use for this one reply, when the channel lets the sender pick one. */
  model?: string;
  /** The names of tools the agent may not use in this one reply, even though it has them. */
  withoutTools?: string[];
  /**
   * Whether the agent's owner sent the message. Set it only when your channel
   * knows, like the dashboard's own chat.
   *
   * If not set, `receive()` finds it: the sender is the owner when they match
   * `owner` in settings, or when they are the first entry in the channel's
   * `allowFrom`. Always `false` on a channel for strangers.
   *
   * Only the owner's messages can use the tools that read the agent's own
   * files and past runs, and other tools only the owner may use.
   */
  fromOwner?: boolean;
  /**
   * Whether the sender may change the agent, for example with
   * `selfWriteFile`. If not set, the owner may and nobody else may. Set it to
   * `false` to stop the owner too. Setting it to `true` does nothing for a
   * sender who is not the owner.
   */
  mayChangeAgent?: boolean;
  /** Abort it to stop the reply, for example when the person has left. */
  signal?: AbortSignal;
}

/**
 * The rules `receive()` follows on one channel: who gets an answer, and what
 * their messages get. Make them with `rulesOf()` from the channel's options.
 */
export interface Rules {
  /**
   * The ids of the people allowed to reach the agent, as the platform writes
   * them.
   *
   * If not set, anybody who reaches the channel may, which is safe only
   * behind a login. An empty list lets nobody in: a private message is
   * answered with the sender's id, so you can add it.
   */
  allowFrom?: (string | number)[];
  /**
   * Which messages in a group get an answer. Default: "when-addressed".
   *
   * - "when-addressed": a `/command`, a mention of the agent, or a reply to it.
   * - "always": every message.
   */
  inGroups?: "when-addressed" | "always";
  /** How much of the conversation the agent sees with each new message. Default: the last 10 messages. */
  chatHistory?: ChatHistory;
  /**
   * Sends what the model writes before its final answer (like a "let me
   * check" line) as soon as it is written. Off by default.
   *
   * It needs a channel that can send more than one message for each message
   * it gets (`send` in `While`), so it does nothing on the API.
   */
  sendWhileWorking?: boolean;
  /**
   * Treats everyone who writes as a stranger, like a visitor on a web page.
   * Off by default.
   *
   * A stranger's message gets a reply, clears the conversation with `/clear`,
   * or answers a job that asked them. It is never a `/command`, a model pick
   * or a sign-in code, and no sign-in is ever started for a stranger.
   */
  strangers?: boolean;
  /**
   * The names of the only tools the agent may use in a reply on this
   * channel. `rulesOf()` fills it from the channel's `tools` option. If not
   * set, the agent has every tool.
   */
  tools?: string[];
  /** The id of the job every message on this channel starts. `rulesOf()` fills it from the channel's `job` option. */
  job?: string;
}

/**
 * Two options every channel takes, `tools` and `job`. Both are optional. Use
 * them when messages on a channel should not get a normal reply that can use
 * every tool the agent has.
 */
export interface Answering {
  /**
   * The only tools the agent may use when it replies on this channel. Give
   * each one as the tool itself or as its name in the agent's `tools`, like
   * `tools: [tools.readPage]` or `tools: ["webReadPage"]`. If not set, the
   * agent has every tool.
   *
   * The agent also keeps its memory tools and its skills. When the owner
   * writes, it also keeps the tools that read its own files and past runs.
   * `selfWriteFile` is only included when you name it.
   *
   * A tool given as an object that is not in the agent's `tools` stops the
   * agent from loading. A name the agent does not have is skipped, with a
   * line in the log.
   */
  tools?: (ChloeTool | string)[];
  /**
   * A job that every message on this channel starts, in place of a normal
   * reply. Use it when code should handle the message first, for example to
   * look up who wrote.
   *
   * The job reads the message from `work.input`, and what it returns is sent
   * back as the reply. It must be a code job, with `run` and no `cron`.
   *
   * Name the job here only, not in the agent's `jobs`. The agent loads it from
   * here, and only a message on this channel starts it: no command, cron line
   * or API call can.
   *
   * Each conversation runs it for one message at a time. A message sent while
   * the job is still busy with the last one is not queued: the sender is
   * asked to send it again. Different conversations run it at the same time.
   *
   * With a job, the channel has no model picking, no sign-in and no
   * `/commands`. `/clear` still works.
   */
  job?: JobConfig<any, any, any, any>;
}

/**
 * A channel's `tools` and `job` options after they are checked against the
 * agent: tool names and a job id. Your channel gets it as `Starting.bound`.
 * Pass it on to `rulesOf()`.
 */
export type Bound = Pick<Rules, "tools" | "job">;

/**
 * The options every channel takes, whatever its platform. A channel's own
 * options type extends this. `defineChannel()` and `rulesOf()` read them.
 */
export interface Shared extends Answering {
  /**
   * The channel's name. Default: the kind of channel, like "telegram".
   *
   * Set it only when the agent has two channels of one kind, because two
   * channels of one agent cannot share a name. The name shows in the log,
   * and it is the first part of every address on the channel.
   */
  name?: string;
  /** The people allowed to reach the agent, by their id on the platform. */
  allowFrom?: (string | number)[];
  /**
   * How much of the conversation the agent sees with each new message:
   * `{ messages, days }`. `messages` is the most it sees, and `days` leaves
   * out anything older. Default: the last 10 messages.
   */
  chatHistory?: ChatHistory;
  /**
   * Sends what the model writes before its final answer (like a "let me
   * check" line) as soon as it is written. Off by default. It does nothing on
   * a channel that sends only one reply per message, like email.
   */
  sendWhileWorking?: boolean;
}

/** What `defineChannel()` gives your channel's `start` function. */
export interface Starting {
  /**
   * Returns the agent. Call it for each message rather than once: after an
   * edit to the agent, it returns the new version. `undefined` once the agent
   * is gone.
   */
  agent: () => Agent | undefined;
  /** The agent's id. */
  agentId: string;
  /** The channel's name: its `name` option, or its kind, like "telegram". */
  name: string;
  /** The channel's `tools` and `job`, checked against the agent. Pass them to `rulesOf()`. */
  bound: Bound;
}

/**
 * Makes a channel. It does the work every channel shares, so your code only
 * has to talk to the platform.
 *
 * - `kind`: the platform, like "telegram". It is also the channel's name,
 *   unless `options.name` sets another.
 * - `options`: the channel's options, which include the shared ones (see
 *   `Shared`).
 * - `start`: connects to the platform. It reads each message, hands it to
 *   `receive()` with `rulesOf()` of the options, and sends back the reply. It
 *   returns how to stop.
 * - `more.hidden`: options to leave out of what the dashboard shows, like
 *   options only tests use. A change to one of them does not restart the
 *   channel.
 *
 * When the agent loads, it checks `tools` and `job` against the agent and
 * loads the job. When the agent reloads and any other option has changed,
 * the channel is restarted.
 */
export function defineChannel<O extends Shared>(
  kind: string,
  options: O,
  start: (starting: Starting) => Running,
  more: { hidden?: (keyof O)[] } = {},
): Channel {
  const name = options.name ?? kind;
  let bound: Bound = {};
  const shown = Object.fromEntries(Object.entries(options).filter(([key]) => !more.hidden?.includes(key as keyof O)));
  return {
    name,
    chatHistory: options.chatHistory,
    job: options.job,
    get madeWith() {
      return madeWith(shown, bound);
    },
    check(agent) {
      bound = bind(agent, name, options);
    },
    start(agent) {
      return start({ agent, agentId: agent()?.id ?? "", name, bound });
    },
  };
}

/**
 * Makes the `Rules` that `receive()` takes, from a channel's options. Put
 * `bound` (from `Starting`) in the options too.
 *
 * Give `allowFrom` as the second argument to use another list, for example
 * the ids written the way your platform sends them. If neither gives a list,
 * anybody who reaches the channel may talk to the agent, so on a public
 * platform pass `[]`.
 */
export function rulesOf(options: Shared & { inGroups?: Rules["inGroups"]; bound?: Bound }, allowFrom = options.allowFrom): Rules {
  return { allowFrom, inGroups: options.inGroups, chatHistory: options.chatHistory, sendWhileWorking: options.sendWhileWorking, ...options.bound };
}

/**
 * Reads a channel's `tools` and `job` against the agent it is bound to, as
 * the agent loads (a channel's `check`), into what its rules take. Throws,
 * saying why, for a tool object that is not the agent's. A name it does not
 * have is said in the log and left out, since a connection that did not
 * answer leaves its tools out too.
 */
export function bind(agent: Agent, channel: string, options: Answering): Bound {
  const bound: Bound = {};
  if (options.tools) {
    const own = Object.entries(agent.tools ?? {});
    bound.tools = options.tools.map((one) => {
      if (typeof one === "string") {
        if (one !== "skillRead" && !agent.tools?.[one]) {
          console.error(`${agent.id}: its ${channel} channel names ${one}, which it does not have, so a turn there goes without it. It has: ${own.map(([name]) => name).join(", ") || "none"}.`);
        }
        return one;
      }
      const found = own.find(([, tool]) => tool === one);
      if (!found) throw new Error(`its ${channel} channel names a tool that is not in its tools. Add it to tools in agent.ts, and name it from there.`);
      return found[0];
    });
  }
  // The loader has made it one of the agent's jobs, and checked it.
  if (options.job) bound.job = options.job.id;
  return bound;
}

/**
 * A channel's options as they are written out for `madeWith`: its tools by
 * name and its job by id, so a reload restarts the channel when either
 * changes, and nothing is written out of a tool but its name.
 */
export function madeWith(options: object, bound: Bound): string {
  const said = options as Answering;
  return JSON.stringify({
    ...options,
    ...(said.tools && { tools: bound.tools ?? said.tools.map((one) => (typeof one === "string" ? one : "(a tool)")) }),
    ...(said.job && { job: said.job.id }),
  });
}

/**
 * What your channel can give `receive()` to use while it works on a message.
 * Every field is optional.
 */
export interface While {
  /**
   * Called when there is work to do, to show something like "typing...". It
   * returns a function, which is called when the work is over.
   */
  working?: () => () => void;
  /** Sends one message to the chat. `sendWhileWorking` uses it. */
  send?: (text: string) => Promise<void>;
  /** Called as each tool starts, with the tool's name, and its title if it has one. */
  calling?: (tool: { name: string; title?: string }) => void;
  /**
   * Called with each new piece of the reply as the model writes it, for a
   * model that sends its words as it goes. Words written before a tool call
   * come here too, and with `sendWhileWorking` on they are then also passed
   * to `send` in one piece.
   */
  writing?: (delta: string) => void;
}

/**
 * What `receive()` returns for a message. `undefined` in its place means the
 * message was not for the agent, and nothing should be sent.
 */
export interface Handled {
  /**
   * What to send back. Empty when there is nothing to send, for example when
   * a job already sent a question and is waiting for the answer.
   */
  text: string;
  /** The id of the run that handled the message, if one ran. */
  runId?: string;
  /** How many steps the run took. 0 when nothing ran. */
  steps: number;
  /** What the run cost, in US dollars. 0 when nothing ran. */
  cost: number;
  /** How many of the run's model answers came with no price. Set only when some did: the run then cost at least `cost`. */
  unpriced?: number;
  /** The id of the job that handled the message, if a job did. */
  job?: string;
  /**
   * Choices to show under the text, on a channel that can show buttons.
   * Pressing one sends its `sends` text as if the person had typed it.
   */
  buttons?: Button[];
}

/** One button under a reply. */
export interface Button {
  /** The words on the button. */
  label: string;
  /** The text sent when somebody presses the button, as if they had typed it. */
  sends: string;
}

/**
 * Handles one message from any channel and returns what to send back. Call it
 * from your channel for each message, with the agent, the message, the rules
 * from `rulesOf()`, and optionally `While` for showing progress.
 *
 * The first of these that fits decides what happens:
 *
 * 1. A sender not in `allowFrom` gets nothing.
 * 2. `/clear` starts the conversation fresh.
 * 3. `/models` lists the models, and `/model <name>` picks one.
 * 4. A sign-in code goes to the connection that asked for it. The model never
 *    sees it.
 * 5. An answer to a job that is waiting on this chat goes to that job.
 * 6. A group message that is not for the agent is left alone.
 * 7. On a channel with a `job`, that job handles the message.
 * 8. `/<job id> ...` runs that job. The words after it fill the job's `args`.
 * 9. Anything else gets a reply from the model.
 *
 * Returns `undefined` when the message was not for the agent.
 */
export async function receive(agent: Agent, message: Incoming, rules: Rules = {}, whileWorking: While = {}): Promise<Handled | undefined> {
  const working = whileWorking.working ?? (() => () => {});
  const { channel, from, text } = message;
  const said = (words: string): Handled => ({ text: words, steps: 0, cost: 0 });

  if (rules.allowFrom) {
    if (rules.allowFrom.length === 0) {
      console.log(`${channel}: ${from.id} wrote to ${agent.id}. Add ${from.id} to allowFrom in ${agent.id}'s ${channel} channel.`);
      const Channel = channel.charAt(0).toUpperCase() + channel.slice(1);
      return message.private ? said(`Your ${Channel} user id is ${from.id}. Add it to allowFrom in ${agent.id}'s ${channel} channel.`) : undefined;
    }
    if (!rules.allowFrom.map(String).includes(from.id)) {
      // In a group the agent sees everybody's messages, and most are not for it.
      if (message.private) console.warn(`${channel}: ${agent.id} is ignoring ${from.id} (${from.name}), not in allowFrom`);
      return undefined;
    }
  }

  if (clearCommand(text)) {
    if (message.thread) forget(message.thread);
    return said("Conversation cleared.");
  }

  const picking = rules.strangers || rules.job ? undefined : modelCommand(text);
  if (picking) return { ...bound(agent, message, picking), steps: 0, cost: 0 };

  const signingIn = text && !rules.strangers && !rules.job ? neededBy(agent).find((one) => one.signIn?.answers(text)) : undefined;
  if (signingIn) return during(working, () => signedIn(agent, message, signingIn, rules, whileWorking));

  const waiting = text ? waitingOn(`${channel}:${message.chat}`, agent.id) : undefined;
  if (waiting) return during(working, () => answered(agent, message, waiting.id, waiting.job));

  if (!isForAgent(message, rules)) return undefined;

  if (rules.job) return during(working, () => handedTo(agent, message, rules.job!));

  const job = text && !rules.strangers ? jobFor(agent, text) : undefined;
  if (job && clock()) {
    return during(working, async () => {
      const done = await started(agent, message, job.job, job.text);
      if (done.runId) kept(message, done.text);
      return done;
    });
  }

  return during(working, () => chatted(agent, message, rules, whileWorking));
}

/**
 * Whether a message is the agent's business at all: a one-to-one chat always
 * is, and in a group it is a mention, a reply to the agent, a command, or any
 * message at all where the agent answers the whole group.
 *
 * Exported because a channel that holds messages back for a moment to join them
 * up has to ask this before joining, not after. Joining an unaddressed group
 * message onto an addressed one would hand the agent something it was never
 * given, which is a wider boundary arrived at by accident.
 */
export function isForAgent(message: Incoming, rules: Rules = {}): boolean {
  return message.private || !!message.addressed || rules.inGroups === "always" || message.text.startsWith("/");
}

/** `/clear`, with an optional channel mention, starts this chat or topic fresh. */
function clearCommand(text: string): boolean {
  return /^\/clear(?:@\w+)?\s*$/i.test(text);
}

/**
 * Returns the commands a channel can show in its own menu, like the menu
 * Telegram shows when you type "/". There is one for each job a person may
 * start, then `/models` and `/clear`.
 *
 * A job's id is written with "_" for "-", because some platforms do not
 * allow "-" in a command. A job whose id does not fit a command (up to 32
 * lowercase letters, digits and "_") is left out, and so is a job that
 * belongs to a channel.
 */
export function commands(agent: Agent): { command: string; description: string }[] {
  return [
    ...agent.jobs
      .filter((job) => !job.channels)
      .map((job) => ({ command: job.id.replace(/-/g, "_").toLowerCase(), description: (job.description || job.id).slice(0, 256) }))
      .filter((one) => /^[a-z0-9_]{1,32}$/.test(one.command)),
    { command: "models", description: "Which model answers here, and the ones to pick from" },
    { command: "clear", description: "Start this conversation fresh" },
  ];
}

/**
 * `/models` lists the models and what is chosen. `/model <name>` picks one
 * for this chat, `/model <name> via <route>` the same on another route, `/model <name> for everything` for the whole agent, and
 * `/model <name> for <job>` for one job. `/model default` takes a pick back,
 * with the same `for`. `/model` alone lists too.
 */
function modelCommand(text: string): { pick?: string; target?: string } | undefined {
  const asked = text.trim().match(/^\/models?(?:@\w+)?(?:\s+(.*))?$/i);
  if (!asked) return undefined;
  const words = asked[1]?.trim();
  if (!words) return {};
  const split = words.match(/^(\S+(?:\s+via\s+\S+)?)(?:\s+for\s+(.+))?$/i);
  if (!split) return { pick: words };
  return { pick: split[1], target: split[2]?.trim() };
}

/** How many models a chat lists. More than this is a wall of text and too many buttons. */
const SHOWN = 20;

/** What a model command comes back with: the list, or the pick made. */
function bound(agent: Agent, message: Incoming, asked: { pick?: string; target?: string }): { text: string; buttons?: Button[] } {
  const offered = models(agent);
  const thread = message.thread;
  const here = thread ? chosen(agent.id, `chat:${thread}`) : undefined;

  if (!asked.pick) {
    const made = choices(agent.id).filter((one) => !one.scope.startsWith("chat:"));
    // With no shortlist the offer is every model each route carries, which runs
    // to hundreds. A chat cannot show that, so it shows the first few and says
    // where to shorten it. Any of them can still be named in full.
    const some = offered.slice(0, SHOWN);
    const lines = [
      `This chat: ${here ?? modelFor(agent)}${here ? "" : " (the default)"}`,
      ...made.map((one) => `${one.scope === "agent" ? "Everything" : one.scope.slice(4)}: ${one.model}`),
      "",
      offered.length ? "I can run:" : "There is nothing to pick from: nothing this box is set up for runs the models on offer.",
      ...some.map((one) => `• ${one.model}`),
      ...(offered.length > some.length
        ? [`...and ${offered.length - some.length} more. Name any of them, or set model.models in chloe.config.ts to choose what shows here.`]
        : []),
      "",
      "Pick one for this chat, or write /model <name>, /model <name> for everything, /model <name> for <job>, or /model default.",
    ];
    return { text: lines.join("\n"), buttons: some.map((one) => ({ label: one.model, sends: `/model ${one.model}` })) };
  }

  let scope: Scope;
  let where: string;
  if (!asked.target) {
    if (!thread) return { text: "This call has no conversation to remember a pick for. Say for everything, or for a job." };
    scope = `chat:${thread}`;
    where = "This chat";
  } else if (/^everything$/i.test(asked.target)) {
    scope = "agent";
    where = `Everything ${agent.label ?? agent.id} does`;
  } else {
    const id = asked.target.toLowerCase();
    const job = agent.jobs.find((one) => one.id === id || one.id === id.replace(/_/g, "-"));
    if (!job) return { text: `I have no job called ${asked.target}. Mine: ${agent.jobs.map((one) => one.id).join(", ") || "none"}.` };
    scope = `job:${job.id}`;
    where = job.id;
  }

  if (/^default$/i.test(asked.pick)) {
    choose(agent.id, scope, "");
    const now = scope === "agent" ? modelFor(agent) : scope.startsWith("job:") ? modelFor(agent, agent.jobs.find((one) => one.id === scope.slice(4))) : modelFor(agent);
    return { text: `${where} is back on the default, ${now}.` };
  }
  const model = offered.find((one) => one.model.toLowerCase() === asked.pick!.toLowerCase());
  if (!model) return { text: `I cannot run ${asked.pick}. /models lists what I can.` };
  choose(agent.id, scope, model.model);
  const aside = scope === "agent" ? ", apart from a job that names its own" : "";
  return { text: `${where} now uses ${model.model}${aside}.` };
}

/**
 * Cuts a long reply into pieces of at most `max` characters, for a platform
 * that limits how long a message can be.
 *
 * It cuts at the last line break that fits, so lines stay whole. When there
 * is no line break in the second half of a piece, it cuts at exactly `max`
 * characters, which can split a line.
 */
export function inPieces(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  return [...pieces, rest];
}

async function during(working: () => () => void, work: () => Promise<Handled>): Promise<Handled> {
  const stop = working();
  try {
    return await work();
  } finally {
    stop();
  }
}

/**
 * The job a command names, and the text after it. Undefined when the text is
 * not a command, or names no job of this agent's: a message that starts with a
 * slash then goes on to the model like any other.
 */
function jobFor(agent: Agent, text: string): { job: Job; text: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const [word] = text.trim().split(/\s+/);
  const asked = word.slice(1).split("@")[0].toLowerCase();
  // A channel's job is started by a message on that channel, never by a command.
  const job = agent.jobs.find((one) => !one.channels && (one.id === asked || one.id === asked.replace(/_/g, "-")));
  return job && { job, text: text.trim().slice(word.length).trim() };
}

/** What a job said, as a reply: its own reply, its summary line, or what it returned. */
function replyOf(result: Fired, job: Job): string {
  if ("parked" in result && result.parked) return "";
  return result.reply || result.summary || result.text || `${job.id}: done.`;
}

/** A job's exchange, kept in the chat's conversation the way a turn keeps its own. */
function kept(message: Incoming, reply: string): void {
  if (!message.thread) return;
  remember(message.thread, "user", message.text);
  remember(message.thread, "assistant", reply);
}

/** The fields of a job's `args`, in the order they are written, or none when its shape is not an object. */
function fields(job: Job): string[] {
  return job.args instanceof z.ZodObject ? Object.keys(job.args.shape) : [];
}

/**
 * The words after a command, as the job's `args`: a word to each field in
 * order, and the rest of the line to the last field, so `/check-weather New
 * York` is one location. Every value is a string, so a field that wants a
 * number says `z.coerce.number()`.
 */
export function argsFrom(job: Job, text: string): Record<string, string> {
  const keys = fields(job);
  const args: Record<string, string> = {};
  let rest = text.trim();
  keys.forEach((key, i) => {
    if (!rest) return;
    const word = i === keys.length - 1 ? rest : rest.split(/\s+/, 1)[0];
    args[key] = word;
    rest = rest.slice(word.length).trim();
  });
  return args;
}

/** How to write the command for a job: `/check-weather <location>`. */
function usage(job: Job): string {
  return `Write it as /${job.id}${fields(job).map((key) => ` <${key}>`).join("")}.`;
}

/**
 * A message that is for a job: start that job and hand back what to say.
 *
 * The message becomes the job's message (and its input, for a job that
 * declares an `input` shape), the clock runs it, and the reply is
 * the job's own words. Three things can come back and each is said plainly: the
 * job ran, the job was already running, or the job failed.
 *
 * It goes through the clock rather than calling the job itself, because the
 * clock is the one place that knows what is running and will not start a second
 * run of the same job.
 */
async function started(agent: Agent, message: Incoming, job: Job, text: string): Promise<Handled> {
  const input = {
    ...argsFrom(job, text),
    text,
    ...envelope(message),
  };
  try {
    const result = await clock()!.fire(agent, job, input, message.channel);
    if (!ran(result)) {
      const text = result.skipped
        ? `${job.id} is already running. I will not start a second one.`
        : `${job.id} failed. ${result.failed ?? "It is in the logs on the box."}`;
      return { text, steps: 0, cost: 0, job: job.id };
    }
    const reply = replyOf(result, job);
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, ...(result.unpriced ? { unpriced: result.unpriced } : {}), job: job.id };
  } catch (error) {
    // What was sent did not fit the job, which is worth saying where it was
    // sent: it is the message that has to change.
    const why = error instanceof WrongArgs ? `${error.message}\n${usage(job)}` : "It is in the logs on the box.";
    if (!(error instanceof WrongArgs)) console.error(`${agent.id}/${job.id}: failed`, error);
    return { text: `I could not run ${job.id}. ${why}`, steps: 0, cost: 0, job: job.id };
  }
}

/** A message as a job's `work.input` has it. */
function envelope(message: Incoming): Record<string, string> {
  return {
    from: message.channel,
    chat: message.chat,
    chatTitle: message.chatTitle ?? "",
    user: message.from.name,
    userId: message.from.id,
    thread: message.thread,
    replyTo: message.replyTo ?? "",
  };
}

/**
 * A message on a channel with a `job`: start that job with it, once per
 * conversation, and send back what it returns. What went wrong is the run's
 * and the log's, never the person's: on some channels they are a stranger.
 */
async function handedTo(agent: Agent, message: Incoming, id: string): Promise<Handled> {
  const job = agent.jobs.find((one) => one.id === id);
  const wrong = { text: "Something went wrong on my end. It is in the logs on the box.", steps: 0, cost: 0, job: id };
  if (!job || !clock()) {
    console.error(`${message.channel}: ${agent.id}'s job ${id} could not start: ${job ? "nothing runs jobs in this process" : "the agent has no such job"}.`);
    return wrong;
  }
  try {
    const conversation = message.thread || `${message.channel}:${message.chat}`;
    const result = await clock()!.fire(agent, job, { text: message.text, ...envelope(message) }, message.channel, conversation);
    if (!ran(result)) {
      if (result.skipped) return { ...wrong, text: "I am still answering your last message. Send this one again once I have." };
      return wrong;
    }
    const reply = replyOf(result, job);
    if (result.runId) kept(message, reply);
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, ...(result.unpriced ? { unpriced: result.unpriced } : {}), job: job.id };
  } catch (error) {
    console.error(`${agent.id}/${job.id}: failed`, error);
    return wrong;
  }
}

async function answered(agent: Agent, message: Incoming, runId: string, job: string): Promise<Handled> {
  try {
    const result = await answer(runId, message.text, new Map([[agent.id, agent]]));
    // Still parked means the answer did not fit, and the job has already asked again.
    const reply = result.parked ? "" : result.reply || result.summary || result.text || "Done.";
    kept(message, reply);
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, ...(result.unpriced ? { unpriced: result.unpriced } : {}), job };
  } catch (error) {
    console.error(`${message.channel}: answering a waiting job failed`, error);
    return { text: "I could not carry that job on. It is in the logs on the box.", steps: 0, cost: 0 };
  }
}

/**
 * The answer to a sign-in, finished by its connection. The code is kept out of
 * the conversation, and in one the request it interrupted is asked again, so
 * the person gets what they asked for rather than a note saying they may ask.
 */
async function signedIn(agent: Agent, message: Incoming, connection: Connection, rules: Rules, whileWorking: While): Promise<Handled> {
  let done: string;
  try {
    done = await connection.signIn!.finish(message.text);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), steps: 0, cost: 0 };
  }
  if (!message.thread) return { text: done, steps: 0, cost: 0 };
  remember(message.thread, "user", `(the ${connection.name} sign-in code)`);
  remember(message.thread, "assistant", done);
  const after = await chatted(agent, { ...message, text: `I have signed in to ${connection.name}. Carry on with what I asked before.` }, rules, whileWorking);
  return { ...after, text: `${done}\n\n${after.text}` };
}

async function chatted(agent: Agent, message: Incoming, rules: Rules, whileWorking: While = {}): Promise<Handled> {
  const { send, calling, writing } = whileWorking;
  // One after another, in the order they happened, and all of them out before
  // the answer is.
  let sending: Promise<unknown> = Promise.resolve();
  const inOrder = (what: () => unknown) => {
    sending = sending.then(what).catch((error) => console.error(`${message.channel}: sending on the way failed`, error));
  };
  const said =
    rules.sendWhileWorking && send
      ? (text: string) => {
          inOrder(() => send(text));
          // Sent, so kept: the next turn should know it was said.
          if (message.thread) remember(message.thread, "assistant", text);
        }
      : undefined;
  try {
    const files = (await message.files?.()) ?? {};
    const facts = message.context && { from: message.from.name, ...message.context };
    const context = facts && [`<${message.channel}_context>`, ...Object.entries(facts).map(([k, v]) => `${k}: ${v}`), `</${message.channel}_context>`].join("\n");
    const result = await turn({
      agent,
      prompt: [context, message.text, files.text, ...(files.notes ?? [])].filter(Boolean).join("\n\n"),
      asked: message.text || undefined,
      attachments: files.attachments?.length ? files.attachments : undefined,
      thread: message.thread || undefined,
      history: rules.chatHistory,
      said,
      calling: calling && ((tool) => inOrder(() => calling(tool))),
      writing: writing && ((delta) => inOrder(() => writing(delta))),
      talkingTo: message.from.name,
      model: message.model ?? (message.thread ? chosen(agent.id, `chat:${message.thread}`) : undefined),
      source: message.channel,
      owner: `${message.channel}:${message.from.id}`,
      without: [...(message.withoutTools ?? []), ...leftOut(agent, rules)],
      stranger: rules.strangers,
      ...ownerOf(message, rules),
      user: `${message.channel}:${message.from.id}`,
      signal: message.signal,
    });
    await sending;
    return { text: result.text || "(no reply)", runId: result.runId, steps: result.steps, cost: result.cost, ...(result.unpriced ? { unpriced: result.unpriced } : {}) };
  } catch (error) {
    console.error(`${message.channel}: turn failed`, error);
    if (error instanceof UsageLimit) return { text: error.message, steps: 0, cost: 0 };
    return { text: "Something went wrong on my end. It is in the logs on the box.", steps: 0, cost: 0 };
  }
}

/**
 * Whether this message is the agent's owner's, and whether it may change the
 * agent: never on a channel for strangers, else what the caller said, else
 * whether it came from the agent's owner on this channel.
 */
function ownerOf(message: Incoming, rules: Rules): { fromOwner: boolean; mayChangeAgent: boolean } {
  const fromOwner =
    !rules.strangers &&
    (message.fromOwner ??
      (settings.owner === `${message.channel}:${message.from.id}` ||
        (rules.allowFrom?.length ? String(rules.allowFrom[0]) === message.from.id : false)));
  return { fromOwner, mayChangeAgent: fromOwner && (message.mayChangeAgent ?? true) };
}

/**
 * The tools a turn goes without because its channel names the ones it may
 * have: everything not named, less the memory tools and `skillRead`, which
 * come with the agent. A stranger gets only what is named, and their own note
 * when the agent keeps one per person.
 */
function leftOut(agent: Agent, rules: Rules): string[] {
  const named = rules.tools;
  if (!named) return [];
  const keeps = (name: string) =>
    named.includes(name) || (rules.strangers ? name === "memoryWriteUserNotes" : /^memory[A-Z]/.test(name) || name === "skillRead");
  return [...Object.keys(agent.tools ?? {}), "skillRead"].filter((name) => !keeps(name));
}
