// An agent is declared, not found. Each one is a defineAgent(...) with a name,
// and chloe.config.ts at the top of the repo lists them. Every job, tool and
// channel is named in the definition. skills/ is the one folder read by
// looking, because a skill is loaded only when the model asks for it.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getCallSites } from "node:util";

import type { StopCondition, ToolApprovalConfiguration } from "ai";
import type { z } from "zod";

import { MEMORIES, ROOT, setAgentDirs } from "#chloe/core/paths";
import { NO_CONFIG } from "#chloe/core/find";
import { declareSettings, settings as configured, type DeclaredSettings } from "#chloe/core/settings";
import { includedIn, isPrompt, readPrompt, settingsAndBody, type Prompt } from "#chloe/core/markdown";
import { parse } from "#chloe/timer/cron";
import type { JobConfig } from "./job.ts";
import { nameOf, type SdkModel } from "#chloe/model/key";
import { cannotRun, type Tools } from "#chloe/model/tool";
import type { Connection } from "#chloe/connections/connection";
import type { McpConnection } from "#chloe/connections/mcp";
import { memoryTools, userNotesTools } from "#chloe/model/tools/memory";
import { scriptTools } from "#chloe/model/tools/script";
import { selfWriteTools } from "#chloe/model/tools/self";
import { makeRepo } from "#chloe/services/historyService";
import { work, type Data, type Envelope, type Result as RunResult, type Work } from "#chloe/core/steps";
import { turn, type Result as TurnResult } from "#chloe/core/turn";

export const CONFIG = `${ROOT}/chloe.config.ts`;

// Node keeps a module once it is imported, so a job file that an agent
// imports would be read once at boot and every later edit would look saved
// and do nothing. Everything outside the runtime and node_modules is imported
// afresh on each load.
const RUNTIME = new URL("../", import.meta.url).href;
let generation = 0;
registerHooks({
  resolve(specifier, context, next) {
    const found = next(specifier, context);
    if (!found.url.startsWith("file:") || found.url.startsWith(RUNTIME) || found.url.includes("/node_modules/")) {
      return found;
    }
    return { ...found, url: `${found.url.split("?")[0]}?v=${generation}` };
  },
});

/** The agent, as far as a tool bound to it needs to know. */
export interface Home {
  id: string;
  folder: string;
  /** This agent's memory as its definition says it, with the folder worked out. See Memory. */
  memory: Memory & { folder: string };
}

/**
 * The options you give `defineAgent`. Only `id`, `description` and
 * `instructions` are required.
 */
export interface AgentConfig {
  /**
   * The agent's id, like `"inbox"`. Its run history and its default memory
   * folder are filed under it, and its channel tokens go under `agents.<id>`
   * in settings. Required.
   *
   * Do not change it after the agent has run: its old runs and memory stay
   * under the old id. To change the name people see, use `label`.
   */
  id: string;
  /**
   * The agent's name, like `"C.C."`. The dashboard shows it, the agent is
   * told it is its name at the top of every turn, and the email channel sends
   * mail under it. You can change it at any time. Default: the `id`.
   */
  label?: string;
  /**
   * The agent's folder, which holds its instructions, skills, jobs, scripts
   * and evals. Paths you give `prompt()` and `markdownJob()` start here.
   * Default: the folder of the file that calls `defineAgent`.
   *
   * If chloe cannot tell which file that is, it throws an error. Then set
   * `folder: import.meta.dirname`.
   */
  folder?: string;
  /**
   * The model the agent uses. You can give it in two ways:
   *
   * - A name, like `"anthropic/claude-sonnet-5"`. chloe reaches it the first
   *   way that works on this machine, in the order of `model.preferredRoute`
   *   in settings (a subscription through the `claude`, `codex` or `opencode`
   *   program, the provider's own API key, or an AI gateway).
   * - An AI SDK model, like `anthropic("claude-opus-5-5")`. It goes straight
   *   to that provider, set up the way you set up its package.
   *
   * Default: `model.defaultModel` in settings. If neither is set, the agent
   * does not load. A job can use another model with its own `model`.
   */
  model?: string | SdkModel;
  /** One line on what the agent does. The dashboard shows it wherever agents are listed. Required. */
  description: string;
  /**
   * The agent's memory: a folder it reads and writes between runs. You can
   * browse and edit it on the dashboard. See `Memory`.
   *
   * Default: a folder named after the agent's `id`, inside `data/memory/` in
   * your project. chloe makes that a git repository and saves what each run
   * changed as a commit. Set this only to use another folder, for example one
   * you share with a person.
   *
   * The memory tools read and write it (see `features.memory`). Each time the
   * dashboard reads a file from it, chloe first writes that down in the
   * agent's audit log.
   */
  memory?: Memory;
  /**
   * Turns on tools that chloe has built in: the memory tools,
   * `selfWriteFile`, `scriptRun` and `memoryWriteUserNotes`. See `Features`.
   */
  features?: Features;
  /**
   * The agent's instructions: what it is and how it works. The model reads
   * them before it answers a message or runs a markdown job. Required.
   *
   * Give `prompt("instructions.md")` to keep them in a file inside the
   * agent's folder, or a string with the words themselves. A plain string is
   * always used as the words, never as a file path.
   */
  instructions: string | Prompt;
  /**
   * The tools the model can call, keyed by the name the model sees:
   * `{ weather, gmailReadEmail: gmail.readEmail({ ... }) }`. Make your own
   * with the AI SDK's `tool()`. Default: none.
   *
   * Every tool gets the agent in its `context`. Read it with
   * `agentOf(context)`.
   *
   * Do not list the tools that `features` and `connections` add: chloe adds
   * them for you. A tool here with the same name replaces the added one. You
   * also add nothing for signing in: when a tool needs an outside account
   * (like Google for `gmail.readEmail`), chloe handles the sign-in.
   */
  tools?: Tools;
  /**
   * The agent's jobs. Each one is a job made with `defineJob` and imported
   * from its file, or `markdownJob("jobs/<id>.md")` for a job that is only a
   * prompt. A job that is not in this list never runs. Default: none.
   */
  jobs?: (JobConfig<any, any, any> | MarkdownJob)[];
  /**
   * The ways people and other systems reach the agent, like
   * `[telegramChannel({ ... }), apiChannel()]`. Two channels of one agent
   * cannot have the same `name`. Default: none. The owner can always talk to
   * the agent in the dashboard's chat.
   */
  channels?: Channel[];
  /**
   * The MCP servers this agent uses. (An MCP server is a service's list of
   * tools for models.) For example:
   * `[mcpConnection({ name: "github", url, token: process.env.GITHUB_TOKEN })]`.
   *
   * chloe asks each server for its tools when the agent loads, and adds them
   * to the agent's tools. Only this agent gets them. If a server does not
   * answer, the agent loads without its tools and the dashboard says why.
   * Default: none.
   */
  connections?: McpConnection[];
  /**
   * When the model must stop, as the AI SDK's `stopWhen`: `isStepCount(20)`,
   * or a list of conditions. It applies to each reply to a message and each
   * run of a markdown job. A step is one call to the model, and the tools it
   * asked for. Default: `isStepCount(40)`.
   *
   * When this stops the model, the reply is "Stopped after N steps without
   * finishing." Agent steps in code jobs have their own `stopWhen`.
   */
  stopWhen?: StopCondition<any> | StopCondition<any>[];
  /**
   * Decides, before each tool call, whether the call may run, as the AI SDK's
   * `toolApproval`. It applies to replies to messages and to markdown jobs.
   * When it gives no decision for a call, the tool's own `needsApproval`
   * decides. Default: every call runs, unless its tool's `needsApproval` says
   * otherwise.
   *
   * A refused call does not run, and the model is told why. A call that needs
   * a person to say yes (`"user-approval"`) is refused too, because a reply
   * cannot pause to ask. Agent steps in code jobs have their own
   * `toolApproval`, and they can pause to ask.
   */
  toolApproval?: ToolApprovalConfiguration<any, any>;
}

