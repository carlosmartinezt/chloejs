// An agent's memory, as tools: listNotes, readNotes, searchNotes,
// writeNotes and editNotes, all inside the one folder its definition's
// `memory` names (memory/ in its own folder when it names none). Every agent
// has them: the loader adds them, so an agent's `tools` never lists them.
import { mkdirSync } from "node:fs";

import { editIn, listIn, readIn, searchIn, writeIn } from "./files.ts";
import type { Tools } from "../tool.ts";

/**
 * The five notes tools for one agent's memory. A write is its own commit only
 * when the memory says `commit: true`. With "each run", the end of the run
 * commits everything it wrote.
 */
export function memoryTools(): (agent: { name: string; memory: { folder: string; commit?: boolean | "each run" } }) => Tools {
  return ({ name, memory: { folder, commit } }) => {
    const what = "your memory";
    // A new agent has no folder yet, and the first thing it does should not be
    // to fail on one missing.
    mkdirSync(folder, { recursive: true });
    return {
      listNotes: listIn({ root: folder, what }),
      readNotes: readIn({ root: folder, what }),
      searchNotes: searchIn({ root: folder, what }),
      writeNotes: writeIn({ root: folder, what, commit: commit === true, author: name, memory: true }),
      editNotes: editIn({ root: folder, what, commit: commit === true, author: name, memory: true }),
    };
  };
}
