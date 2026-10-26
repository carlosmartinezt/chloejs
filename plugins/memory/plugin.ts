// Memory: the tools an agent keeps notes with in its memory folder, and a note
// on each person it talks to. The folder itself, and its history, are every
// agent's: this is only how a model reaches it.
import type { Plugin, Reply } from "#chloe/load/plugin";
import type { Agent } from "#chloe/load/load";
import { dashboardAddress } from "#chloe/core/turn";
import { memoryTools, userNotes, userNotesTools } from "./tools.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the memory tools: `memoryListFiles`, `memoryReadFile`,
     * `memorySearchFiles` and `memoryEditFile`. They work on
     * the agent's memory folder (see `memory` on the agent). On by default.
     */
    memory?: boolean;
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
}

export const memory: Plugin = {
  name: "memory",
  abilities: [
    {
      name: "memory",
      label: "Memory",
      on: true,
      does: "Keeps notes in its memory folder, so one run can leave the next better informed.",
      tools: ["memoryListFiles", "memoryReadFile", "memorySearchFiles", "memoryEditFile"],
      make: (home) => memoryTools()(home),
    },
    {
      name: "memoryPerUser",
      label: "Memory per user",
      on: false,
      does: "Keeps a note on each person it talks to, and reads it before each reply to them.",
      tools: ["memoryWriteUserNotes"],
      make: () => userNotesTools()(),
    },
  ],
  async words(agent, reply) {
    const sections = [
      { about: "Links to your memory", text: memoryLinks(agent, reply) },
      { about: "Your note on them", text: await noteOn(agent, reply) },
    ];
    return sections.filter((one) => one.text);
  },
};

/** How to link to a file in its memory on the dashboard. Empty for a guest's turn and for an agent without its memory tools. */
function memoryLinks(agent: Agent, { tools, guest }: Reply): string {
  if (guest || !tools.memoryReadFile) return "";
  const at = `${dashboardAddress()}/agents/${agent.id}/memory`;
  return (
    `A file in your memory opens on the dashboard at ${at}/<its path in your memory>. Only your owner can open it.` +
    (dashboardAddress() ? "" : " The dashboard's address is not set (serve.url in chloe.config.ts), so give this path and say it goes after that address.")
  );
}

/** Its note on the person this reply is to, in the purpose rather than the message, so it is not kept in the conversation again each turn. */
async function noteOn(agent: Agent, { tools, user }: Reply): Promise<string> {
  return user && tools.memoryWriteUserNotes ? await userNotes(agent.memory.folder, user) : "";
}