/**
 * What `defineAgent` returns: your `AgentConfig` with `folder` filled in, plus
 * `run` and `ask` to use the agent from a script. Add it to `agents` in
 * `chloe.config.ts`.
 */
export interface DefinedAgent extends AgentConfig {
  /** The agent's folder: the one you set, or the folder of the file that called `defineAgent`. */
  folder: string;
  /**
   * Runs one of this agent's code jobs in this process, and waits for it to
   * finish:
   *
   * ```ts
   * import chloe from "./agent.ts";
   * import checkWeather from "./jobs/check-weather.ts";
   * const { text } = await chloe.run({ job: checkWeather, input: { location: "London" } });
   * ```
   *
   * The run is saved in the run history like any other run. If the job pauses
   * to wait for an answer from a person, `run` returns at once with
   * `parked: true`.
   *
   * It loads every agent first, so use it in a script, not in a loop.
   *
   * Where the settings come from:
   *
   * - If there is a `chloe.config.ts` in the folder you run the script from,
   *   or in a folder above it, that file holds the settings, and it must list
   *   this agent.
   * - If there is none, the script is a project of its own with only this
   *   agent, and `settings` are its settings. `node morning.ts` runs it.
   */
  run<ArgsIn>(options: RunOptions<ArgsIn>): Promise<RunResult>;
  /**
   * Asks this agent one thing and waits for its answer, the same way as a
   * message on a channel: with its instructions, its tools and its memory.
   * The model keeps calling tools until it has an answer.
   *
   * ```ts
   * const { text } = await chloe.ask({ prompt: "What is on my plate this week?" });
   * ```
   *
   * The reply is saved in the run history like any other. The question does
   * not count as a message from the owner, so tools kept for the owner (like
   * `selfReadFile`) are not given.
   *
   * It loads every agent first, so use it in a script, not in a loop. The
   * settings come from the same place as for `run`.
   */
  ask(options: AskOptions): Promise<TurnResult>;
}

/** The options for `agent.ask`. */
export interface AskOptions {
  /** The question or message for the agent. Required. */
  prompt: string;
  /**
   * The id of a conversation to continue. Pick any string, and use the same
   * one each time. The model first sees the latest 10 messages of that
   * conversation, and the question and answer are added to it. Default:
   * none, so each `ask` starts fresh.
   */
  thread?: string;
  /** Where the question came from, as the run history shows it. Default: `"terminal"`. */
  source?: string;
  /** Cancels the model calls when it is aborted. */
  signal?: AbortSignal;
  /**
   * Settings for a script that has no `chloe.config.ts`, in the same shape as
   * `settings` in that file. If the project has a `chloe.config.ts`, leave
   * this out: giving it there throws an error.
   */
  settings?: DeclaredSettings;
}

/**
 * The options for `agent.run`.
 *
 * `input` is what the job starts with, as the API would send it. The message
 * keys (`text`, `from`, `chat`, `user`, `thread`, `replyTo` and the rest) go
 * to `work.input`. Everything else must fit the job's `args`, and becomes
 * `work.args`. Your editor checks it, and chloe checks it again before the
 * run starts. You can leave `input` out only when the job's `args` has no
 * required field.
 */
export type RunOptions<ArgsIn> = {
  /** The job to run: a code job (one with `run`) of this agent, imported from its file. Required. */
  job: JobConfig<any, any, any, ArgsIn>;
  /** Where the run came from, as the run history shows it. Default: `"terminal"`. */
  source?: string;
  /** Cancels the model calls when it is aborted. */
  signal?: AbortSignal;
  /**
   * Settings for a script that has no `chloe.config.ts`, in the same shape as
   * `settings` in that file. If the project has a `chloe.config.ts`, leave
   * this out: giving it there throws an error.
   */
  settings?: DeclaredSettings;
} & ({} extends ArgsIn ? { input?: ArgsIn & Partial<Envelope> } : { input: ArgsIn & Partial<Envelope> });

