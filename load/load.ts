// An agent is declared, not found. Each one is a defineAgent(...) with a name,
// and chloe.config.ts at the top of the repo lists them. Nothing is found by
// looking in a folder except an agent's skills/.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getCallSites } from "node:util";

import type { z } from "zod";

import { ROOT, STATE, setAgentDirs } from "#chloe/core/paths.ts";
import { readPrompt, settingsAndBody, type Prompt } from "#chloe/core/markdown.ts";
import { parse } from "#chloe/timer/cron.ts";
import type { Definition as JobFile } from "./job.ts";
import type { Tool, Tools } from "#chloe/model/tool.ts";
import { memoryTools } from "#chloe/model/tools/memory.ts";
import { runScripts } from "#chloe/model/tools/run_script.ts";
import { selfImprovement } from "#chloe/model/tools/write_skill.ts";
import type { Work } from "#chloe/core/steps.ts";

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
  name: string;
  folder: string;
  /** This agent's memory as its definition says it, with the folder worked out. See Memory. */
  memory: Memory & { folder: string };
}

/** A set of tools made for one agent as it loads, like read_mail({ ... }). */
export type Binding = (agent: Home) => Tools;

/** What defineAgent is given. */
export interface Definition {
  /** What the run history, its data folder and its pages are filed under. Do not change it once it has run. */
  name: string;
  /** What the page calls it, when that is not its name: "C.C.". Free to change. */
  label?: string;
  /**
   * Where its skills, scripts, evals and prompts are. Defaults to the folder
   * of the file that calls defineAgent.
   */
  folder?: string;
  /** A gateway model id, like "anthropic/claude-sonnet-5". */
  model: string;
  /** One line, shown wherever agents are listed. */
  description: string;
  /**
   * Where this agent remembers things: the folder it reads and writes between
   * runs, browsable and editable from the site.
   *
   * Every agent has one, and always has list_notes, read_notes, search_notes
   * and write_notes on it. Left unsaid it is that agent's own folder under the
   * state directory, so this is only worth writing down when the agent shares
   * a folder with a person. Every file served out of it is written to that
   * agent's own audit log first. See serve/memory.ts for why that log is not
   * optional.
   */
  memory?: Memory;
  /** The tools the runtime can give any agent, each switched on or off here. */
  features?: Features;
  /** `prompt("instructions.md")`, a path inside the agent's folder, or the words themselves. */
  instructions: string | Prompt;
  /**
   * Each tool, or a set of them like read_mail({ ... }). A model calls one by
   * its id. What `features` turns on is added to these and not listed here.
   */
  tools?: (Tool | Tools | Binding)[];
  /** Each job, imported, or markdownJob("jobs/name.md") for one that is only words. */
  jobs?: (JobFile<any, any> | MarkdownJob)[];
  /** Each way in: `[telegramChannel({ ... }), apiChannel()]`. Each one carries its own name. */
  channels?: Channel[];
  /** Times round the tool loop before a turn is stopped. */
  maxSteps?: number;
}

export interface Defined extends Definition {
  folder: string;
}

/** Declares an agent. List it in chloe.config.ts for it to run. */
export function defineAgent(definition: Definition): Defined {
  if (definition.folder) return { ...definition, folder: definition.folder };
  // [0] is this function, [1] is whoever called it.
  const caller = getCallSites()[1]?.scriptName ?? "";
  if (!caller.startsWith("file:") && !caller.startsWith("/")) {
    throw new Error(`defineAgent could not tell which file ${definition.name} is written in. Give it folder: import.meta.dirname.`);
  }
  const file = caller.startsWith("file:") ? fileURLToPath(caller) : caller;
  return { ...definition, folder: dirname(file) };
}

/** What chloe.config.ts exports: every agent this box runs. */
export interface Config {
  agents: Defined[];
}

/** The default export of chloe.config.ts: every agent to run. */
export function defineConfig(config: Config): Config {
  return config;
}

/**
 * A job that is only a prompt, kept whole in one markdown file with its
 * settings (`cron`, `description`, `timezone`, `model`) at the top. The path
 * is inside the agent's folder, and the file's name is the job's id.
 */
export interface MarkdownJob {
  markdownJob: string;
}

/**
 * A job that is words and nothing else, named in `agent.ts` as
 * `markdownJob("jobs/<id>.md")`. The file name is the job's id.
 */
export function markdownJob(file: string): MarkdownJob {
  return { markdownJob: file };
}

/** One markdown file out of an agent's `skills/` folder. */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

/**
 * One job of an agent's, as the loader resolved it: where its words are, when
 * it runs, and whether it is code.
 */
