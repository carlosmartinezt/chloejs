// chloe.config.ts, read and written from the page. A save is loaded as the
// next reload would load it, and type checked when the project has
// TypeScript, and put back with the reason when either fails.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { envNames, writeEnv } from "#chloe/core/env";
import { DEFAULTS, KEYS, nameInEnv, settings } from "#chloe/core/settings";
import { checkFirst, CONFIG, loadAll } from "#chloe/load/load";
import { typeProblems } from "#chloe/services/selfService";
import { NotFound } from "./errors.ts";

/** The text of chloe.config.ts. */
export async function configText(): Promise<string> {
  if (!existsSync(CONFIG)) throw new NotFound("There is no chloe.config.ts: this copy was started with its agents in a script.");
  return readFile(CONFIG, "utf8");
}

/**
 * Writes chloe.config.ts. When the agents it lists would not load, or it does
 * not type check, the file is put back as it was and the reason thrown.
 */
export async function saveConfig(text: string): Promise<void> {
  const before = await configText();
  await checkFirst(async () => {
    await writeFile(CONFIG, text);
    let problem = "";
    try {
      await loadAll();
      const types = await typeProblems(CONFIG);
      if (types) problem = `it does not type check:\n${types}`;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (!problem) return;
    await writeFile(CONFIG, before);
    // The failed read may have declared its settings: read the old ones back now, not at the next reload.
    await loadAll().catch(() => undefined);
    throw new Error(`chloe.config.ts is put back as it was, because ${problem}`);
  });
}

/** Each name .env sets, and whether chloe.config.ts hands it over as `process.env.<name>`. */
export async function keysUsed(): Promise<{ name: string; inConfig: boolean }[]> {
  const config = existsSync(CONFIG) ? await readFile(CONFIG, "utf8") : "";
  return envNames().map((name) => ({ name, inConfig: new RegExp(`process\\.env\\.${name}\\b|process\\.env\\[["']${name}["']\\]`).test(config) }));
}

// The Configuration page's forms. Each changes one value at a known place in
// chloe.config.ts's `settings`, and leaves every other character of the file
// as it was, comments included. A place written as code (a variable, a
// spread, a call) is not the page's to rewrite, and is refused as `InCode`,
// so the page opens the file as text instead. A secret goes in .env and the
// config names it as `process.env.<name>`.

/** That setting is written as code in chloe.config.ts, so only an edit to the file changes it. */
export class InCode extends Error {}

/** One setting as the Configuration page shows it. A secret's value is never here. */
export interface Field {
  /** The setting, as a path with dots, like "connections.google.account". */
  path: string;
  /** A password, key or token: kept in .env and named in the config. */
  secret: boolean;
  /** "", 0 or false is unset. A secret is set when it has a value. */
  set: boolean;
  /** What it is now, the default when the file does not say. Never a secret's. */
  value?: unknown;
  /** Where it is said: not at all, as a plain value, as `process.env.<key>`, or as code the page leaves alone. */
  written: "default" | "file" | "env" | "code";
  /** The name in .env, when `written` is "env". */
  key?: string;
}

/** Each setting the page may change, with its default. `agents` is each agent's own, and `node` and `serve` are for the machine. */
function leaves(): { path: string[]; was: unknown }[] {
  const out: { path: string[]; was: unknown }[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inside] of Object.entries(value)) walk(inside, [...path, key]);
    } else out.push({ path, was: value });
  };
  for (const [key, value] of Object.entries(DEFAULTS)) if (!["agents", "node", "serve"].includes(key)) walk(value, [key]);
  return out;
}

const isSecret = (path: string[]) => KEYS.some((key) => path.join(".") === key || path.join(".").startsWith(`${key}.`));

const leafOf = (from: unknown, path: string[]): unknown =>
  path.reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), from);

