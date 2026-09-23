// Where the repo is. Its own file so that paths.ts can read settings: settings
// needs ROOT to find the two settings files, and would otherwise import the
// file that imports it.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The repo root: the folder that holds chloe.config.ts, walking up from the
 * running process. data/ and the settings files are found beside it.
 */
function findRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "chloe.config.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`No chloe.config.ts at or above ${process.cwd()}. Start the agents from inside the repo.`);
}

/**
 * The folder that holds `chloe.config.ts`, found by walking up from where the
 * process was started.
 */
export const ROOT = findRoot();
