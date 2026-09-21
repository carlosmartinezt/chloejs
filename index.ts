// What chloe is, to the repo that installs it.
//
// Everything an agent, a job, a tool or a channel is written with is named
// here, and nothing else in this folder is anybody's business. Import it as
// "chloejs": the three lines below say the rest.
//
//   import { defineJob, tool, note } from "chloejs";
//   import { telegramChannel } from "chloejs/channels/telegram";  // reaching an agent
//   import { calls, expectations } from "chloejs/scorers";  // marking a run
//
// Adding a name here is publishing it, and taking one away is a break, so this
// file is the one place to look when you want to know what may move freely.
// The server itself is `server.ts`, and it is run rather than imported.

// An agent, and the jobs it runs.
export { defineAgent, defineConfig, markdownJob, load, loadAll, names, type Agent, type Channel, type ChannelRoute, type Running, type Job, type Skill, type Binding, type Home } from "./load/load.ts";
export { defineJob } from "./load/job.ts";
export { prompt, isPrompt, oneLineSummary, type Prompt } from "./core/markdown.ts";

// A job: code first, with a model where a step needs judgement and an agent
// where the order of the work cannot be known in advance.
export { work, resume, answer, sweep, parkedRuns, waitingFor, waitingOn, checkInput, WrongInput, type AgentStep, type AskStep, type Line, type ModelStep, type ParkedRun, type Result as RunResult, type Work } from "./core/steps.ts";

// A prompt: ask a model, run the tools it asked for, ask again.
export { turn, type Result as TurnResult } from "./core/turn.ts";

// What a model can be asked to do, and how it is asked.
export { tool, type Approve, type Call, type Tool, type Tools } from "./model/tool.ts";
export { ask, via, type Attachment, type Message } from "./model/model.ts";

// Reaching a person, and being reached back.
export { canReach, deliver, owner, reachBy, split, type Send } from "./model/ask.ts";

// The floor: where things are, what the box was told, staying inside a
// folder, a small file an agent keeps, the history.
export { agentDir, ROOT, STATE } from "./core/paths.ts";
export { readSettings, setting, settings, type Settings } from "./core/settings.ts";
export { confine } from "./core/confine.ts";
export { note, type Note } from "./core/notes.ts";
export { copyDatabase, DATABASE, db, trim } from "./core/db.ts";

// What a job can do without asking anybody: running a command, sending mail,
// reading mail, reading and writing files in one folder, running one of an
// agent's own scripts, reading a web page. The same work offered
// to a model instead is "chloejs/tools", and each of those is a wrapper over one
// of these.
export { run, type Result } from "./do/run.ts";
export { send, type Address } from "./do/email.ts";
export { messages, oneMessage, type Message as Mail } from "./do/mail.ts";
export { list, read, search, write } from "./do/files.ts";
export { script, scripts } from "./do/scripts.ts";
export { readPage, htmlToText, isPrivate, type Page } from "./do/web.ts";
