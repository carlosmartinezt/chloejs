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
// What a job said in a chat is kept in that chat's conversation, so the next
// turn knows it happened.
import { z } from "zod";

import type { Agent, ChatHistory, Job } from "#chloe/load/load";
import type { Attachment } from "#chloe/model/model";
import { choices, choose, chosen, modelFor, type Scope } from "#chloe/model/choices";
import { forget, remember } from "#chloe/model/memory";
import { models, UsageLimit } from "#chloe/model/model";
import { clock, type Fired, ran } from "#chloe/core/clock";
import { answer, waitingOn, WrongArgs } from "#chloe/core/steps";
import { turn } from "#chloe/core/turn";
import type { Connection } from "#chloe/connections/connection";
import { connectionsUsed } from "#chloe/model/tool";

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
}

/** What a channel can do while a message is being dealt with. */
export interface While {
  /** Called once there is work to do, for "typing..."; what it returns is called when the work is over. */
  working?: () => () => void;
  /** Sends one message to the chat. What sendWhileWorking uses. */
  send?: (text: string) => Promise<void>;
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

  const picking = modelCommand(text);
  if (picking) return { ...picked(agent, message, picking), steps: 0, cost: 0 };

  const signingIn = text ? connectionsUsed(agent.tools ?? {}).find((one) => one.signIn?.answers(text)) : undefined;
  if (signingIn) return during(working, () => signedIn(agent, message, signingIn, rules, whileWorking.send));

  const waiting = text ? waitingOn(`${channel}:${message.chat}`, agent.id) : undefined;
  if (waiting) return during(working, () => answered(agent, message, waiting.id, waiting.job));

  if (!isForAgent(message, rules)) return undefined;

  const job = text ? jobFor(agent, text) : undefined;
  if (job && clock()) {
    return during(working, async () => {
      const done = await started(agent, message, job.job, job.text);
      if (done.runId) kept(message, done.text);
      return done;
    });
  }

  return during(working, () => chatted(agent, message, rules, whileWorking.send));
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

/** The commands a channel can offer in its own menu: each job, with "_" for "-", then /models and /clear. */
export function commands(agent: Agent): { command: string; description: string }[] {
  return [
    ...agent.jobs
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
function picked(agent: Agent, message: Incoming, asked: { pick?: string; target?: string }): { text: string; buttons?: Button[] } {
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
  const job = agent.jobs.find((one) => one.id === asked || one.id === asked.replace(/_/g, "-"));
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
    from: message.channel,
    chat: message.chat,
    chatTitle: message.chatTitle ?? "",
    user: message.from.name,
    thread: message.thread,
    replyTo: message.replyTo ?? "",
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
async function signedIn(agent: Agent, message: Incoming, connection: Connection, rules: Rules, send?: (text: string) => Promise<void>): Promise<Handled> {
  let done: string;
  try {
    done = await connection.signIn!.finish(message.text);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), steps: 0, cost: 0 };
  }
  if (!message.thread) return { text: done, steps: 0, cost: 0 };
  remember(message.thread, "user", `(the ${connection.name} sign-in code)`);
  remember(message.thread, "assistant", done);
  const after = await chatted(agent, { ...message, text: `I have signed in to ${connection.name}. Carry on with what I asked before.` }, rules, send);
  return { ...after, text: `${done}\n\n${after.text}` };
}

async function chatted(agent: Agent, message: Incoming, rules: Rules, send?: (text: string) => Promise<void>): Promise<Handled> {
  // One after another, and all of them out before the answer is.
  let sending = Promise.resolve();
  const said =
    rules.sendWhileWorking && send
      ? (text: string) => {
          sending = sending.then(() => send(text)).catch((error) => console.error(`${message.channel}: sending on the way failed`, error));
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
      talkingTo: message.from.name,
      model: message.model ?? (message.thread ? chosen(agent.id, `chat:${message.thread}`) : undefined),
      source: message.channel,
      owner: `${message.channel}:${message.from.id}`,
      without: message.withoutTools,
    });
    await sending;
    return { text: result.text || "(no reply)", runId: result.runId, steps: result.steps, cost: result.cost };
  } catch (error) {
    console.error(`${message.channel}: turn failed`, error);
    if (error instanceof UsageLimit) return { text: error.message, steps: 0, cost: 0 };
    return { text: "Something went wrong on my end. It is in the logs on the box.", steps: 0, cost: 0 };
  }
}
