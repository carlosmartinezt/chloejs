// An agent's memory, as tools: memoryListFiles, memoryReadFile, memorySearchFiles,
// memoryWriteFile and memoryEditFile, all inside the one folder its definition's
// `memory` names (memory/ in its own folder when it names none). Every agent
// has them: the loader adds them, so an agent's `tools` never lists them.
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import * as fs from "./fs.ts";
import { agentOf, ownTools, type ToolContext, type Tools } from "../tool.ts";

/**
 * The five memory tools for one agent's memory. A write is its own commit only
 * when the memory says `commit: true`. With "each run", the end of the run
 * commits everything it wrote.
 */
export function memoryTools(): (agent: { id: string; memory: { folder: string; commit?: boolean | "each run" } }) => Tools {
  return ({ id, memory: { folder, commit } }) => {
    const what = "your memory";
    // A new agent has no folder yet, and the first thing it does should not be
    // to fail on one missing.
    mkdirSync(folder, { recursive: true });
    return ownTools({
      memoryListFiles: fs.listFiles({ root: folder, what }),
      memoryReadFile: fs.readFile({ root: folder, what }),
      memorySearchFiles: fs.searchFiles({ root: folder, what }),
      memoryWriteFile: fs.writeFile({ root: folder, what, commit: commit === true, author: id, memory: true }),
      memoryEditFile: fs.editFile({ root: folder, what, commit: commit === true, author: id, memory: true }),
    });
  };
}

/** The most a note on one user may hold, in characters. */
const NOTE_MOST = 4000;

/**
 * Where an agent's note on one user is, inside its memory:
 * `users/<channel>-<their id there>.md`. One person on two channels is two
 * users, because the runtime knows them only as each channel names them.
 */
export function userNotesFile(memory: string, user: string): string {
  return join(memory, "users", `${user.replace(":", "-").replace(/[^\w.@+-]/g, "_")}.md`);
}

/** An agent's note on one user (`channel:id`), or "" when it has none. */
export async function userNotes(memory: string, user: string): Promise<string> {
  return (await readFile(userNotesFile(memory, user), "utf8").catch(() => "")).trim();
}

/**
 * memoryWriteUserNotes, which replaces the agent's note on the user it is
 * talking to. Which user is the turn's, set by the runtime from who sent the
 * message, never the model's choice, and the note is shown at the top of that
 * user's turns, so there is nothing to read it with.
 */
export function userNotesTools(): () => Tools {
  return () => ownTools({
    memoryWriteUserNotes: tool({
      description:
        "Replace your note on the person you are talking to. This is the whole note, so keep what still matters from " +
        "the one you were shown. Write what will help next time: what they asked about, what they prefer. " +
        "Only in a conversation with somebody.",
      inputSchema: z.object({ notes: z.string().max(NOTE_MOST) }),
      execute: async ({ notes }, { context }) => {
        const user = (context as Partial<ToolContext> | undefined)?.user;
        if (!user) throw new Error("This is not a conversation with anybody, so there is nobody to keep a note on.");
        const file = userNotesFile(agentOf(context).memory.folder, user);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, notes.trim() + "\n");
        return "Kept.";
      },
    }),
  });
}