export interface Job {
  agent: string;
  /** What the run history, the API and `npm run evals` call it. */
  id: string;
  /** One line on what it does. */
  description?: string;
  /** When it runs by itself. Without one it runs only when somebody starts it. */
  cron?: string;
  timezone: string;
  /** When this job should not run on the agent's own model. */
  model?: string;
  /** A job is one of these two and never both. */
  prompt: string;
  /** The job, when it is code rather than a prompt. */
  run?: (work: Work<Record<string, unknown>>) => Promise<unknown>;
  /** One line from what `run` returned. See defineJob. */
  summary?: (result: unknown) => string;
  /** What a chat is sent, from what `run` returned. See defineJob. */
  reply?: (result: unknown) => string;
  /** Plain messages this job answers instead of the agent's chat. See defineJob. */
  answers?: (text: string) => boolean;
  /**
   * The files it is written in, inside the agent's folder, words first. A
   * job imported from code is found by its id: jobs/<id>.ts and jobs/<id>.md.
   */
  files: string[];
  /** The shape of that job's state, when it keeps any. */
  state?: z.ZodType;
  /** The shape of what starting it by hand may send. See job.ts. */
  input?: z.ZodType;
}

/** Tools the runtime brings, switched on per agent: `features: { selfImprovement: true }`. */
export interface Features {
  /** list_notes, read_notes, search_notes and write_notes on its memory. On unless this says false. */
  memory?: boolean;
  /** write_skill, to rewrite its own skills. Every write is a commit. Off unless this says true. */
  selfImprovement?: boolean;
  /**
   * run_script, to run a file in its own scripts/ folder. Off unless this says
   * true, and refused as it loads when that folder has no scripts.
   */
  runScripts?: boolean;
}

/** Where an agent remembers things, shown on the site beside its own pages. */
export interface Memory {
  /**
   * An absolute path. Unset, it is this agent's own folder under the state
   * directory.
   */
  folder?: string;
  /** What the site calls it. "Memory" when nothing is said. */
  label?: string;
  /** Make every write a git commit, from the site and from write_notes. For a folder that is a repo. */
  commit?: boolean;
}

/**
 * How much of a conversation a turn is shown: the last `messages` (10 when
 * unsaid, a question and its answer being two), and none older than `days`
 * (no limit when unsaid). A conversation is one chat, or one topic in a forum,
 * so this belongs to the channel it happens on: a job is never shown one.
 * Nothing is deleted; what is left out is only not shown to the model.
 */
export interface ChatHistory {
  messages?: number;
  days?: number;
}

/** A way in to an agent, listed in its definition: `channels: [telegramChannel({ ... })]`. */
export interface Channel {
  /**
   * What the log, the pages and the permissions call it, like "telegram" or
   * "api". Two channels of one agent cannot share a name. "api" is the one
   * that lets a token reach the agent.
   */
  name: string;
  /** How much of a conversation on this channel a turn is shown. */
  chatHistory?: ChatHistory;
  /** Starts listening. `agent` is read again for every message, so an edit is live. */
  start(agent: () => Agent | undefined): Running;
}

/** A channel that has been started, and how to stop it again. */
export interface Running {
  stop(): void;
  /** For a channel that is sent its messages: the paths it answers on the one port, outside the login. */
  routes?: ChannelRoute[];
}