/**
 * Defines an agent. It is usually the default export of `agent.ts` in the
 * agent's folder. Add what it returns to `agents` in `chloe.config.ts`, or the
 * agent does not run.
 */
export function defineAgent(definition: AgentConfig): DefinedAgent {
  const defined: DefinedAgent = {
    ...definition,
    folder: definition.folder || callerFolder(definition.id),
    run: async (options) => {
      const agent = await loadFor(defined, options.settings);
      const job = agent.jobs.find((one) => one.id === options.job.id);
      if (!job) throw new Error(`${agent.id} has no job called ${JSON.stringify(options.job.id)}. It has: ${agent.jobs.map((one) => one.id).join(", ")}.`);
      return work({ agent, job, input: options.input, source: options.source ?? "terminal", signal: options.signal });
    },
    ask: async ({ settings, ...options }) => {
      const agent = await loadFor(defined, settings);
      return turn({ ...options, agent, source: options.source ?? "terminal" });
    },
  };
  return defined;
}

/** The folder of the file that called defineAgent. */
function callerFolder(id: string): string {
  // [0] is this function, [1] is defineAgent, [2] is whoever called it.
  const caller = getCallSites()[2]?.scriptName ?? "";
  if (!caller.startsWith("file:") && !caller.startsWith("/")) {
    throw new Error(`defineAgent could not tell which file ${id} is written in. Give it folder: import.meta.dirname.`);
  }
  return dirname(caller.startsWith("file:") ? fileURLToPath(caller) : caller);
}

/**
 * The agent a script runs, loaded from the project it is in. With a
 * chloe.config.ts, that file is the project and holds the settings. Without one,
 * this agent is the whole project and `settings` are its settings.
 */
async function loadFor(defined: DefinedAgent, settings?: DeclaredSettings): Promise<Agent> {
  if (!existsSync(CONFIG)) return (await loadAll({ agents: [defined], settings })).get(defined.id)!;
  if (settings) {
    throw new Error(`${defined.id} was given settings, but ${CONFIG} holds this project's. Put them there, or run it from a folder without one.`);
  }
  return load(defined.id);
}

/** What `chloe.config.ts` exports: the agents to run, and the settings. */
export interface Config {
  /** Every agent to run. An agent that is not in this list does not run. Required. */
  agents: DefinedAgent[];
  /**
   * Your settings: which model to use, how mail is sent, what a remote
   * dashboard may do, and more. See `Settings` for every one. A setting you
   * leave out keeps its default.
   *
   * This file is in source control, so never write a secret here. Write
   * `process.env.SOME_NAME` instead, and put the value in `.env`. chloe reads
   * no setting from the environment by itself.
   */
  settings?: DeclaredSettings;
}

/**
 * Returns the config you give it, unchanged. Use it as the default export of
 * `chloe.config.ts`, so your editor checks the config as you write it.
 *
 * You can write the agents and their jobs in this file too, so a small
 * project fits in one file. Code inside `if (import.meta.main)` runs only
 * when you run the file yourself with `node chloe.config.ts`, not when chloe
 * reads it:
 *
 * ```ts
 * if (import.meta.main) console.log(await agent.run({ job: hello }));
 * ```
 */
export function defineConfig(config: Config): Config {
  return config;
}

/** A job that is only a prompt, kept in one markdown file. Made with `markdownJob()`. */
export interface MarkdownJob {
  /** The path of the markdown file, inside the agent's folder. */
  markdownJob: string;
}

/**
 * Adds a job that is only a prompt, kept in one markdown file. Put it in
 * `jobs` in `agent.ts`: `markdownJob("jobs/<id>.md")`. The path is inside the
 * agent's folder, and the file name without `.md` is the job's id.
 *
 * The file may start with a block of settings between two `---` lines. chloe
 * reads only `cron`, `description`, `timezone` (default `"UTC"`) and `model`
 * there, all optional, and ignores any other key. The prompt is the text
 * under the block. Without `cron`, the job runs only when somebody starts it.
 */
export function markdownJob(file: string): MarkdownJob {
  return { markdownJob: file };
}

/** The settings a markdown job may have at its top, and no others. */
export const MARKDOWN_JOB_SETTINGS = ["cron", "description", "timezone", "model"];

/**
 * What is wrong with a markdown job, in one sentence, or undefined when it
 * would load. Stricter than the loader: a setting it does not know is refused
 * here rather than ignored.
 */
