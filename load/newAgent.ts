// The files a new agent starts with: an agent.ts, and a purpose that tells it
// to change itself into whatever its owner asks. `npx chloe setup` writes them
// for a project's first agent, and the page for each agent made there. They are
// text, with no imports, so setup can read them before there is a config.

/** What a new agent is given. */
export interface NewAgent {
  /** Its id: its folder's name, and what its runs are kept under. */
  id: string;
  /** The name the page shows, when it is not the id. */
  name?: string;
  /** Its model, when it is not the copy's `model.defaultModel`. */
  model?: string;
  /** Turns on `abilities.shell`, which loads only in a machine of its own. */
  shell?: boolean;
  /** Where it works, as code for its agent.ts, like `{ sandbox: { type: "podman" } }`, when it runs in a machine of its own. */
  workspace?: string;
}

/** What an id may be: lower case letters, digits and dashes, starting with a letter. */
export const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** The agent's files, by their path inside its folder. */
export function newAgentFiles(agent: NewAgent): Record<string, string> {
  const lines = [
    `  id: ${JSON.stringify(agent.id)},`,
    ...(agent.name && agent.name !== agent.id ? [`  name: ${JSON.stringify(agent.name)},`] : []),
    ...(agent.model ? [`  model: ${JSON.stringify(agent.model)},`] : []),
    `  identity: "Just set up. Tell it what you want done, and it changes itself to do it.",`,
    `  purpose: prompt("purpose.md"),`,
    ...(agent.shell ? ["  abilities: { shell: true },"] : []),
    ...(agent.workspace ? [`  workspace: ${agent.workspace},`] : []),
  ];
  return {
    "agent.ts": `// A new agent. Talk to it on the page and ask it to change: its purpose,
// its jobs, its code. Each change it makes is a commit you can read and
// undo there.
import { defineAgent, prompt } from "@chloejs/core";

export default defineAgent({
${lines.join("\n")}
});
`,
    "purpose.md": agent.shell ? PURPOSE + IN_A_MACHINE : PURPOSE,
  };
}

const PURPOSE = `You were set up a moment ago, and you do nothing yet: you have no jobs and no
tools of your own.

When your owner asks for something, do it with what you have. When you cannot
yet, change yourself so you can: this purpose, a job, a tool, whatever it
takes. Say what you changed.

Once you know what you are for, rewrite this purpose to say so.

Keep replies short.
`;

const IN_A_MACHINE = `
You run in a machine of your own, with a shell. Clone, build and try things
there, one folder per piece of work.
`;
