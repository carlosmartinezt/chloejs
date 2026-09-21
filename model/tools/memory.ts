// An agent's memory, as tools: list_notes, read_notes, search_notes and
// write_notes, all inside the one folder its definition's `memory` names
// (its own folder under the state directory when it names none). Every agent
// has them: the loader adds them, so an agent's `tools` never lists them.
import { mkdirSync } from "node:fs";

import { listIn, readIn, searchIn, writeIn } from "./files.ts";
import type { Tools } from "../tool.ts";

/** The four notes tools for one agent's memory. A write is a git commit when `commit` says so. */
export function memoryTools(memory: { folder: string; commit?: boolean }): Tools {
  const { folder, commit } = memory;
  const what = "your memory";
  // A new agent has no folder yet, and the first thing it does should not be
  // to fail on one missing.
  mkdirSync(folder, { recursive: true });
  return {
    list_notes: listIn({ root: folder, what }),
    read_notes: readIn({ root: folder, what }),
    search_notes: searchIn({ root: folder, what }),
    write_notes: writeIn({ root: folder, what, commit }),
  };
}