export function markdownJobProblem(text: string): string | undefined {
  const { settings, body } = settingsAndBody(text);
  if (!body.trim()) return "it has no prompt under its settings";
  const unknown = Object.keys(settings).filter((key) => !MARKDOWN_JOB_SETTINGS.includes(key));
  if (unknown.length) return `it has ${unknown.join(", ")} at the top, and a job only reads ${MARKDOWN_JOB_SETTINGS.join(", ")}`;
  if (settings.cron) {
    try {
      parse(settings.cron);
    } catch (error) {
      return `its cron line does not read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (settings.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone });
    } catch {
      return `${settings.timezone} is not a timezone, like America/New_York`;
    }
  }
  return undefined;
}

/**
 * One skill: a markdown file in the agent's `skills/` folder. The model sees
 * each skill's name and description, and reads the body only when it needs
 * it.
 */
export interface Skill {
  /** The skill's name: `name` in the file's top block, or the file name without `.md`. */
  name: string;
  /** One sentence on when to use the skill: `description` in the file's top block. Empty if not set. */
  description: string;
  /** The text of the skill, under the top block. */
  body: string;
  /** The file's path inside the agent's folder, like `skills/deploys.md`. */
  file: string;
}

/**
 * One job of an agent, after chloe has loaded it: when it runs, and its code
 * or its prompt. You find these in `agent.jobs`. To write a job, use
 * `defineJob` or `markdownJob`.
 */
export interface Job {
  /** The id of the agent the job belongs to. */
  agent: string;
  /** The job's id. The run history, the API and the evals use it. */
  id: string;
  /** One line on what the job does. */
  description?: string;
  /** When the job runs by itself, as a cron line. Not set when it runs only when somebody starts it. */
  cron?: string;
  /** The timezone of `cron`, like `"America/New_York"`. `"UTC"` when the job did not set one. */
  timezone: string;
  /** The model the job uses in place of the agent's. Not set when it uses the agent's model. */
  model?: string;
  /** The job's prompt, for a job that is a prompt. An empty string (`""`) for a code job. */
  prompt: string;
  /** The job's code, for a job that is code. Not set for a prompt job. */
  run?: (work: Work<Data>) => Promise<unknown>;
  /** Turns what `run` returned into words. See `response` in `JobConfig`. */
  response?: (result: unknown) => string;
  /**
   * The job's files, as paths inside the agent's folder, the markdown first.
   * The dashboard shows them. A markdown job lists its file. A code job lists
   * the file its `markdown` prompt is in, and `jobs/<id>.ts` and
   * `jobs/<id>.md` if they exist. A code file with any other name is not
   * listed.
   */
  files: string[];
  /** The zod schema of the job's `state`, if it keeps one. */
  state?: z.ZodType;
  /** The zod schema of the values the job takes when somebody starts it by hand. See `args` in `JobConfig`. */
  args?: z.ZodType;
  /**
   * The channels whose messages this job handles. Set only for a job named in
   * a channel's `job` option. Only a message on those channels starts it: it
   * has no schedule, no `/command`, and the dashboard and the API cannot
   * start it.
   */
  channels?: string[];
}

/**
 * Tools that chloe can add to an agent. Turn each one on or off here, for
 * example `features: { runScripts: true }`.
 */
export interface Features {
  /**
   * Adds the memory tools: `memoryListFiles`, `memoryReadFile`,
   * `memorySearchFiles`, `memoryWriteFile` and `memoryEditFile`. They work on
   * the agent's memory folder (see `memory` on the agent). On by default.
   * Set it to `false` to leave them out.
   */
  memory?: false;
  /**
   * Adds the tool `selfWriteFile`, which lets the agent change its own files:
   * its instructions, skills and jobs, and its code (`agent.ts`, jobs, tools,
   * scripts). On by default.
   *
   * Set it to `false` to turn it off. Give an object instead to allow fewer
   * files, protect some files, or leave code out with `code: false`. See
   * `SelfImprovement`.
   *
   * Each change is saved as a git commit, so you can see it and undo it on
   * the dashboard. The agent can only use this tool in a reply to a message
   * from its owner. It cannot use it after another tool in the same reply has
   * read something from outside the agent (an email, a web page, a script's
   * output, one of its past runs).
   *
   * Every agent can already read its own files and past runs
   * (`selfListFiles`, `selfReadFile`, `selfListRuns`, `selfReadRun`) in
   * replies to its owner. It does not need this setting for that.
   */
  selfImprovement?: false | SelfImprovement;
  /**
   * Adds the tool `scriptRun`, which lets the agent run any file in its own
   * `scripts/` folder. Off by default.
   *
   * Each script runs as a program, so it must be executable (`chmod +x`, with
   * a `#!` first line). It runs inside the `scripts/` folder, and gets the
   * agent's memory folder in the `MEMORY_FOLDER` environment variable. If this
   * is on and `scripts/` is empty, the agent does not load.
   *
   * Write a skill that tells the agent when to use each script.
   */
  runScripts?: boolean;
  /**
   * Adds the tool `memoryWriteUserNotes`, which keeps one note about each
   * person the agent talks to, on any channel. Off by default.
   *
   * The notes are files in the agent's memory, like
   * `users/telegram-12345.md`. chloe picks whose note it is from who sent the
   * message, and the model cannot choose. The model sees that person's note
   * at the start of each reply to them. One person on two channels has two
   * notes.
   */
  memoryPerUser?: boolean;
}

/** `selfImprovement` with its file endings worked out, which is what the tools are given. */
export interface OwnFileRules extends SelfImprovement {
  files: string[];
}

/** The plain text an agent may change, without the dots. */
export const PLAIN_TEXT = ["md", "txt", "html", "json", "yml", "yaml", "csv"];

/** The code it may also change unless it says `code: false`, without the dots. */
export const CODE_FILES = ["ts", "js", "mjs", "py", "sh"];

/**
 * Which of its own files an agent may change with `selfWriteFile`. Give it as
 * `features.selfImprovement`, for example `{ except: ["PERMISSIONS.md"] }`, or
 * `{ code: false }` to keep it to plain text.
 *
 * The agent never writes its `evals/` folder or its memory (it changes its
 * memory with `memoryWriteFile`).
 */
export interface SelfImprovement {
  /**
   * The file endings the agent may write, without the dot, like `["md"]`.
   * Default: `md`, `txt`, `html`, `json`, `yml`, `yaml` and `csv`, and
   * unless `code: false`, `ts`, `js`, `mjs`, `py` and `sh` too.
   *
   * A code ending here does nothing with `code: false`. An empty list stops
   * the agent from loading.
   */
  files?: string[];
  /**
   * Paths inside the agent's folder that it may read but never write, like a
   * file of rules it must follow: `["PERMISSIONS.md"]`. Default: none. With
   * any, the agent writes no code, because code it wrote could change them.
   */
  except?: string[];
  /**
   * Lets the agent change its code too: `agent.ts`, and the code of its jobs,
   * tools, services, channels and scripts. On by default. With `code: false`
   * the agent cannot add a new job, because a new job must be named in
   * `agent.ts`.
   *
   * Before a code change is kept, chloe loads the agent with it, and type
   * checks it if your project uses TypeScript. If that fails, or a job would
   * run more than once an hour, every file is put back and the agent is told
   * why.
   *
   * Warning: code the agent writes then runs on your machine with the same
   * rights as chloe, which is why `except` turns code off.
   */
  code?: boolean;
}

/**
 * Where and how an agent keeps its memory. Give it as `memory` on the agent.
 * The dashboard shows the memory next to the agent's own files.
 */
export interface Memory {
  /**
   * The memory folder, as a full path like `"/home/you/notes"`. Default: a
   * folder named after the agent's `id`, inside `data/memory/` in your
   * project. chloe makes `data/memory/` one git repository for all the
   * agents.
   */
  folder?: string;
  /** The name the dashboard shows for the memory. Default: `"Memory"`. */
  label?: string;
  /**
   * When a change to the memory is saved as a git commit:
   *
   * - `"each run"`: when a run ends, or pauses to wait for an answer,
   *   everything it changed is saved in one commit under the agent's id. If
   *   the folder is not a git repository, chloe makes it one.
   * - `true`: every write, by the agent (`memoryWriteFile`, `memoryEditFile`)
   *   or from the dashboard, is its own commit with a message. The folder
   *   should already be a git repository. Use this for a folder you share
   *   with a person.
   * - `false`: never.
   *
   * Default: `"each run"` for the default folder, and `false` for a folder you
   * set in `folder`.
   */
  commit?: boolean | "each run";
}

/**
 * How much of a conversation the model sees with each new message on a
 * channel. A conversation is one chat, or one topic in a forum. Jobs never
 * see one. Older messages are not deleted: they are only not shown to the
 * model.
 */
export interface ChatHistory {
  /** How many of the latest messages to show. A message and its reply count as two. Default: 10. */
  messages?: number;
  /** Leaves out messages older than this many days. Default: no limit. */
  days?: number;
}

/**
 * A channel: a way for people or other systems to reach an agent, like
 * Telegram or the API. List channels in the agent's `channels`:
 * `channels: [telegramChannel({ ... })]`. You only write one yourself for a
 * platform that chloe does not ship.
 */
export interface Channel {
  /**
   * The channel's name, like `"telegram"` or `"api"`. The run history and the
   * dashboard show it. Two channels of one agent cannot have the same name.
   * The channel named `"api"` is the one that lets a token reach the agent.
   * Required.
   */
  name: string;
  /** How much of the conversation on this channel the model sees with each new message. See `ChatHistory`. Default: the last 10 messages. */
  chatHistory?: ChatHistory;
  /**
   * The options the channel was made with, as JSON text. The dashboard shows
   * them, with secrets hidden. When this text changes on a reload, chloe
   * restarts the channel, because a running channel keeps the options it
   * started with.
   */
  madeWith?: string;
  /**
   * A code job that handles every message on this channel, in place of the
   * agent's normal reply. The agent loads it as one of its jobs, but only a
   * message on this channel can start it. Do not also put it in the agent's
   * `jobs`, and do not give it a `cron`: either one stops the agent from
   * loading.
   */
  job?: JobConfig<any, any, any, any>;
  /**
   * The connection this channel works through, the same way a tool names one.
   * For example, an email channel on Gmail needs Google. The agent's
   * Connections page on the dashboard lists it with what is missing, and you
   * sign in there.
   */
  needs?: Connection;
  /**
   * Called when the agent loads, to check that this channel can work with
   * the agent. If it cannot, throw an error that says why: the agent then
   * does not load.
   */
  check?(agent: Agent): void;
  /**
   * Starts the channel, so it begins to listen for messages. Call `agent()`
   * for each message to get the agent as it is now, so edits take effect at
   * once. It returns `undefined` if the agent is gone.
   */
  start(agent: () => Agent | undefined): Running;
}

/** A channel that has started. `Channel.start` returns it. */
export interface Running {
  /** Stops the channel. */
  stop(): void;
  /**
   * The web addresses this channel answers on chloe's web server, for a
   * platform that sends messages in (a webhook). Default: none.
   *
   * They are answered before the login, so check every request yourself, for
   * example with a secret the platform signs it with.
   */
  routes?: ChannelRoute[];
}

/** One web address that a running channel answers on chloe's web server. It is answered before the login. */
export interface ChannelRoute {
  /** The path, like `/chloe/v1/<agent id>/<channel name>`. It must match the request's path exactly. */
  path: string;
  /**
   * The HTTP methods it answers. Default: `["POST"]`. A platform that checks
   * the address with a GET before it uses it needs both. Answer that GET only
   * when the caller knows the channel's secret.
   */
  methods?: ("GET" | "POST")[];
  /** Answers one request. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/**
 * One agent after chloe has loaded it: its instructions read, its tools
 * ready, and its skills and jobs loaded. `load` and `loadAll` return these,
 * and a channel's `check` and `start` get one.
 */
export interface Agent extends Omit<DefinedAgent, "instructions" | "tools" | "jobs" | "channels" | "memory" | "model" | "connections" | "run" | "ask"> {
  /**
   * The model the agent uses: its own `model`, or `model.defaultModel` from
   * settings. Always set. An AI SDK model shows here by its name, like
   * `"anthropic/claude-opus-5-5"`.
   */
  model: string;
  /** The agent's memory, with `folder` and `commit` always filled in. See `Memory`. */
  memory: Memory & { folder: string };
  /** The agent's instructions as text, read from their file when they are in one. */
  instructions: string;
  /** The file the instructions were read from, as a path inside the agent's folder. Not set when they were written as a string. */
  instructionsFile?: string;
  /**
   * The full paths of the files that the instructions and the jobs' prompts
   * add with `prompt(file, { include })`. chloe watches them like the agent's
   * own folder.
   */
  included?: string[];
  /** Every tool the agent has: its own `tools`, plus the ones `features` and `connections` add. */
  tools?: Tools;
  /** Where each tool that is not the agent's own comes from, like `features.memory` or `connection github`. */
  toolsFrom?: Record<string, string>;
  /** The agent's skills, read from the markdown files in its `skills/` folder. */
  skills: Skill[];
  /** The agent's jobs, loaded, including the jobs named on its channels. */
  jobs: Job[];
  /** The agent's channels. */
  channels: Channel[];
  /** The agent's MCP connections. */
  connections: McpConnection[];
}

/**
 * Where the memories are kept: `memory/` beside the agents, which the runtime
 * makes one git repository with a folder per agent inside it, so one history
 * covers every agent and the agents' own folders stay source and nothing else.
 * A memory that names its own folder keeps its history in that folder instead.
 */
export function memoryRoot(memory?: Memory): string {
  return memory?.folder || MEMORIES;
}

/**
 * Where one agent remembers things: what it said, or its own folder inside
 * `memory/`. Named after the agent rather than its folder, so a folder that is
 * renamed still finds the same memory.
 */
export function memoryFolder(id: string, memory?: Memory): string {
  return memory?.folder || join(MEMORIES, id);
}

/** When a change to this memory becomes a commit. See Memory. */
function commitsWhen(memory?: Memory): Memory["commit"] {
  return memory?.commit ?? (memory?.folder ? false : "each run");
}

/** An agent's folder as the repo sees it, for saying where something is wrong. */
function shown(folder: string): string {
  const inside = relative(ROOT, folder);
  return inside && !inside.startsWith("..") ? inside : folder;
}

/**
 * Loads every agent that `chloe.config.ts` lists, and returns them by id. It
 * also reads the settings from that file.
 *
 * Give it a config to use that one and not read `chloe.config.ts`, for a
 * script that is a project of its own.
 */
export async function loadAll(given?: Config): Promise<Map<string, Agent>> {
  const { config, listed } = given ? { config: given, listed: given.agents } : await readConfig();
  declareSettings(config.settings);

  const folders = new Map<string, string>();
  const memories = new Map<string, string>();
  for (const one of listed) {
    if (!one?.id) throw new Error("chloe.config.ts lists an agent with no id.");
    if (folders.has(one.id)) throw new Error(`chloe.config.ts lists two agents called ${one.id}.`);
    folders.set(one.id, one.folder);
    memories.set(one.id, memoryFolder(one.id, one.memory));
  }
  // Before anything is bound, so a tool that asks where its agent lives is told.
  setAgentDirs(folders, memories);

  const all = new Map<string, Agent>();
  for (const one of listed) all.set(one.id, await resolveAgent(one));
  return all;
}

/**
 * `chloe.config.ts`, imported fresh, and the agents it lists. Everything outside
 * the runtime is imported again each time, so an edit is read.
 */
async function readConfig(): Promise<{ config: Config; listed: DefinedAgent[] }> {
  generation++;
  if (!existsSync(CONFIG)) throw new Error(`There is no chloe.config.ts at or above ${ROOT}. ${NO_CONFIG}`);
  const module = (await import(pathToFileURL(CONFIG).href).catch((error: unknown) => {
    // A job file runs as it is imported, so a mistake in one (an
    // every(7).minutes) is thrown from here.
    throw new Error(`chloe.config.ts: ${error instanceof Error ? error.message : String(error)}`);
  })) as { default?: Config };
  const listed = module.default?.agents;
  if (!Array.isArray(listed)) throw new Error("chloe.config.ts does not export defineConfig({ agents: [...] }) as its default.");
  return { config: module.default!, listed };
}

/**
 * Reads the settings from `chloe.config.ts` into `settings`, and does not
 * load the agents. Use it in a script that needs a setting before chloe is
 * running. `loadAll` already does this.
 */
export async function loadSettings(): Promise<void> {
  const { config, listed } = await readConfig();
  declareSettings(config.settings);
}

/**
 * Returns the id of every agent, in the order `chloe.config.ts` lists them.
 * It loads every agent to find them.
 */
export async function agentIds(): Promise<string[]> {
  return [...(await loadAll()).keys()];
}

/** What a reload waits for: a check of an agent's new code, which may put a file back. */
let checking: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` once every check before it has finished, and holds reloads
 * (`checksDone()`) until it has, so what a reload reads is what passed.
 */
export function checkFirst<T>(work: () => Promise<T>): Promise<T> {
  const turn = checking.then(work, work);
  checking = turn.catch(() => undefined);
  return turn;
}

/** Waits for the checks of agents' new code that are going. */
export function checksDone(): Promise<unknown> {
  return checking;
}

/**
 * One agent as the next reload would load it: chloe.config.ts and every file
 * outside the runtime imported afresh, and only this agent resolved; the
 * agent.ts in its folder when no config lists it. Throws what that reload
 * would. The settings are left as they are.
 */
export async function loadAgain(agent: { id: string; folder: string }): Promise<Agent> {
  const listed = existsSync(CONFIG) ? (await readConfig()).listed : (generation++, []);
  const one = listed.find((each) => each?.id === agent.id) ?? (await ownFile(agent));
  return resolveAgent(one);
}

/** An agent no chloe.config.ts lists, read from the agent.ts in its folder. */
async function ownFile({ id, folder }: { id: string; folder: string }): Promise<DefinedAgent> {
  const file = join(folder, "agent.ts");
  if (!existsSync(file)) throw new Error(`${id} is not in chloe.config.ts, and its folder has no agent.ts.`);
  const one = ((await import(pathToFileURL(file).href)) as { default?: DefinedAgent }).default;
  if (!one?.id) throw new Error(`${shown(file)} does not export defineAgent({ ... }) as its default.`);
  return one;
}

/**
 * Loads one agent from `chloe.config.ts`, by its id. It loads every agent to
 * do so. If no agent has that id, it throws an error that lists the ids there
 * are.
 */
export async function load(id: string): Promise<Agent> {
  const all = await loadAll();
  const one = all.get(id);
  if (!one) throw new Error(`chloe.config.ts has no agent called ${JSON.stringify(id)}. It has: ${[...all.keys()].join(", ")}.`);
  return one;
}

/**
 * One declared agent as the runtime uses it: its words read, its jobs loaded,
 * its tools bound and its memory folder worked out. `loadAll` calls this for
 * every agent in chloe.config.ts.
 */
export async function resolveAgent(definition: DefinedAgent): Promise<Agent> {
  const { id, folder } = definition;
  const where = `${id} (${shown(folder)})`;
  const model = definition.model ? nameOf(definition.model) : configured.model.defaultModel;
  if (!model) throw new Error(`${where} does not say which model, and model.defaultModel in settings names none.`);
  if (!definition.instructions) throw new Error(`${where} has no instructions. Add instructions: prompt("instructions.md").`);

  const { tools, jobs, channels, connections, run, ask, ...rest } = definition;
  // Worked out once, here, so the site, the memory tool and a job's
  // work.memory all mean the same folder without any of them saying it again.
  const memory = {
    ...definition.memory,
    folder: memoryFolder(id, definition.memory),
    commit: commitsWhen(definition.memory),
  };
  // Made now, so committing what a run changed has a folder to name.
  await mkdir(memory.folder, { recursive: true }).catch(() => undefined);
  if (memory.commit === "each run") {
    // Without git, or on a folder it cannot write, the agent still runs: it only
    // has no history. The repository is the memory root, shared by every agent.
    await makeRepo(memoryRoot(definition.memory), id).catch((error: unknown) =>
      console.error(`${where}: its memory could not be made a git repository:`, error instanceof Error ? error.message : error),
    );
  }
  const home = { id, folder, memory };
  const bound = channelsOf(channels ?? [], where);
  const agent: Agent = {
    ...rest,
    model,
    memory,
    instructions: await readPrompt(definition.instructions, { dir: folder, where }),
    instructionsFile: isPrompt(definition.instructions) ? definition.instructions.file : undefined,
    included: [
      ...includedIn(definition.instructions, folder),
      ...(jobs ?? []).flatMap((one) => includedIn((one as { markdown?: unknown }).markdown, folder)),
    ],
    ...withTools(await connectionTools(connections ?? [], where), featureTools(definition.features, home, where), tools ?? {}, where),
    skills: await skillsIn(`${folder}/skills`),
    jobs: await channelJobs(id, folder, await jobsOf(id, folder, jobs ?? []), bound),
    channels: bound,
    connections: connections ?? [],
  };
  for (const channel of agent.channels) {
    try {
      channel.check?.(agent);
    } catch (error) {
      throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return agent;
}

/**
 * The tools of every connection, asked for now. One that does not answer is
 * left out and said in the log, and the agent loads without it: the setup page
 * says why. A tool of the agent's own with the same name wins.
 */
async function connectionTools(connections: McpConnection[], where: string): Promise<Record<string, Tools>> {
  if (!Array.isArray(connections)) {
    throw new Error(`${where}: connections is a list, like [mcpConnection({ name: "github", url })].`);
  }
  const names = connections.map((one) => one.name);
  const twice = names.find((one, i) => names.indexOf(one) !== i);
  if (twice) throw new Error(`${where}: two connections are called ${JSON.stringify(twice)}. Give each its own name.`);
  const found = await Promise.all(
    connections.map((one) =>
      one.tools().catch((error: Error) => {
        console.error(`${where}: the ${one.name} connection brought no tools: ${error.message}`);
        return {};
      }),
    ),
  );
  return Object.fromEntries(connections.map((one, i) => [`connection ${one.name}`, found[i]]));
}

/**
 * Every tool, the agent's own winning over a connection's or a feature's of the
 * same name, and where each one it did not write itself comes from.
 */
function withTools(
  connected: Record<string, Tools>,
  featured: Record<string, Tools>,
  own: Tools,
  where: string,
): { tools: Tools; toolsFrom: Record<string, string> } {
  const added = { ...connected, ...featured };
  const toolsFrom: Record<string, string> = {};
  for (const [from, tools] of Object.entries(added)) for (const name of Object.keys(tools)) toolsFrom[name] = from;
  const tools = toolsOf({ ...Object.assign({}, ...Object.values(added)), ...own }, where);
  for (const name of Object.keys(own)) delete toolsFrom[name];
  return { tools, toolsFrom };
}

function channelsOf(channels: Channel[], where: string): Channel[] {
  if (!Array.isArray(channels)) {
    throw new Error(`${where}: channels is a list, like [telegramChannel({ ... }), apiChannel()].`);
  }
  const seen = new Set<string>();
  channels.forEach((one, i) => {
    if (typeof one?.start !== "function" || typeof one.name !== "string" || !one.name) {
      throw new Error(`${where}: channels[${i}] is not a channel.`);
    }
    if (seen.has(one.name)) throw new Error(`${where}: two channels are called ${one.name}.`);
    seen.add(one.name);
  });
  return channels;
}

/** Does this agent have a channel of this name? "api" is what lets a token reach it. */
export function hasChannel(agent: Pick<Agent, "channels">, name: string): boolean {
  return agent.channels.some((one) => one.name === name);
}

/**
 * What `selfImprovement` comes to: undefined when it is `false`, and otherwise
 * the files the agent may change, code among them unless it says `code: false`
 * or has an `except`, which code could get round.
 */
export function ownFileRules(features: Features = {}): OwnFileRules | undefined {
  const self = features.selfImprovement;
  if (self === false) return undefined;
  // An object, or nothing; `true` from plain JavaScript reads as nothing.
  const said = typeof self === "object" ? self : {};
  const code = said.code !== false && !said.except?.length;
  return { ...said, code, files: said.files ?? (code ? [...PLAIN_TEXT, ...CODE_FILES] : PLAIN_TEXT) };
}

/**
 * What an agent's `features` turn on, as tools, under where each comes from:
 * `features.memory` unless it says memory: false.
 */
function featureTools(features: Features = {}, home: Home, where: string): Record<string, Tools> {
  const self = features.selfImprovement;
  if (typeof self === "object" && self.files && self.files.length === 0) {
    throw new Error(`${where}: selfImprovement is false, or says which files it may change, like { files: ["md"] }.`);
  }
  if (typeof self === "object" && self.except?.length && self.code !== false) {
    console.warn(`${where}: selfImprovement has except, so this agent writes no code, which could change those files. Say code: false to keep it so.`);
  }
  const rules = ownFileRules(features);
  return {
    ...(features.memory === false ? {} : { "features.memory": memoryTools()(home) }),
    ...(rules ? { "features.selfImprovement": selfWriteTools(rules)(home) } : {}),
    ...(features.runScripts ? { "features.runScripts": scriptTools()(home) } : {}),
    ...(features.memoryPerUser ? { "features.memoryPerUser": userNotesTools()() } : {}),
  };
}

/** The agent's tools, checked. */
function toolsOf(tools: Tools, where: string): Tools {
  if (Array.isArray(tools) || typeof tools !== "object") {
    throw new Error(`${where}: tools is one object keyed by name, like { weather, gmailReadEmail: gmail.readEmail({ ... }) }.`);
  }
  for (const [id, each] of Object.entries(tools)) {
    const wrong = cannotRun(id, each);
    if (wrong) throw new Error(`${where}: ${wrong}`);
  }
  return tools;
}

async function skillsIn(dir: string): Promise<Skill[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const skills: Skill[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const { settings, body } = settingsAndBody(await readFile(`${dir}/${file}`, "utf8"));
    skills.push({
      name: settings.name ?? file.replace(/\.md$/, ""),
      description: settings.description ?? "",
      body,
      file: `skills/${file}`,
    });
  }
  return skills;
}

/**
 * The jobs an agent names, in the order it names them, then every markdown
 * file in its jobs/ that is not already one of those or the words of one.
 */
export async function jobsOf(agent: string, dir: string, list: (JobConfig<any, any, any> | MarkdownJob)[]): Promise<Job[]> {
  const jobs: Job[] = [];
  const add = (job: Job) => {
    if (jobs.some((other) => other.id === job.id)) throw new Error(`${agent}: two jobs are called ${job.id}.`);
    jobs.push(job);
  };
  for (const one of list) {
    add("markdownJob" in one ? await fromMarkdown(agent, dir, one.markdownJob) : await fromCode(agent, dir, one));
  }
  return jobs;
}

/**
 * Its jobs, and the ones its channels hand messages to, each of those once
 * with every channel that names it. A channel's job is named on the channel
 * only, so nothing but a message there can start it: one also in `jobs`, a
 * prompt, or one with a cron line stops the agent loading.
 */
async function channelJobs(agent: string, dir: string, jobs: Job[], channels: Channel[]): Promise<Job[]> {
  const all = [...jobs];
  for (const channel of channels) {
    if (!channel.job) continue;
    const where = `${agent}'s ${channel.name} channel`;
    const same = all.find((one) => one.id === channel.job!.id);
    if (same && !same.channels) {
      throw new Error(`${where} hands its messages to ${same.id}, which is also in its jobs. Name a channel's job on the channel only, so nothing else starts it.`);
    }
    if (same) {
      same.channels!.push(channel.name);
      continue;
    }
    const job = await fromCode(agent, dir, channel.job);
    if (!job.run) throw new Error(`${where} hands its messages to ${job.id}, which is a prompt. A channel's job is code with run, which reads the message from work.input.`);
    if (job.cron) throw new Error(`${where} hands its messages to ${job.id}, which has a cron line. A channel's job starts from its messages only.`);
    all.push({ ...job, channels: [channel.name] });
  }
  return all;
}

/**
 * A cron line is read when the agent loads, so a bad one stops that agent with
 * the job's name on it, rather than being found by the clock every minute.
 */
function checked(cron: string | undefined, where: string): string | undefined {
  if (!cron) return undefined;
  try {
    parse(cron);
  } catch (error) {
    throw new Error(`${where} has a cron line that does not read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cron;
}

async function fromMarkdown(agent: string, dir: string, file: string): Promise<Job> {
  const path = file.replace(/^\.\//, "");
  const where = `${shown(dir)}/${path}`;
  const text = await readFile(`${dir}/${path}`, "utf8").catch(() => {
    throw new Error(`${agent} names ${where} as a job, and it is not there.`);
  });
  const { settings, body } = settingsAndBody(text);
  if (!body.trim()) throw new Error(`${where} has no prompt under its frontmatter.`);
  const id = path.split("/").pop()!.replace(/\.md$/, "");
  return {
    agent,
    id,
    description: settings.description,
    cron: checked(settings.cron, where),
    timezone: settings.timezone ?? "UTC",
    model: settings.model,
    prompt: body,
    files: [path],
  };
}

async function fromCode(agent: string, dir: string, definition: JobConfig<any, any, any>): Promise<Job> {
  if (!definition?.id) throw new Error(`${agent} names a job with no id.`);
  const { id } = definition;
  const where = `${agent} job ${id}`;
  if (definition.run && definition.markdown) {
    throw new Error(`${where} has both run and markdown. A job is code or a prompt, never both.`);
  }
  if (!definition.run && !definition.markdown) {
    throw new Error(`${where} has neither run nor markdown, so nothing happens when it runs.`);
  }
  const unread = ["summary", "reply"].filter((key) => key in definition);
  if (unread.length) throw new Error(`${where} has ${unread.join(" and ")}, which nothing reads. Say it with \`response\`.`);
  if ("answers" in definition) {
    throw new Error(`${where} has answers, which nothing reads. A job starts on its schedule or from /${id} sent by a person, never from what a model replies.`);
  }

  const common = {
    agent,
    id,
    description: definition.description,
    cron: checked(definition.cron, where),
    timezone: definition.timezone ?? "UTC",
    model: definition.model && nameOf(definition.model),
    files: [
      ...new Set([
        ...(isPrompt(definition.markdown) ? [relative(dir, join(dir, definition.markdown.file))] : []),
        ...[`jobs/${id}.md`, `jobs/${id}.ts`].filter((file) => existsSync(`${dir}/${file}`)),
      ]),
    ],
  };

  // A job has no prompt, and the empty string is what says so everywhere else.
  if (definition.run) {
    return {
      ...common,
      prompt: "",
      run: definition.run,
      state: definition.state,
      args: definition.args,
      response: definition.response,
    };
  }

  return { ...common, prompt: await readPrompt(definition.markdown, { dir, where }) };
}
