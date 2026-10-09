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
import { answer, waitingOn, WrongArgs } from "#chloe/core/steps";
import { turn } from "#chloe/core/turn";
import type { Connection } from "#chloe/connections/connection";
import { connectionsUsed, type ChloeTool } from "#chloe/model/tool";

/** One message, in the words every channel shares. */
export interface Incoming {
  /** The channel's name, like "telegram". What the log shows, and the first half of an address. */
  channel: string;
  /** Where it was said, as the channel names it. `${channel}:${chat}` is how a job asks back here. */
  chat: string;
  /** The conversation it belongs to: one per chat, or per topic in a forum. Empty for none, so nothing is remembered. */
  thread: string;
  from: { id: string; name: string };
  text: string;
  /** A one-to-one chat, rather than a group. */
  private: boolean;
  /** In a group: it mentions the agent or replies to it. */
  addressed?: boolean;
  chatTitle?: string;
  /** The message this one replies to, when it is one. */
  replyTo?: string;
  /**
   * Facts about where it was said, handed to the model ahead of the message
   * with who sent it: "chat_type", "chat_title". Without them the model is
   * handed the message alone, which is right for a caller that is a program.
   */
  context?: Record<string, string>;
  /** The files on it, fetched only when a turn is going to read them. */
  files?: () => Promise<{ attachments?: Attachment[]; text?: string; notes?: string[] }>;
  /** A model for this one turn, when the channel lets its caller pick. */
  model?: string;
  /** Tools the turn is not given, by name, though the agent has them. */
  withoutTools?: string[];
  /** Stops the turn: whoever asked has gone. */
  signal?: AbortSignal;
}

/** Who a channel answers. Each channel takes these as options and hands them over. */
export interface Rules {
  /** Ids that may reach the agent. Unset, anybody who got this far may, which is right only behind a login. */
  allowFrom?: (string | number)[];
  /** In a group, "when-addressed" (the default) answers a command, a mention or a reply. "always" answers everything. */
  inGroups?: "when-addressed" | "always";
  /** How much of a conversation on this channel a turn is shown. */
  chatHistory?: ChatHistory;
  /**
   * Send what the model writes on its way to an answer (a "let me check" line,
   * or a draft it goes on to improve) as it writes it, rather than only the
   * answer it ends on. Off unless true. Needs a channel that can send more
   * than one reply, so it does nothing on the API.
   */
  sendWhileWorking?: boolean;
  /**
   * Whoever writes is a stranger, like a visitor on a web page. Their message
   * is a turn, /clear or the answer to a job that asked them, and nothing
   * else: never a /command, a model pick or the answer to a sign-in, and a
   * sign-in a tool needs is never started for them.
   */
  strangers?: boolean;
  /** The names of the only tools a turn has, from the channel's `tools` read by `bind`. Every tool when unset. */
  tools?: string[];
  /** The id of the job every message starts, from the channel's `job`, filled in by `bind`. */
  job?: string;
}

/**
 * The two options every channel takes, both optional, for what its messages
 * get when it is not a turn with every tool the agent has.
 */
export interface Answering {
  /**
   * The only tools a turn on this channel has, each the tool itself or its
   * name in the agent's `tools`: `tools: [tools.readPage]`. The agent's memory
   * and skills come too, and its self tools only when named. Every tool when
   * unsaid.
   */
  tools?: (ChloeTool | string)[];
  /**
   * A job every message starts, in place of a turn: code that can look up who
   * wrote before anybody answers. It reads the message from `work.input`, and
   * what it returns is the reply. Named here and not in the agent's `jobs`:
   * the agent loads it from here, and only a message on this channel starts
   * it. Code with `run`, and no cron line. One conversation runs it once at a
   * time; two conversations run it side by side.
   */
  job?: JobConfig<any, any, any, any>;
}

/** A channel's `tools` and `job` once read against its agent: the part of its rules they come to. */
export type Bound = Pick<Rules, "tools" | "job">;

/**
 * What every channel takes, whatever its platform. A channel's own options
 * extend this, and `defineChannel` and `rulesOf` read it, so an option every
 * channel should have is added here and in those two, and no channel changes.
 */
