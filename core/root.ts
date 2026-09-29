// Where the repo is. Its own file so that paths.ts can read settings: settings
// needs ROOT to find the two settings files, and would otherwise import the
// file that imports it.
import { findConfig, NO_CONFIG } from "./find.ts";

/**
 * The folder that holds `chloe.config.ts`, found by walking up from where the
 * process was started.
 */
export const ROOT = mustBeSomewhere();

function mustBeSomewhere(): string {
  const found = findConfig();
  if (!found) throw new Error(`No chloe.config.ts at or above ${process.cwd()}. ${NO_CONFIG}`);
  return found;
}
