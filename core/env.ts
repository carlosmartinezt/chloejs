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
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

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

/** The names .env sets, in the order it sets them. Never a value. */
export function envNames(): string[] {
  return existsSync(FILE) ? Object.keys(readEnvFile(readFileSync(FILE, "utf8"))) : [];
}

/** Where things are kept, read once at startup: not something a page may move. */
const KEPT = new Set(["CHLOE_STATE", "CHLOE_MEMORY", "CHLOE_DB"]);

/**
 * The text of a .env file with each name set to its value, or taken out where
 * the value is `null`, and every other line as it was. Only names that start
 * with `CHLOE_` are taken, less CHLOE_STATE, CHLOE_MEMORY and CHLOE_DB, so
 * nothing written here can change how node or a program it starts behaves. A
 * value has to fit on one line. Throws on the first change that does not fit.
 */
export function changeEnvText(text: string, changes: Record<string, string | null>): string {
  for (const [name, value] of Object.entries(changes)) {
    if (!/^CHLOE_[A-Z0-9_]+$/.test(name)) throw new Error(`${name} is not a name chloe writes: it has to start with CHLOE_ and be capitals, digits and _.`);
    if (KEPT.has(name)) throw new Error(`${name} is where things are kept, and is changed in .env on the machine, then a restart.`);
    if (value !== null && /[\r\n]/.test(value)) throw new Error(`${name}'s value has to fit on one line.`);
  }
  // A value that starts and ends with the same quote is read with them taken
  // off, so it goes in inside the other kind.
  const line = (name: string, value: string) =>
    `${name}=${/^(["']).*\1$/.test(value) ? (value.startsWith('"') ? `'${value}'` : `"${value}"`) : value}`;
  const left = { ...changes };
  const lines = text.split("\n").flatMap((raw) => {
    const name = Object.keys(readEnvFile(raw))[0];
    if (!name || !(name in changes)) return [raw];
    // A name written twice is read at its last line, so the ones after the first go.
    if (!(name in left)) return [];
    const value = left[name];
    delete left[name];
    return value === null ? [] : [line(name, value)];
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [name, value] of Object.entries(left)) if (value !== null) lines.push(line(name, value));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** `changeEnvText` on .env itself, which stays mode 600, and the environment read again from it. */
export function writeEnv(changes: Record<string, string | null>): void {
  writeFileSync(FILE, changeEnvText(existsSync(FILE) ? readFileSync(FILE, "utf8") : "", changes), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  loadEnv();
}

loadEnv();
