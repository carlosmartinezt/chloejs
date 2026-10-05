// An agent's memory, as tools: memoryListFiles, memoryReadFile, memorySearchFiles,
// memoryWriteFile and memoryEditFile, all inside the one folder its definition's
// `memory` names (memory/ in its own folder when it names none). Every agent
// has them: the loader adds them, so an agent's `tools` never lists them.
import { mkdirSync } from "node:fs";

import * as fs from "./fs.ts";
import type { Tools } from "../tool.ts";

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
    return {
      memoryListFiles: fs.listFiles({ root: folder, what }),
      memoryReadFile: fs.readFile({ root: folder, what }),
      memorySearchFiles: fs.searchFiles({ root: folder, what }),
      memoryWriteFile: fs.writeFile({ root: folder, what, commit: commit === true, author: id, memory: true }),
      memoryEditFile: fs.editFile({ root: folder, what, commit: commit === true, author: id, memory: true }),
    };
  };
}