export interface Shared extends Answering {
  /** The kind of channel unless the agent has two of one kind. What the log shows a run came in on, and the start of every address on it. */
  name?: string;
  /** Who may reach the agent, as the platform names them. */
  allowFrom?: (string | number)[];
  /** How much of a conversation a turn is shown: `{ messages, days }`. */
  chatHistory?: ChatHistory;
  /** Off unless true. Sends what the model writes on its way to an answer as it writes it. */
  sendWhileWorking?: boolean;
}

/** What a channel's own code is handed as it starts. */
export interface Starting {
  /** The agent, read again for every message, so an edit is live. */
  agent: () => Agent | undefined;
  agentId: string;
  /** The channel's name: its `name` option, or its kind. */
  name: string;
  /** Its `tools` and `job`, read against the agent as it loaded. Hand them to `rulesOf`. */
  bound: Bound;
}

/**
 * Makes a channel. `kind` is the platform it is for, like "telegram", and is
 * also its name unless `options.name` gives another (an agent with two bots
 * names one of them). `start` is what it does to start. This does everything
 * but the platform. It checks `tools` and `job`
 * against the agent as it loads, loads the job, and writes the options out for
 * the page, leaving out any named in `hidden`. `start` only reads the platform
 * and sends to it, handing each message to `receive()` with `rulesOf` its
 * options.
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
 * The rules a channel hands `receive()`, from its options and what was bound.
 * `allowFrom` is the channel's own, written the way its platform writes ids,
 * when it reads them differently.
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

/** What a channel can do while a message is being dealt with. */
export interface While {
  /** Called once there is work to do, for "typing..."; what it returns is called when the work is over. */
  working?: () => () => void;
  /** Sends one message to the chat. What sendWhileWorking uses. */
  send?: (text: string) => Promise<void>;
  /** Called as each tool starts, with its name and its title when it has one. */
  calling?: (tool: { name: string; title?: string }) => void;
  /**
   * Handed the answer's words as they are written, on a model route that
   * streams them. Words written before a tool call come this way too, and are
   * then handed to `send` whole.
   */
  writing?: (delta: string) => void;
}

/** What came of a message. Nothing at all means it was not for the agent. */
export interface Handled {
  /** What to send back. Empty when there is nothing to send, because a question already went out. */
  text: string;
  runId?: string;
  steps: number;
  cost: number;
  /** The job that took it, when one did. */
  job?: string;
  /** Choices to show under the text, on a channel that can. Pressing one sends `sends` as if the person had written it. */
  buttons?: Button[];
}

/** One button under a reply. */
export interface Button {
  label: string;
  sends: string;
}

/**
 * Decides what a message is, does it, and says what to send back. See While
 * for what a channel can hand over to be used on the way.
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

  const signingIn = text && !rules.strangers && !rules.job ? connectionsUsed(agent.tools ?? {}).find((one) => one.signIn?.answers(text)) : undefined;
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

/** The commands a channel can offer in its own menu: each job a person may start, with "_" for "-", then /models and /clear. */
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
 * for this chat, `/model <name> for everything` for the whole agent, and
 * `/model <name> for <job>` for one job. `/model default` takes a pick back,
 * with the same `for`. `/model` alone lists too.
 */
function modelCommand(text: string): { pick?: string; target?: string } | undefined {
  const asked = text.trim().match(/^\/models?(?:@\w+)?(?:\s+(.*))?$/i);
  if (!asked) return undefined;
  const words = asked[1]?.trim();
  if (!words) return {};
  const split = words.match(/^(\S+)(?:\s+for\s+(.+))?$/i);
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
 * A long reply cut into pieces a channel will take, at a line break where
 * there is one, so a tag or a line is never cut in half.
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
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, job: job.id };
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
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, job: job.id };
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
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, job };
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
      user: `${message.channel}:${message.from.id}`,
      signal: message.signal,
    });
    await sending;
    return { text: result.text || "(no reply)", runId: result.runId, steps: result.steps, cost: result.cost };
  } catch (error) {
    console.error(`${message.channel}: turn failed`, error);
    if (error instanceof UsageLimit) return { text: error.message, steps: 0, cost: 0 };
    return { text: "Something went wrong on my end. It is in the logs on the box.", steps: 0, cost: 0 };
  }
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