/** Every setting the page may change, read from chloe.config.ts and what the runtime has now. */
export async function configFields(): Promise<Field[]> {
  const text = await configText();
  return leaves().map(({ path }) => {
    const secret = isSecret(path);
    const now = leafOf(settings, path);
    const said = valueAt(text, path);
    const env = said.kind === "value" ? envName(said.text) : undefined;
    const written = said.kind === "absent" ? "default" : said.kind === "code" ? "code" : env ? "env" : literal(said.text) === undefined ? "code" : "file";
    const set = Array.isArray(now) ? now.length > 0 : Boolean(now);
    return { path: path.join("."), secret, set, ...(secret ? {} : { value: now }), written, ...(env ? { key: env } : {}) };
  });
}

/**
 * Changes settings in chloe.config.ts, all in one save: each value is put in
 * place, or taken out where it is `null`, which puts the default back. A
 * secret's value goes in .env, under the name the config already reads it
 * from or the suggested one, and the config names it. Refused when the path
 * is not a setting the page may change, the value is the wrong kind, or the
 * place is code (`InCode`). The save is loaded and type checked as any
 * other, and .env is put back too when it fails.
 */
export async function changeSettings(changes: { path: string; value: unknown }[]): Promise<void> {
  let text = await configText();
  const known = new Map(leaves().map((one) => [one.path.join("."), one.was]));
  const env: Record<string, string | null> = {};
  for (const { path: dotted, value } of changes) {
    if (!known.has(dotted)) throw new Error(`${dotted} is not a setting this page changes.`);
    const path = dotted.split(".");
    const was = known.get(dotted);
    if (value === null) {
      const said = valueAt(text, path);
      const key = said.kind === "value" ? envName(said.text) : undefined;
      if (isSecret(path) && key) env[key] = null;
      text = setInConfig(text, path, null);
      continue;
    }
    if (isSecret(path)) {
      let given = String(value).trim();
      // A Google client file is JSON over many lines, and .env holds one.
      if (given.startsWith("{")) {
        try {
          given = JSON.stringify(JSON.parse(given));
        } catch {
          throw new Error(`${dotted} looks like JSON and is not: paste the whole file.`);
        }
      }
      if (!given) throw new Error(`${dotted} is empty. Take it out instead.`);
      const said = valueAt(text, path);
      const key = (said.kind === "value" && envName(said.text)) || nameInEnv(path);
      env[key] = given;
      text = setInConfig(text, path, `process.env.${key}`);
      continue;
    }
    const kind = Array.isArray(was) ? "list" : typeof was;
    const fits = kind === "list" ? Array.isArray(value) && value.every((one) => typeof one === "string") : typeof value === kind;
    if (!fits) throw new Error(`${dotted} takes ${kind === "list" ? "a list of words" : kind === "string" ? "words" : `a ${kind}`}.`);
    text = setInConfig(text, path, JSON.stringify(value));
  }
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key] ?? null]));
  if (Object.keys(env).length) writeEnv(env);
  try {
    await saveConfig(text);
  } catch (error) {
    if (Object.keys(env).length) writeEnv(before);
    throw error;
  }
}

/** The name in `process.env.NAME` or `process.env["NAME"]`, when that is the whole of the value. */
export function envName(value: string): string | undefined {
  return /^process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])$/.exec(value.trim())?.slice(1).find(Boolean);
}

/** A plain value written in the file (words, a number, true or false, a list of words), or undefined when it is code. */
export function literal(value: string): unknown {
  const plain = value.trim();
  try {
    return JSON.parse(plain.startsWith("'") && plain.endsWith("'") ? JSON.stringify(plain.slice(1, -1)) : plain);
  } catch {
    return undefined;
  }
}

/**
 * Where a setting is in the text: not there, written as code that hides it
 * (a spread, or a group that is not written out), or its value's text.
 */
export function valueAt(text: string, path: string[]): { kind: "absent" } | { kind: "code" } | { kind: "value"; text: string } {
  let open = settingsObject(text);
  if (open === undefined) return { kind: "absent" };
  if (open === null) return { kind: "code" };
  for (const [i, key] of path.entries()) {
    const all = entries(text, open);
    const found = all.find((one) => one.key === key);
    if (!found) return all.some((one) => one.key === null) ? { kind: "code" } : { kind: "absent" };
    const value = text.slice(found.valueStart, found.valueEnd);
    if (i === path.length - 1) return { kind: "value", text: value };
    if (text[found.valueStart] !== "{") return { kind: "code" };
    open = found.valueStart;
  }
  return { kind: "absent" };
}