/** A path a running channel answers on the one port, outside the login. */
export interface ChannelRoute {
  /** Always a POST. */
  path: string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/**
 * One agent as the runtime holds it: the definition with its instructions
 * read, its tools bound, its skills loaded and its jobs resolved.
 */
export interface Agent extends Omit<Definition, "instructions" | "tools" | "jobs" | "channels" | "memory"> {
  folder: string;
  /** Always there once loaded, with its folder worked out. See memoryFolder. */
  memory: Memory & { folder: string };
  instructions: string;
  tools?: Tools;
  skills: Skill[];
  jobs: Job[];
  channels: Channel[];
}

/**
 * Where an agent remembers things: what it said, or its own folder under the
 * state directory. That default is where the memory tool has always written, so
 * an agent that never mentions memory still has one and it is not empty.
 */
export function memoryFolder(name: string, memory?: Memory): string {
  return memory?.folder || `${STATE}/${name}`;
}

/** An agent's folder as the repo sees it, for saying where something is wrong. */
function shown(folder: string): string {
  const inside = relative(ROOT, folder);
  return inside && !inside.startsWith("..") ? inside : folder;
}

/** Every agent chloe.config.ts lists, by name. */
export async function loadAll(): Promise<Map<string, Agent>> {
  generation++;
  if (!existsSync(CONFIG)) throw new Error(`There is no chloe.config.ts in ${ROOT}. It lists the agents to run.`);
  const module = (await import(pathToFileURL(CONFIG).href).catch((error: unknown) => {
    // A job file runs as it is imported, so a mistake in one (an
    // every(7).minutes) is thrown from here.
    throw new Error(`chloe.config.ts: ${error instanceof Error ? error.message : String(error)}`);
  })) as { default?: Config };
  const listed = module.default?.agents;
  if (!Array.isArray(listed)) throw new Error("chloe.config.ts does not export defineConfig({ agents: [...] }) as its default.");

  const folders = new Map<string, string>();
  for (const one of listed) {
    if (!one?.name) throw new Error("chloe.config.ts lists an agent with no name.");
    if (folders.has(one.name)) throw new Error(`chloe.config.ts lists two agents called ${one.name}.`);
    folders.set(one.name, one.folder);
  }
  // Before anything is bound, so a tool that asks where its agent lives is told.
  setAgentDirs(folders);

  const all = new Map<string, Agent>();
  for (const one of listed) all.set(one.name, await resolveAgent(one));
  return all;
}

/** Every agent's name, in the order `chloe.config.ts` lists them. */
export async function names(): Promise<string[]> {
  return [...(await loadAll()).keys()];
}

/** One agent by name, or a throw that names the agents there are. */
export async function load(name: string): Promise<Agent> {
  const all = await loadAll();
  const one = all.get(name);
  if (!one) throw new Error(`chloe.config.ts has no agent called ${JSON.stringify(name)}. It has: ${[...all.keys()].join(", ")}.`);
  return one;
}

async function resolveAgent(definition: Defined): Promise<Agent> {
  const { name, folder } = definition;
  const where = `${name} (${shown(folder)})`;
  if (!definition.model) throw new Error(`${where} does not say which model.`);
  if (!definition.instructions) throw new Error(`${where} has no instructions. Add instructions: prompt("instructions.md").`);

  const { tools, jobs, channels, ...rest } = definition;
  // Worked out once, here, so the site, the memory tool and a job's
  // work.memory all mean the same folder without any of them saying it again.
  const memory = { ...definition.memory, folder: memoryFolder(name, definition.memory) };
  return {
    ...rest,
    memory,
    instructions: await readPrompt(definition.instructions, { dir: folder, where }),
    tools: toolsOf([...featureTools(definition.features, memory), ...(tools ?? [])], { name, folder, memory }, where),
    skills: await skillsIn(`${folder}/skills`),
    jobs: await jobsOf(name, folder, jobs ?? []),
    channels: channelsOf(channels ?? [], where),
  };
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

/** What an agent's `features` turn on, as tools. The memory tools unless it says memory: false. */
function featureTools(features: Features = {}, memory: Memory & { folder: string }): (Tools | Binding)[] {
  return [
    ...(features.memory === false ? [] : [memoryTools(memory)]),
    ...(features.selfImprovement ? [selfImprovement()] : []),
    ...(features.runScripts ? [runScripts()] : []),
  ];
}

function toolsOf(list: (Tool | Tools | Binding)[], home: Home, where: string): Tools {
  const tools: Tools = {};
  for (const one of list) {
    const some: Tools =
      typeof one === "function" ? one(home) : typeof (one as Tool).execute === "function" ? { [(one as Tool).id]: one as Tool } : (one as Tools);
    for (const [id, each] of Object.entries(some)) {
      if (typeof each?.execute !== "function") throw new Error(`${where}: tool ${id} is not a tool.`);
      if (tools[id]) throw new Error(`${where}: two tools are called ${id}.`);
      tools[id] = each;
    }
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
    });
  }
  return skills;
}

/** The jobs an agent names, in the order it names them. */
export async function jobsOf(agent: string, dir: string, list: (JobFile<any, any> | MarkdownJob)[]): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const one of list) {
    const job = "markdownJob" in one ? await fromMarkdown(agent, dir, one.markdownJob) : await fromCode(agent, dir, one);
    if (jobs.some((other) => other.id === job.id)) throw new Error(`${agent}: two jobs are called ${job.id}.`);
    jobs.push(job);
  }
  return jobs;
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

async function fromCode(agent: string, dir: string, definition: JobFile<any, any>): Promise<Job> {
  if (!definition?.id) throw new Error(`${agent} names a job with no id.`);
  const { id } = definition;
  const where = `${agent} job ${id}`;
  if (definition.run && definition.markdown) {
    throw new Error(`${where} has both run and markdown. A job is code or a prompt, never both.`);
  }
  if (!definition.run && !definition.markdown) {
    throw new Error(`${where} has neither run nor markdown, so nothing happens when it runs.`);
  }

  const common = {
    agent,
    id,
    description: definition.description,
    cron: checked(definition.cron, where),
    timezone: definition.timezone ?? "UTC",
    model: definition.model,
    files: [`jobs/${id}.md`, `jobs/${id}.ts`].filter((file) => existsSync(`${dir}/${file}`)),
  };

  // A job has no prompt, and the empty string is what says so everywhere else.
  if (definition.run) {
    return {
      ...common,
      prompt: "",
      run: definition.run,
      state: definition.state,
      input: definition.input,
      summary: definition.summary,
      reply: definition.reply,
      answers: definition.answers,
    };
  }

  return { ...common, prompt: await readPrompt(definition.markdown, { dir, where }) };
}
