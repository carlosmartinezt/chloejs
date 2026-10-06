// Where the project's chloe.config.ts is, asked without deciding that there has
// to be one: a script that runs one agent needs none, and `npx chloe setup` runs
// before there is one and writes it.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What to say when the server needs one and there is none. */
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
