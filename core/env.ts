// The .env file beside chloe.config.ts, read into the environment.
//
// This is where a secret goes: every password, key and token, and nothing else.
// It is not in source control, and chloe.config.ts never holds one of them.
//
// The runtime reads no setting from here by itself: the config hands each one
// over by name, as `process.env.CHLOE_CONNECTIONS_RESEND_API_KEY`. The exceptions are where
// things are kept, CHLOE_STATE, CHLOE_MEMORY and CHLOE_DB, read before any config.
//
// A variable that was already in the real environment wins, so
// `CHLOE_MODEL_KEY=... npx chloe` still beats the file. Read again when the file
// changes: what the file set last time is replaced, and what it stopped setting
// is removed, so taking a line out of .env takes effect the same as changing one.
import { existsSync, readFileSync } from "node:fs";

import { ROOT } from "./root.ts";

const FILE = `${ROOT}/.env`;

/** The names this file put into the environment, so a later read can take them back out. */
let mine = new Set<string>();

/**
 * KEY=value a line at a time. A line that is blank, a comment, or has no `=` is
 * passed over. Quotes around the value are taken off, and `export ` in front is
 * allowed so a file that is also sourced by a shell reads the same.
 */
export function readEnvFile(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length > 1 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (name) found[name] = value;
  }
  return found;
}

/**
 * Put .env into process.env, leaving anything the real environment already set.
 * Called before any setting is read, and again when the file changes.
 */
export function loadEnv(): void {
  const found = existsSync(FILE) ? readEnvFile(readFileSync(FILE, "utf8")) : {};
  for (const name of mine) if (!(name in found)) delete process.env[name];
  const now = new Set<string>();
  for (const [name, value] of Object.entries(found)) {
    if (name in process.env && !mine.has(name)) continue;
    process.env[name] = value;
    now.add(name);
  }
  mine = now;
}

loadEnv();
