// The files a new project starts with, as text, for `npx chloe setup` to write:
// the config with no agents, and what tells a coding agent where the guides are.
// The first agent is written by the person's coding agent, from the guides, for
// what they asked for.
//
// They are text here rather than files on disk because the published package is
// dist/ and a .ts file here would be compiled with the runtime.

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

/** Every file a new project starts with. */
export function starterFiles(): Starter[] {
  return [
    { path: "chloe.config.ts", body: CONFIG },
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
 * in .env a key is read from, written as `process.env.` that name at `where`
 * under `model`, which is the gateway's key unless it says otherwise.
 *
 *   modelLine({ defaultModel: "openai/gpt-6-luna" })  // model: { defaultModel: "openai/gpt-6-luna" },
 *   modelLine({ defaultModel: "openai/gpt-6-luna" }, "OPENAI_API_KEY", ["keys", "openai"])
 *     // model: { defaultModel: "openai/gpt-6-luna", keys: { openai: process.env.OPENAI_API_KEY } },
 */
export function modelLine(model: Record<string, string>, key?: string, where: string[] = ["key"]): string {
  const fields = Object.entries(model).map(([one, value]) =>
    one === "preferredRoute" ? `preferredRoute: ${JSON.stringify(value.split(","))}` : `${one}: ${JSON.stringify(value)}`,
  );
  if (key) fields.push(where.slice(0, -1).reduceRight((inside, part) => `${part}: { ${inside} }`, `${where[where.length - 1]}: process.env.${key}`));
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

const CONFIG = `// Every agent this box runs, and how the runtime behaves.
//
// An agent is declared, never found: one that is not on this list does not
// exist, however finished its folder looks. Each one is a folder in agents/,
// imported here and named in \`agents\`.
//
// \`settings\` is every choice, as deep as it goes, and what it leaves out is the
// default. This file is in source control, so a password, key or token goes in
// .env beside it, and is named here as \`process.env.\` and its name in .env:
// \`connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }\`. chloe reads no key
// it is not handed here.
import { defineConfig } from "@chloejs/core";

export default defineConfig({
  agents: [],
  settings: {
    // Which model an agent asks when its own agent.ts names none.
    ${STARTER_MODEL_LINE}
  },
});
`;

/** Where the guides are in the package, from the project's own folder. */
export const GUIDES = "node_modules/@chloejs/core/dist/docs/README.md";

// What a coding agent reads first in this project, every session: where the
// guides are, so it cannot drift from them (they are the version installed), and
// that the first agent is its to write.
// CLAUDE.md beside it says "@AGENTS.md", which is how Claude Code reads it.
const AGENTS = `# Chloe

This project's agents run on Chloe (@chloejs/core). Before writing or changing
an agent, a job, a tool, a channel or a setting, read

    ${GUIDES}

It lists the guides for the version installed here and what each one covers.
\`npx chloe help\` lists every command.

When chloe.config.ts lists no agents, ask the person what they want done and
write the first agent for it. Once it runs, they can ask it in its chat to
change itself: its words, its jobs and its code.
`;

const IGNORE = `node_modules
data
.env
`;
