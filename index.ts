// What chloe is, to the repo that installs it.
//
// Everything an agent, a job, a tool or a channel is written with is named
// here, and nothing else in this folder is anybody's business. Import it as
// "@chloejs/core": the lines below say the rest. A tool is made with the AI
// SDK's `tool()`, imported from "ai".
//
//   import { defineJob, note } from "@chloejs/core";
//   import { run, deliverEmail } from "@chloejs/core/services";  // the work, for a job
//   import * as gmail from "@chloejs/core/tools/gmail";  // the work, for a model
//   import { telegramChannel } from "@chloejs/core/channels";  // reaching an agent
//   import { calls, expectations } from "@chloejs/core/scorers";  // marking a run
//
// Adding a name here is publishing it, and taking one away is a break, so this
// file is the one place to look when you want to know what may move freely.
// The server is `startChloe`: `npx chloe` runs it through `server.ts`, and a script
// with no chloe.config.ts calls it with its own agents.

// An agent, and the jobs it runs.
export { defineAgent, defineConfig, markdownJob, load, loadAll, loadSettings, agentIds, type Agent, type AgentConfig, type Channel, type ChannelRoute, type Config, type DefinedAgent, type RunOptions, type AskOptions, type Running, type Job, type MarkdownJob, type Skill, type Features, type SelfImprovement, type Memory, type ChatHistory } from "./load/load.ts";
export { defineJob, type JobConfig } from "./load/job.ts";
export { startChloe } from "./serve/start.ts";
export { prompt, isPrompt, oneLineSummary, type Prompt } from "./core/markdown.ts";

// A job: code first, with a model where a step needs judgement and an agent
// where the order of the work cannot be known in advance.
export { work, resume, answer, sweep, parkedRuns, waitingFor, waitingOn, checkArgs, WrongArgs, type AgentStep, type Answer, type AskStep, type Data, type Envelope, type Line, type ModelStep, type ParkedRun, type Shape, type Result as RunResult, type Work } from "./core/steps.ts";

// A prompt: ask a model, run the tools it asked for, ask again.
export { turn, type Result as TurnResult } from "./core/turn.ts";

// What a model can be asked to do, and how it is asked.
export { agentOf, type Call, type ChloeTool, type ToolContext, type Tools } from "./model/tool.ts";

// An outside account or program a tool works through, for writing one of your own.
export { NeedsSignIn, type Connection, type SignIn } from "./connections/connection.ts";
export { learnModels, UsageLimit, type Attachment } from "./model/model.ts";

// Reaching a person, and being reached back.
export { canReach, deliver, owner, reachBy, split, type Send } from "./model/ask.ts";

// The floor: where things are, what the box was told, staying inside a
// folder, a small file an agent keeps, the history.
export { agentDir, MEMORIES, ROOT, STATE } from "./core/paths.ts";
export { declareSettings, KEYS, nameInEnv, readSettings, settings, unclaimed, whereKeyGoes, type DeclaredSettings, type Settings } from "./core/settings.ts";
export { confine } from "./core/confine.ts";
export { note, type Note } from "./core/notes.ts";
export { copyDatabase, DATABASE, db, trim } from "./core/db.ts";
