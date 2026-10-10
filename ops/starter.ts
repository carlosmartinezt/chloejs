// The files a new project starts with, as text, for `npx chloe setup` to write:
// the config, a first agent with nothing but instructions, tsconfig.json and
// .gitignore. The agent is there to be talked to on the page and asked to
// change itself into whatever its owner wants.
//
// They are text here rather than files on disk because the published package is
// dist/ and a .ts file here would be compiled with the runtime.

/** One file to write: where it goes, and what goes in it. */
export interface Starter {
  path: string;
  body: string;
  /** Each line the file does not have is added to it, rather than the file written only when it is not there (a .gitignore). */
  add?: "lines";
  /** Written only when the config is, because that config is what lists it (the first agent's files). */
  withConfig?: true;
}

/** The first agent's id, which is its folder and what its runs are kept under. */
export const STARTER_AGENT = "assistant";

/** Every file a new project starts with. */
export function starterFiles(): Starter[] {
  return [
    { path: "chloe.config.ts", body: CONFIG },
    { path: `agents/${STARTER_AGENT}/agent.ts`, body: AGENT, withConfig: true },
    { path: `agents/${STARTER_AGENT}/instructions.md`, body: INSTRUCTIONS, withConfig: true },
    { path: "tsconfig.json", body: TSCONFIG },
    { path: ".gitignore", body: IGNORE, add: "lines" },
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

const CONFIG = `// The agents this project runs, and its settings. A key goes in .env, read here as process.env.NAME.
import { defineConfig } from "@chloejs/core";

import ${STARTER_AGENT} from "./agents/${STARTER_AGENT}/agent.ts";

export default defineConfig({
  agents: [${STARTER_AGENT}],
  settings: {
    ${STARTER_MODEL_LINE}
  },
});
`;

const AGENT = `// Your first agent. Talk to it on the page and ask it to change: its
// instructions, its jobs, its code. Each change it makes is a commit you can
// read and undo there.
import { defineAgent, prompt } from "@chloejs/core";

export default defineAgent({
  id: "${STARTER_AGENT}",
  description: "Just set up. Tell it what you want done, and it changes itself to do it.",
  instructions: prompt("instructions.md"),
});
`;

const INSTRUCTIONS = `You were set up a moment ago, and you do nothing yet: you have no jobs and no
tools of your own.

When your owner says what they want done, read the guides, then change yourself
to do it: these instructions, a job, a tool, whatever it takes. Make one small
change at a time, and say what you changed.

Once you know what you are for, rewrite these instructions to say so.

Keep replies short.
`;

// What the editor and tsc read the project's TypeScript with. Node runs it
// directly, stripping the types, so tsc only checks: nothing is compiled, and
// anything node cannot strip (an enum, a namespace) is an error here instead.
// selfWriteFile type checks an agent's own change with it.
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "exclude": ["node_modules", "data"]
}
`;

/** What the project needs installed for its editor and tsc to read it: node's own names, like process, and tsc. */
export const DEV_PACKAGES = ["typescript", "@types/node"];

/** Where the guides are in the package, from the project's own folder. */
export const GUIDES = "node_modules/@chloejs/core/dist/docs/README.md";

const IGNORE = `node_modules
data
.env
`;
