// The files a new project starts with, as text, for `npx chloe setup` to write.
//
// One agent with two jobs, because the two are the whole idea: jobs/daily-note.ts
// is code and asks no model, jobs/summary.md is a prompt and asks one. A person
// reads these two files before they read any documentation, so they are what the
// runtime says a job looks like.
//
// They are text here rather than files on disk because the published package is
// dist/ and a .ts file of examples would be compiled with the runtime.

/** One file to write: where it goes, and what goes in it. */
export interface Starter {
  path: string;
  body: string;
  /** Lines to add to a file that is already there, rather than a file to write. */
  add?: boolean;
}

/**
 * A name as a variable can be written: "night-watch" imports as nightWatch.
 * Agent names are allowed a dash and an import is not.
 */
export function identifier(agent: string): string {
  return agent.replace(/[-_](.)/g, (_, next: string) => next.toUpperCase());
}

/**
 * What a name may be: lower case, digits and dashes, starting with a letter. It
 * becomes a folder, an import and the folder the run history is filed under, so
 * it is checked before any of that is written. Empty when the name is fine.
 */
export function nameProblem(agent: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) return "A name is lower case letters, digits and dashes, and starts with a letter.";
  if (agent.endsWith("-")) return "A name does not end with a dash.";
  return "";
}

/** Every file a new project starts with. `agent` is the name it chose. */
export function starterFiles(agent: string): Starter[] {
  return [
    { path: "chloe.config.ts", body: config(agent) },
    { path: `agents/${agent}/agent.ts`, body: definition(agent) },
    { path: `agents/${agent}/instructions.md`, body: instructions(agent) },
    { path: `agents/${agent}/jobs/daily-note.ts`, body: DAILY_NOTE },
    { path: `agents/${agent}/jobs/summary.md`, body: SUMMARY },
    { path: ".gitignore", body: IGNORE, add: true },
  ];
}

const config = (agent: string) => `// Every agent this box runs.
//
// An agent is declared, never found: one that is not on this list does not
// exist, however finished its folder looks.
import { defineConfig } from "@chloejs/core";

import ${identifier(agent)} from "./agents/${agent}/agent.ts";

export default defineConfig({ agents: [${identifier(agent)}] });
`;

const definition = (agent: string) => `// What this agent is, in one file: its words, its jobs, its tools, and every
// way it can be reached. Nothing in the folder is found by looking except
// skills/, so a job that is written and not named below never runs.
import { defineAgent, markdownJob, prompt } from "@chloejs/core";

import dailyNote from "./jobs/daily-note.ts";

export default defineAgent({
  name: "${agent}",
  description: "The agent npx chloe setup wrote. Make it yours.",
  instructions: prompt("instructions.md"),
  // Which model it asks is model.default in settings.json, so it is written
  // once for every agent. Name one here to give this agent its own.
  jobs: [dailyNote, markdownJob("jobs/summary.md")],
});
`;

const instructions = (agent: string) => `You are ${agent}.

You keep notes in your memory folder, and you read them before you answer. Say
what is true, say when you do not know, and keep it to a line or two unless
somebody asks for more.

These words are live the moment this file is saved, with no restart and no
deploy, so this is the cheapest thing here to change. Replace them with what
your agent is actually for.
`;

const DAILY_NOTE = `// A job with no model in it: three steps, each one written down, and nothing to
// pay. This is where most work belongs. jobs/summary.md is the other kind.
//
// Work happens inside a step. A step is written down and never runs twice, so a
// run that stops halfway and carries on later does not write the day twice.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

export default defineJob({
  id: "daily-note",
  description: "Writes today's date into its memory. Code only, so it costs nothing.",
  cron: every.day.at("08:00"),
  timezone: "UTC",
  run: async (work) => {
    // work.memory is this agent's folder, as its definition worked it out.
    const file = join(work.memory, "days.md");

    const today = await work.step("read the clock", () => new Date().toISOString().slice(0, 10));
    await work.step("write it down", () => appendFile(file, \`- \${today}\\n\`));
    const days = await work.step("count the days", async () => (await readFile(file, "utf8")).trim().split("\\n").length);

    return { today, days };
  },
});
`;

const SUMMARY = `---
description: Reads its own notes and writes one line about them. A prompt, so it asks a model.
---

Read your notes: list_notes for what is there, then read_notes for each one.

Write one line saying what they hold, and save it as \`summary.md\` with
write_notes. If there are no notes yet, write that.

Nothing else. This job is here to prove that a model, its tools and your memory
all work, and to be replaced by something you actually want. It has no cron
line, so it runs when you start it and not before.
`;

const IGNORE = `node_modules
data
settings.local.json
.env
`;
