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
  /**
   * Added to a file that may already be there, rather than written only when it
   * is not: `"lines"` adds each line the file does not have (a .gitignore),
   * `"whole"` adds the body below what is there unless its first line already is.
   */
  add?: "lines" | "whole";
}

/**
 * A name as a variable can be written: "night-watch" imports as nightWatch.
 * Agent names are allowed a dash and an import is not.
 */
export function identifier(agent: string): string {
  return agent.replace(/[-_](.)/g, (_, next: string) => next.toUpperCase());
}

/**
 * What an agent's id may be: lower case, digits and dashes, starting with a
 * letter. It becomes a folder, an import and what the run history is filed
 * under, so it is checked before any of that is written. Empty when it is fine.
 */
export function idProblem(agent: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) return "An id is lower case letters, digits and dashes, and starts with a letter.";
  if (agent.endsWith("-")) return "An id does not end with a dash.";
  return "";
}

/**
 * The same agent.ts with one channel added: the import, and the entry in
 * `channels`. Returns "" for a file that already has a `channels` list, which
 * is somebody's own and is told rather than edited.
 *
 *   withChannel(body, 'import { whatsappChannel } from "@chloejs/core/channels";', 'whatsappChannel({ allowFrom: ["+447700900123"] })')
 */
export function withChannel(file: string, importLine: string, entry: string): string {
  if (!file || file.includes("channels:")) return "";
  const imported = file.replace(/^(import .*from "@chloejs\/core";\n)/m, `$1${importLine}\n`);
  if (imported === file) return "";
  const placed = imported.replace(/\n\}\);\s*$/, `\n  channels: [${entry}],\n});\n`);
  return placed === imported ? "" : placed;
}

/** Every file a new project starts with. `agent` is the name it chose. */
export function starterFiles(agent: string): Starter[] {
  return [
    { path: "chloe.config.ts", body: config(agent) },
    { path: `agents/${agent}/agent.ts`, body: definition(agent) },
    { path: `agents/${agent}/instructions.md`, body: instructions(agent) },
    { path: `agents/${agent}/jobs/daily-note.ts`, body: DAILY_NOTE },
    { path: `agents/${agent}/jobs/summary.md`, body: SUMMARY },
    { path: ".gitignore", body: IGNORE, add: "lines" },
    { path: "AGENTS.md", body: AGENTS, add: "whole" },
    { path: "CLAUDE.md", body: "@AGENTS.md\n", add: "whole" },
  ];
}

/**
 * The line in the starter config that setup replaces with the model it chose.
 * Somebody's own config does not have it, and is told what to add instead.
 */
export const STARTER_MODEL_LINE = '// model: { defaultModel: "anthropic/claude-sonnet-5" },';

/**
 * The model settings setup chose, as the line that goes in chloe.config.ts.
 * `preferredRoute` arrives comma separated and is written as a list. `key` is the name
 * in .env the gateway key is read from, written as `process.env.` that name.
 *
 *   modelLine({ defaultModel: "openai/gpt-6-luna" })  // model: { defaultModel: "openai/gpt-6-luna" },
 */
export function modelLine(model: Record<string, string>, key?: string): string {
  const fields = Object.entries(model).map(([one, value]) =>
    one === "preferredRoute" ? `preferredRoute: ${JSON.stringify(value.split(","))}` : `${one}: ${JSON.stringify(value)}`,
  );
  if (key) fields.push(`key: process.env.${key}`);
  return `model: { ${fields.join(", ")} },`;
}

/**
 * A line into the `settings` of the chloe.config.ts setup wrote, under the
 * model line, or null when the file is somebody's own or already has it, which
 * the caller then says rather than edits.
 */
export function withSetting(config: string, line: string): string | null {
  const top = line.split(":")[0];
  if (config.includes(line) || new RegExp(`^    ${top}:`, "m").test(config)) return null;
  const at = config.indexOf("  settings: {\n");
  if (at < 0) return null;
  const after = at + "  settings: {\n".length;
  return `${config.slice(0, after)}    ${line}\n${config.slice(after)}`;
}

const config = (agent: string) => `// Every agent this box runs, and how the runtime behaves.
//
// An agent is declared, never found: one that is not on this list does not
// exist, however finished its folder looks.
//
// \`settings\` is every choice, as deep as it goes, and what it leaves out is the
// default. This file is in source control, so a password, key or token goes in
// .env beside it, and is named here as \`process.env.\` and its name in .env:
// \`connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }\`. chloe reads no key
// it is not handed here.
import { defineConfig } from "@chloejs/core";

import ${identifier(agent)} from "./agents/${agent}/agent.ts";

export default defineConfig({
  agents: [${identifier(agent)}],
  settings: {
    // Which model an agent asks when its own agent.ts names none.
    ${STARTER_MODEL_LINE}
  },
});
`;

const definition = (agent: string) => `// What this agent is, in one file: its words, its jobs, its tools, and every
// way it can be reached. Nothing in the folder is found by looking except
// skills/, so a job that is written and not named below never runs.
import { defineAgent, markdownJob, prompt } from "@chloejs/core";

import dailyNote from "./jobs/daily-note.ts";

export default defineAgent({
  id: "${agent}",
  description: "The agent npx chloe setup wrote. Make it yours.",
  instructions: prompt("instructions.md"),
  // Which model it asks is model.defaultModel in chloe.config.ts, so it is written
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
// Work happens inside a step. A finished step is written down and replayed, not
// run again, so a run that stops halfway and carries on later does not write the
// day twice.
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

Read your notes: memoryListFiles for what is there, then memoryReadFile for each one.

Write one line saying what they hold, and save it as \`summary.md\` with
memoryWriteFile. If there are no notes yet, write that.

Nothing else. This job is here to prove that a model, its tools and your memory
all work, and to be replaced by something you actually want. It has no cron
line, so it runs when you start it and not before.
`;

/** Where the guides are in the package, from the project's own folder. */
export const GUIDES = "node_modules/@chloejs/core/dist/docs/README.md";

// What a coding agent reads first in this project, every session. Only where
// the guides are, so it cannot drift from them: they are the version installed.
// CLAUDE.md beside it says "@AGENTS.md", which is how Claude Code reads it.
const AGENTS = `# Chloe

This project's agents run on Chloe (@chloejs/core). Before writing or changing
an agent, a job, a tool, a channel or a setting, read

    ${GUIDES}

It lists the guides for the version installed here and what each one covers.
\`npx chloe help\` lists every command.
`;

const IGNORE = `node_modules
data
.env
`;