/**
 * The text with the setting at `path` set to `value`, which is TypeScript as
 * it will be written (`"words"`, `process.env.NAME`), or taken out when it is
 * `null`. A group that is not there is written in. Throws `InCode` when the
 * place is code: a spread beside it, or a group that is not an object written
 * out.
 */
export function setInConfig(text: string, path: string[], value: string | null): string {
  const open = settingsObject(text);
  if (open === null) throw new InCode("chloe.config.ts's settings are written as code, so they are changed in the file.");
  if (open === undefined) {
    if (value === null) return text;
    const config = configObject(text);
    if (config === undefined) throw new InCode("chloe.config.ts has no defineConfig({ ... }) to add settings to.");
    return put(text, config, ["settings", ...path], value);
  }
  return put(text, open, path, value);
}

function put(text: string, open: number, path: string[], value: string | null): string {
  const all = entries(text, open);
  const [key, ...rest] = path;
  const found = all.find((one) => one.key === key);
  if (!found && all.some((one) => one.key === null)) {
    throw new InCode(`${key} may be set by code beside it in chloe.config.ts, so it is changed in the file.`);
  }
  if (!found) {
    if (value === null) return text;
    return insert(text, open, all, `${said(key)}: ${rest.reduceRight((inside, part) => `{ ${said(part)}: ${inside} }`, value)}`);
  }
  if (rest.length) {
    if (text[found.valueStart] !== "{") throw new InCode(`${key} is written as code in chloe.config.ts, so it is changed in the file.`);
    return put(text, found.valueStart, rest, value);
  }
  if (value !== null) return text.slice(0, found.valueStart) + value + text.slice(found.valueEnd);
  return remove(text, found);
}

/** A key as written: plain when it can be, quoted when not. */
const said = (key: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key));

/** Adds `entry` to the object opening at `open`, after its last entry, in the way that object is laid out. */
function insert(text: string, open: number, all: Entry[], entry: string): string {
  const close = closing(text, open);
  const inner = text.slice(open + 1, close);
  if (!all.length) {
    if (!inner.trim()) return `${text.slice(0, open + 1)} ${entry} ${text.slice(close)}`;
    return `${text.slice(0, open + 1)}\n${indentAt(text, open)}  ${entry},${text.slice(open + 1)}`;
  }
  const last = all[all.length - 1];
  const comma = text.slice(last.valueEnd, last.end).includes(",");
  if (!inner.includes("\n")) {
    return comma ? `${text.slice(0, last.end)} ${entry},${text.slice(last.end)}` : `${text.slice(0, last.valueEnd)}, ${entry}${text.slice(last.valueEnd)}`;
  }
  // After anything on the last entry's line, a comment included, so the comment stays with its entry.
  const after = Math.max(last.end, last.valueEnd);
  const lineEnd = text.indexOf("\n", after);
  const at = lineEnd === -1 || lineEnd > close ? after : lineEnd;
  const line = `\n${indentAt(text, last.start)}${entry},`;
  if (comma) return text.slice(0, at) + line + text.slice(at);
  return text.slice(0, last.valueEnd) + "," + text.slice(last.valueEnd, at) + line + text.slice(at);
}

/** Takes an entry out, with its line when it had the line to itself. */
function remove(text: string, found: Entry): string {
  const lineStart = text.lastIndexOf("\n", found.start - 1) + 1;
  const lineEnd = text.indexOf("\n", found.end);
  const alone = !text.slice(lineStart, found.start).trim() && !text.slice(found.end, lineEnd === -1 ? text.length : lineEnd).trim();
  if (alone) return text.slice(0, lineStart) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
  return text.slice(0, found.start) + text.slice(found.end).replace(/^[ \t]+/, "");
}

