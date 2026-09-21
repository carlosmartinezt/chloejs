// An agent's notes: a folder it lists, reads, searches and writes, and keeps
// from one run to the next.
//
//   tools: [memory()]
//   tools: [memory({ folder: "/home/me/notes", what: "my notes", commit: true })]
import { mkdirSync } from "node:fs";

import { listIn, readIn, searchIn, writeIn } from "./files.ts";
import { STATE } from "#chloe/core/paths.ts";
import type { Tools } from "../tool.ts";

interface Options {
  /** The folder it reads and writes. Defaults to data/<agent name>. */
  folder?: string;
  /** How to name that folder when describing these tools to the agent. */
  what?: string;
  /** Commit every write. For a folder that is a git repo. */
  commit?: boolean;
}

/** list_notes, read_notes, search_notes and write_notes, all inside one folder. */
export function memory(options: Options = {}): (agent: { name: string; memory?: string }) => Tools {
  return ({ name, memory: declared }) => {
    // The agent's own memory, as its definition says, so the tool and the site
    // agree on one folder. A folder passed here still wins, for an agent that
    // wants the tool pointed somewhere its memory is not.
    const folder = options.folder ?? declared ?? `${STATE}/${name}`;
    const what = options.what ?? "your own folder";
    // A new agent has no folder yet, and the first thing it does should not be
    // to fail on one missing.
    mkdirSync(folder, { recursive: true });
    return {
      list_notes: listIn({ root: folder, what }),
      read_notes: readIn({ root: folder, what }),
      search_notes: searchIn({ root: folder, what }),
      write_notes: writeIn({ root: folder, what, commit: options.commit }),
    };
  };
}
