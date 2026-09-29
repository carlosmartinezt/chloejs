// Where the project is, asked without deciding that there has to be one.
//
// Its own file because a module that throws as it loads stays thrown: node
// keeps the failure and hands it to the next import. `npx chloe setup` runs
// before there is a chloe.config.ts and writes one, so anything that asked
// root.ts first would spend the rest of the process believing there was none.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What to say when there is none. Said by root.ts, and by the CLI before it offers to write one. */
export const NO_CONFIG = "It lists the agents to run, and chloe is started from beside it.";

/**
 * The folder holding `chloe.config.ts`, walking up from `from`, or "" when no
 * folder above it has one.
 */
export function findConfig(from = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "chloe.config.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "";
}
