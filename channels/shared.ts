// What every channel shares: what happens to a message, whichever channel it
// came in on. A channel turns its platform's message into an `Incoming`, calls
// receive(), and sends back the text it returns. Everything else is decided
// here, once, so Telegram, the API and any channel written later behave the
// same way. A channel written in an agent's own folder imports it too:
//
//   import { receive, type Incoming } from "chloejs/channels/shared";
//
// In order, and the first that applies decides:
//
//   1. Somebody not in allowFrom gets nothing. While allowFrom is empty, a
//      private message is told the sender's id, which is what goes in it.
//   2. An answer to a job waiting on this chat goes to that job.
//   3. In a group, a message that is not for the agent is left alone, unless
//      the channel's inGroups is "always".
//   4. "/<job id> ..." runs that job. "_" stands for "-", because some
//      platforms allow no hyphens in a command.
//   5. A message one of the agent's jobs `answers` runs that job.
//   6. Anything else is a turn, shown the chat's recent conversation.
//
// Rules 4 and 5 are code, never a model: which job gets a message is a rule
// somebody can write down. What a job said in a chat is kept in that chat's
// conversation, so the next turn knows it happened.
import type { Agent, ChatHistory, Job } from "#chloe/load/load.ts";
import type { Attachment } from "#chloe/model/model.ts";
import { remember } from "#chloe/model/memory.ts";
import { clock, type Fired } from "#chloe/core/clock.ts";
import { answer, waitingOn, WrongInput } from "#chloe/core/steps.ts";
import { turn } from "#chloe/core/turn.ts";

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
      console.log(`${channel}: ${from.id} wrote to ${agent.name}. Add ${from.id} to allowFrom in ${agent.name}'s ${channel} channel.`);
      const Channel = channel.charAt(0).toUpperCase() + channel.slice(1);
      return message.private ? said(`Your ${Channel} user id is ${from.id}. Add it to allowFrom in ${agent.name}'s ${channel} channel.`) : undefined;
    }
    if (!rules.allowFrom.map(String).includes(from.id)) {
      // In a group the agent sees everybody's messages, and most are not for it.
      if (message.private) console.warn(`${channel}: ${agent.name} is ignoring ${from.id} (${from.name}), not in allowFrom`);
      return undefined;
    }
  }

  const waiting = text ? waitingOn(`${channel}:${message.chat}`, agent.name) : undefined;
  if (waiting) return during(working, () => answered(agent, message, waiting.id, waiting.job));

  const forAgent = message.private || message.addressed || rules.inGroups === "always" || text.startsWith("/");
  if (!forAgent) return undefined;

  const job = text ? jobFor(agent, text) : undefined;
  if (job && clock()) return during(working, () => started(agent, message, job.job, job.text));

  return during(working, () => chatted(agent, message, rules, whileWorking.send));
}

/** The commands a channel can offer in its own menu: each job, with "_" for "-". */
export function commands(agent: Agent): { command: string; description: string }[] {
  return agent.jobs
    .map((job) => ({ command: job.id.replace(/-/g, "_").toLowerCase(), description: (job.description || job.id).slice(0, 256) }))
    .filter((one) => /^[a-z0-9_]{1,32}$/.test(one.command));
}

async function during(working: () => () => void, work: () => Promise<Handled>): Promise<Handled> {
  const stop = working();
  try {
    return await work();
  } finally {
    stop();
  }
}

/** The job a message is for, by command or by a job that answers it, and the text it is started with. */
function jobFor(agent: Agent, text: string): { job: Job; text: string } | undefined {
  if (text.startsWith("/")) {
    const [word, ...rest] = text.trim().split(/\s+/);
    const asked = word.slice(1).split("@")[0].toLowerCase();
    const job = agent.jobs.find((one) => one.id === asked || one.id === asked.replace(/_/g, "-"));
    // Not one of this agent's jobs, so it is a message that starts with a
    // slash, and goes on to be asked of the model like any other.
    if (job) return { job, text: text.slice(word.length).trim() || rest.join(" ") };
  }
  const job = agent.jobs.find((one) => {
    try {
      return one.answers?.(text) === true;
    } catch (error) {
      console.error(`${agent.name}/${one.id}: its answers check failed:`, (error as Error).message);
      return false;
    }
  });
  return job && { job, text };
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

async function started(agent: Agent, message: Incoming, job: Job, text: string): Promise<Handled> {
  const input = {
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
    if (!result) return { text: `${job.id} is already running. I will not start a second one.`, steps: 0, cost: 0, job: job.id };
    const reply = replyOf(result, job);
    kept(message, reply);
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, job: job.id };
  } catch (error) {
    // What was sent did not fit the job, which is worth saying where it was
    // sent: it is the message that has to change.
    const why = error instanceof WrongInput ? error.message : "It is in the logs on the box.";
    if (!(error instanceof WrongInput)) console.error(`${agent.name}/${job.id}: failed`, error);
    return { text: `I could not run ${job.id}. ${why}`, steps: 0, cost: 0, job: job.id };
  }
}

async function answered(agent: Agent, message: Incoming, runId: string, job: string): Promise<Handled> {
  try {
    const result = await answer(runId, message.text, new Map([[agent.name, agent]]));
    // Still parked means the answer did not fit, and the job has already asked again.
    const reply = result.parked ? "" : result.reply || result.summary || result.text || "Done.";
    kept(message, reply);
    return { text: reply, runId: result.runId, steps: result.steps, cost: result.cost, job };
  } catch (error) {
    console.error(`${message.channel}: answering a waiting job failed`, error);
    return { text: "I could not carry that job on. It is in the logs on the box.", steps: 0, cost: 0 };
  }
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
      attachments: files.attachments?.length ? files.attachments : undefined,
      thread: message.thread || undefined,
      history: rules.chatHistory,
      said,
      model: message.model,
      source: message.channel,
      owner: `${message.channel}:${message.from.id}`,
    });
    await sending;
    return { text: result.text || "(no reply)", runId: result.runId, steps: result.steps, cost: result.cost };
  } catch (error) {
    console.error(`${message.channel}: turn failed`, error);
    return { text: "Something went wrong on my end. It is in the logs on the box.", steps: 0, cost: 0 };
  }
}
