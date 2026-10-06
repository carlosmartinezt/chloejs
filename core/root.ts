// Where the project is. Its own file so that paths.ts can read settings: settings
// reads .env, which needs ROOT to find it, and would otherwise import the file
// that imports it.
import { findConfig } from "./find.ts";

/**
 * The folder that holds `chloe.config.ts`, found by walking up from where the
 * process was started, or that folder itself when none above it has one. A
 * script with no config is a project of its own: its `.env`, run history and
 * memories are kept beside where it was started, as they would be beside a config.
 */
export const ROOT = findConfig() || process.cwd();