/** The spaces in front of the line that `at` is on. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** Where the object given to `defineConfig(` (or `export default`) opens. */
function configObject(text: string): number | undefined {
  const call = /defineConfig\s*\(\s*\{|export\s+default\s+\{/.exec(blank(text));
  return call ? call.index + call[0].length - 1 : undefined;
}

/** Where `settings: {` opens, undefined when the config has none, and null when it is code. */
function settingsObject(text: string): number | null | undefined {
  const config = configObject(text);
  if (config === undefined) return null;
  const all = entries(text, config);
  const found = all.find((one) => one.key === "settings");
  if (!found) return all.some((one) => one.key === null) ? null : undefined;
  return text[found.valueStart] === "{" ? found.valueStart : null;
}

interface Entry {
  /** null for a spread or a key worked out by code. */
  key: string | null;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** Past its comma, when it has one. */
  end: number;
}

/** The entries of the object literal opening at `open`, read at its own depth. */
function entries(text: string, open: number): Entry[] {
  const flat = blank(text);
  const close = closing(text, open);
  const out: Entry[] = [];
  let i = open + 1;
  while (i < close) {
    while (i < close && /\s/.test(flat[i])) i++;
    if (i >= close) break;
    const start = i;
    let key: string | null = null;
    const word = /^(?:([A-Za-z_$][A-Za-z0-9_$]*)|"([^"]*)"|'([^']*)')\s*:/.exec(text.slice(i, close));
    // A quoted key is blanked in `flat`, so it is read from the text itself.
    if (word && flat.slice(i, i + word[0].length).trim().endsWith(":")) {
      key = word[1] ?? word[2] ?? word[3];
      i += word[0].length;
    }
    while (i < close && /\s/.test(flat[i])) i++;
    const valueStart = i;
    let depth = 0;
    while (i < close) {
      const c = flat[i];
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === "," && depth === 0) break;
      i++;
    }
    let valueEnd = i;
    while (valueEnd > valueStart && /\s/.test(flat[valueEnd - 1])) valueEnd--;
    const end = i < close ? i + 1 : valueEnd;
    out.push({ key, start, valueStart, valueEnd, end });
    i = end;
  }
  return out;
}

/** Where the bracket opening at `open` closes, read past strings and comments. */
function closing(text: string, open: number): number {
  const flat = blank(text);
  let depth = 0;
  for (let i = open; i < flat.length; i++) {
    if ("{[(".includes(flat[i])) depth++;
    else if ("}])".includes(flat[i]) && --depth === 0) return i;
  }
  throw new InCode("chloe.config.ts has a bracket that does not close.");
}

const blanked = new Map<string, string>();

/**
 * The text with every comment turned to spaces and every string and template
 * to _, at the same length, so a brace or a comma inside one is not read as code. A
 * template's `${ }` is kept, since it is code.
 */
function blank(text: string): string {
  const kept = blanked.get(text);
  if (kept !== undefined) return kept;
  const out = text.split("");
  // A comment becomes spaces, and words become _, so the end of a value is still where its words end.
  const wipe = (from: number, to: number, by = "_") => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = by;
  };
  const template = (from: number): number => {
    let i = from + 1;
    let begin = i;
    while (i < text.length && text[i] !== "`") {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "$" && text[i + 1] === "{") {
        wipe(begin, i);
        i = code(i + 2, "}");
        begin = i;
      } else i++;
    }
    wipe(begin, i);
    return i + 1;
  };
  const code = (from: number, until?: string): number => {
    let i = from;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (until && depth === 0 && c === until) return i + 1;
      if (c === "/" && text[i + 1] === "/") {
        const end = text.indexOf("\n", i);
        wipe(i, end === -1 ? text.length : end, " ");
        i = end === -1 ? text.length : end;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        wipe(i, end === -1 ? text.length : end + 2, " ");
        i = end === -1 ? text.length : end + 2;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        wipe(i, j + 1);
        i = j + 1;
      } else if (c === "`") {
        i = template(i);
      } else {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
    }
    return i;
  };
  code(0);
  const done = out.join("");
  if (blanked.size > 20) blanked.clear();
  blanked.set(text, done);
  return done;
}
