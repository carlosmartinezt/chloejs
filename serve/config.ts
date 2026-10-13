// chloe.config.ts, and the abilities in an agent's agent.ts, read and written
// from the page. A save is loaded as the next reload would load it, and type
// checked when the project has TypeScript, and put back with the reason when
// either fails.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { envNames, writeEnv } from "#chloe/core/env";
import { DEFAULTS, KEYS, nameInEnv, settings } from "#chloe/core/settings";
import { checkFirst, CONFIG, ABILITIES, loadAgain, loadAll, type Agent, type Home } from "#chloe/load/load";
import { defaultOf, fits, takes, type OptionSpec } from "#chloe/load/options";
import { typeProblems } from "#chloe/services/selfService";
import { BadRequest, NotFound } from "./errors.ts";

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

/** Each setting the page may change, with its default. `agents` is each agent's own, and `node`, `serve.host` and `serve.port` are for the machine. */
function leaves(): { path: string[]; was: unknown }[] {
  const out: { path: string[]; was: unknown }[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inside] of Object.entries(value)) walk(inside, [...path, key]);
    } else out.push({ path, was: value });
  };
  for (const [key, value] of Object.entries(DEFAULTS)) if (!["agents", "node", "serve"].includes(key)) walk(value, [key]);
  out.push({ path: ["serve", "url"], was: DEFAULTS.serve.url });
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
  // A channel's tokens are under the agent that has the channel.
  const { CHANNELS } = await import("#chloe/channels/catalog");
  for (const { path } of changes) {
    const [top, id, ...rest] = path.split(".");
    if (top === "agents" && id && CHANNELS.some((kind) => kind.secrets.some((one) => one.path === rest.join(".")))) known.set(path, "");
  }
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

/**
 * Changes one of an agent's abilities in its agent.ts, and hands back the
 * agent as it now loads: `on` switches it, and `set` gives its fields, each a
 * value or `null` to put the default back. The file says an ability only where
 * it differs from what the ability is unsaid. Refused as `InCode` where the
 * file writes it as code.
 */
export async function changeAbility(agent: Home, name: string, change: { on?: boolean; set?: Record<string, unknown> }): Promise<Agent> {
  const ability = ABILITIES.find((one) => one.name === name);
  if (!ability) throw new BadRequest(`There is no ability called ${name}. There are ${ABILITIES.map((one) => one.name).join(", ")}.`);
  const set = checked(ability.fields ?? [], change.set, `abilities.${name}`);
  return changeAgentFile(agent, (text) => {
    const out = setOptionsIn(text, "abilities", name, { on: change.on, set }, ability.on);
    // Switching it on brings every tool it adds with it, so the switch and its
    // tools' switches agree: off means all of it, on means all of it.
    return change.on === true ? outOfWithout(out, ability.tools) : out;
  });
}

/** The text with these tool names taken out of `without`, leaving a list written as code alone. */
function outOfWithout(text: string, names: string[]): string {
  const at = agentObject(text);
  const found = entries(text, at).find((one) => one.key === "without");
  if (!found) return text;
  const now = literal(text.slice(found.valueStart, found.valueEnd));
  if (!Array.isArray(now) || now.some((one) => typeof one !== "string")) return text;
  const list = now.filter((one) => !names.includes(one));
  return list.length === now.length ? text : put(text, at, ["without"], list.length ? `[${list.map((one) => JSON.stringify(one)).join(", ")}]` : null, "agent.ts");
}

/**
 * Changes one of an agent's channels in its agent.ts, and hands back the agent
 * as it now loads: `on` adds or removes its call in `channels`, `set` gives
 * the plain options inside the call, and `secrets` gives the tokens it needs,
 * each by its path under `agents.<id>`, which go to .env and are named in the
 * config. A channel the file writes some other way is the file's.
 */
export async function changeChannel(
  agent: Home,
  name: string,
  change: { on?: boolean; set?: Record<string, unknown>; secrets?: Record<string, string> },
): Promise<Agent> {
  const { CHANNELS } = await import("#chloe/channels/catalog");
  const kind = CHANNELS.find((one) => one.name === name);
  if (!kind) throw new BadRequest(`${agent.id} has no channel chloe ships called ${name}. There are ${CHANNELS.map((one) => one.name).join(", ")}.`);
  const set = checked(kind.fields, change.set, `channels.${name}`);
  const tokens = Object.entries(change.secrets ?? {});
  for (const [path, value] of tokens) {
    if (!kind.secrets.some((one) => one.path === path)) throw new BadRequest(`${name} has no setting ${path}. It reads ${kind.secrets.map((one) => one.path).join(", ") || "none"}.`);
    if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${path} is empty.`);
  }
  const now =
    change.on === undefined && Object.keys(set).length === 0
      ? await loadAgain(agent)
      : await changeAgentFile(agent, (text) => setChannelIn(text, kind.name, kind.fn, { on: change.on, set, starter: kind.starter }));
  if (tokens.length) await changeSettings(tokens.map(([path, value]) => ({ path: `agents.${agent.id}.${path}`, value })));
  return now;
}

/** What a form gave for each field, refused where it is not what the field takes. `null` stays, and puts the default back. */
function checked(specs: OptionSpec[], given: Record<string, unknown> | undefined, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given ?? {})) {
    const spec = specs.find((one) => one.name === name);
    if (!spec) throw new BadRequest(`${where} has no field ${name}. It has ${specs.map((one) => one.name).join(", ") || "none"}.`);
    if (value !== null && !fits(spec, value)) throw new BadRequest(`${where}: ${name} takes ${takes(spec)}.`);
    out[name] = value !== null && JSON.stringify(value) === JSON.stringify(defaultOf(spec)) ? null : value;
  }
  return out;
}

/**
 * Switches one tool off or on by changing `without` in the agent's agent.ts,
 * and hands back the agent as it now loads. A name the agent does not have
 * is refused. Refused as `InCode` where `without` is written as code.
 */
export async function changeTool(agent: Home, name: string, on: boolean): Promise<Agent> {
  return changeAgentFile(agent, (text) => setWithoutIn(text, name, on));
}

/**
 * Writes agent.ts as `change` makes it, loads the agent from it, and hands it
 * back; or puts the file back and throws why it would not load. There is no
 * type check: a switch changes a true, false or a name in a list, which
 * cannot be a type error, and a check of the whole project is what made a
 * switch take seconds. Loading catches a name that is wrong.
 */
async function changeAgentFile(agent: Home, change: (text: string) => string): Promise<Agent> {
  const file = join(agent.folder, "agent.ts");
  if (!existsSync(file)) throw new NotFound(`${agent.id} has no agent.ts, so this is changed where it is defined.`);
  const before = await readFile(file, "utf8");
  const text = change(before);
  if (text === before) return loadAgain(agent);
  return checkFirst(async () => {
    await writeFile(file, text);
    try {
      return await loadAgain(agent);
    } catch (error) {
      await writeFile(file, before);
      throw new Error(`agent.ts is put back as it was, because ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Where `defineAgent({` opens in agent.ts. */
function agentObject(text: string): number {
  const open = /defineAgent\s*\(\s*\{/.exec(blank(text));
  if (!open) throw new InCode("agent.ts has no defineAgent({ ... }) to change.");
  return open.index + open[0].length - 1;
}

/** How agent.ts says an ability or a channel: nothing, true or false, its fields written out, or as code. */
export type Said =
  | { kind: "absent" }
  | { kind: "flag"; on: boolean }
  | {
      kind: "fields";
      /** Each field as its dotted name, and whether it is a plain value or code. */
      fields: Record<string, "value" | "code">;
      /** The plain ones, as they are written. */
      values: Record<string, unknown>;
    }
  | { kind: "code" };

/** How agent.ts's text says `<root>.<name>`, root being `abilities` or `channels`. */
export function saidIn(text: string, root: string, name: string): Said {
  const at = agentObject(text);
  const group = entries(text, at).find((one) => one.key === root);
  if (!group) return entries(text, at).some((one) => one.key === null) ? { kind: "code" } : { kind: "absent" };
  if (text[group.valueStart] !== "{") return { kind: "code" };
  const all = entries(text, group.valueStart);
  const found = all.find((one) => one.key === name);
  if (!found) return all.some((one) => one.key === null) ? { kind: "code" } : { kind: "absent" };
  const value = text.slice(found.valueStart, found.valueEnd).trim();
  if (value === "true" || value === "false") return { kind: "flag", on: value === "true" };
  if (text[found.valueStart] !== "{") return { kind: "code" };
  const fields: Record<string, "value" | "code"> = {};
  const values: Record<string, unknown> = {};
  const walk = (open: number, prefix: string) => {
    for (const one of entries(text, open)) {
      if (one.key === null) {
        fields["..."] = "code";
        continue;
      }
      const at = `${prefix}${one.key}`;
      if (text[one.valueStart] === "{") walk(one.valueStart, `${at}.`);
      else {
        const plain = literal(text.slice(one.valueStart, one.valueEnd));
        fields[at] = plain === undefined ? "code" : "value";
        if (plain !== undefined) values[at] = plain;
      }
    }
  };
  walk(found.valueStart, "");
  return { kind: "fields", fields, values };
}

/** A value as TypeScript, for a field: words and numbers as JSON, a list with a space after each comma. */
const typed = (value: unknown): string => (Array.isArray(value) ? `[${value.map((one) => JSON.stringify(one)).join(", ")}]` : JSON.stringify(value));

/**
 * agent.ts's text with `<root>.<name>` changed: `on` switches it, and `set`
 * gives its fields, each a value or `null` to take it out. A ability or
 * channel that is on with no field to say is written `true`, and one that is
 * off is written `false` when it is on unless said (`defaultOn`) and taken
 * out otherwise. A field that is code is never touched: `InCode` when the
 * change needs it, or the whole entry is code.
 */
export function setOptionsIn(
  text: string,
  root: "abilities" | "channels",
  name: string,
  change: { on?: boolean; set?: Record<string, unknown> },
  defaultOn: boolean,
): string {
  const at = agentObject(text);
  const now = saidIn(text, root, name);
  const touching = Object.keys(change.set ?? {}).length > 0;
  if (now.kind === "code") throw new InCode(`${root}.${name} is written as code in agent.ts, so it is changed in the file.`);
  const path = (rest: string[] = []) => [root, name, ...rest];
  let out = text;
  if (change.on === false) return withoutEmpty(put(out, at, path(), defaultOn ? "false" : null, "agent.ts"), at, root);
  const wasOn = now.kind === "absent" ? defaultOn : now.kind === "flag" ? now.on : true;
  if (!touching) {
    if (change.on === true && !wasOn) out = put(out, at, path(), "true", "agent.ts");
    return out;
  }
  // Fields to say: the entry has to be an object for them to go in.
  if (now.kind !== "fields") out = put(out, at, path(), "{}", "agent.ts");
  for (const [field, value] of Object.entries(change.set ?? {})) {
    if (now.kind === "fields" && now.fields[field] === "code") throw new InCode(`${root}.${name}.${field} is written as code in agent.ts, so it is changed in the file.`);
    out = put(out, at, path(field.split(".")), value === null ? null : typed(value), "agent.ts");
    if (value === null) out = pruneEmpty(out, at, path(field.split(".")).slice(0, -1));
  }
  // With nothing left to say, it is just on.
  const entry = entries(out, entries(out, at).find((one) => one.key === root)!.valueStart).find((one) => one.key === name);
  if (entry && out[entry.valueStart] === "{" && entries(out, entry.valueStart).length === 0) out = put(out, at, path(), "true", "agent.ts");
  return withoutEmpty(out, at, root);
}

/** The text with `<root>: { }` taken out when nothing is left in it. */
function withoutEmpty(text: string, at: number, root: string): string {
  const group = entries(text, at).find((one) => one.key === root);
  return group && text[group.valueStart] === "{" && entries(text, group.valueStart).length === 0 ? remove(text, group) : text;
}

/**
 * How agent.ts says the channel `name`, made by `fn`: not at all, as
 * `fn({ ... })` or `fn()` with its plain options, or some other way (`code`).
 */
export function saidChannel(text: string, name: string, fn: string): Said {
  const at = agentObject(text);
  const group = entries(text, at).find((one) => one.key === "channels");
  if (!group) return entries(text, at).some((one) => one.key === null) ? { kind: "code" } : { kind: "absent" };
  if (text[group.valueStart] !== "{") return { kind: "code" };
  const all = entries(text, group.valueStart);
  const found = all.find((one) => one.key === name);
  if (!found) return all.some((one) => one.key === null) ? { kind: "code" } : { kind: "absent" };
  const call = callOf(text, found, fn);
  if (!call) return { kind: "code" };
  const fields: Record<string, "value" | "code"> = {};
  const values: Record<string, unknown> = {};
  if (call.open !== undefined) walkFields(text, call.open, "", fields, values);
  return { kind: "fields", fields, values };
}

/** Where the options of `fn(...)` open inside an entry's value, `open` being undefined for `fn()`, or nothing when the value is something else. */
function callOf(text: string, entry: Entry, fn: string): { open?: number } | undefined {
  const value = text.slice(entry.valueStart, entry.valueEnd);
  const empty = new RegExp(`^${fn}\\(\\s*\\)$`).exec(value);
  if (empty) return {};
  const call = new RegExp(`^${fn}\\(\\s*\\{`).exec(value);
  if (!call) return undefined;
  const open = entry.valueStart + call[0].length - 1;
  // The call has to end where the options do, or there is more in it than options.
  return text.slice(closing(text, open) + 1, entry.valueEnd).trim() === ")" ? { open } : undefined;
}

/** The plain and code fields of the object opening at `open`, by dotted name. */
function walkFields(text: string, open: number, prefix: string, fields: Record<string, "value" | "code">, values: Record<string, unknown>): void {
  for (const one of entries(text, open)) {
    if (one.key === null) {
      fields["..."] = "code";
      continue;
    }
    const at = `${prefix}${one.key}`;
    if (text[one.valueStart] === "{") walkFields(text, one.valueStart, `${at}.`, fields, values);
    else {
      const plain = literal(text.slice(one.valueStart, one.valueEnd));
      fields[at] = plain === undefined ? "code" : "value";
      if (plain !== undefined) values[at] = plain;
    }
  }
}

/**
 * agent.ts's text with the channel `name` added, removed or its options
 * changed. Adding writes `name: fn({ ...starter, ...set })` into `channels`
 * and `fn` into the import from `@chloejs/core/channels`; removing takes both
 * out, the import only when nothing else uses it. A `set` value of `null`
 * takes an option out. `InCode` when the file says the channel or the import
 * some other way.
 */
export function setChannelIn(
  text: string,
  name: string,
  fn: string,
  change: { on?: boolean; set?: Record<string, unknown>; starter?: Record<string, unknown> },
): string {
  let at = agentObject(text);
  const now = saidChannel(text, name, fn);
  if (now.kind === "code") throw new InCode(`channels.${name} is written some other way than ${fn}(...) in agent.ts, so it is changed in the file.`);
  let out = text;
  if (change.on === false) {
    if (now.kind === "absent") return out;
    out = put(out, at, ["channels", name], null, "agent.ts");
    out = withoutEmpty(out, at, "channels");
    return dropImport(out, fn);
  }
  const touching = Object.keys(change.set ?? {}).length > 0;
  if (now.kind === "absent") {
    if (change.on !== true && !touching) return out;
    out = addImport(out, fn);
    // The import moved everything below it.
    at = agentObject(out);
    out = put(out, at, ["channels", name], `${fn}()`, "agent.ts");
    for (const [field, value] of Object.entries(change.starter ?? {})) out = setCallField(out, at, name, fn, field, value);
  }
  for (const [field, value] of Object.entries(change.set ?? {})) {
    if (now.kind === "fields" && now.fields[field] === "code") throw new InCode(`channels.${name}.${field} is written as code in agent.ts, so it is changed in the file.`);
    out = setCallField(out, at, name, fn, field, value);
  }
  return out;
}

/** The text with one option inside `name: fn({ ... })` set, or taken out for `null`, the call keeping to `fn()` when no option is left. */
function setCallField(text: string, at: number, name: string, fn: string, field: string, value: unknown): string {
  const find = (source: string) => {
    const group = entries(source, at).find((one) => one.key === "channels")!;
    return entries(source, group.valueStart).find((one) => one.key === name)!;
  };
  let out = text;
  let entry = find(out);
  const call = callOf(out, entry, fn);
  if (!call) throw new InCode(`channels.${name} is written some other way than ${fn}(...) in agent.ts, so it is changed in the file.`);
  if (call.open === undefined) {
    if (value === null) return out;
    out = out.slice(0, entry.valueStart) + `${fn}({})` + out.slice(entry.valueEnd);
    entry = find(out);
  }
  const open = callOf(out, entry, fn)!.open!;
  const path = field.split(".");
  out = put(out, open, path, value === null ? null : typed(value), "agent.ts");
  if (value === null) {
    // Groups the option sat in go when they are empty, then the call goes back to fn() when it holds nothing.
    for (let depth = path.length - 1; depth > 0; depth--) {
      let inside = callOf(out, find(out), fn)!.open!;
      let found: Entry | undefined;
      for (const key of path.slice(0, depth)) {
        found = entries(out, inside).find((one) => one.key === key);
        if (!found) break;
        inside = found.valueStart;
      }
      if (found && out[found.valueStart] === "{" && entries(out, found.valueStart).length === 0) out = remove(out, found);
    }
    entry = find(out);
    const left = callOf(out, entry, fn)!.open;
    if (left !== undefined && entries(out, left).length === 0) out = out.slice(0, entry.valueStart) + `${fn}()` + out.slice(entry.valueEnd);
  }
  return out;
}

const CHANNELS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']@chloejs\/core\/channels["'];?/;

/** The text with `fn` in its import from `@chloejs/core/channels`, the import made when there is none. */
function addImport(text: string, fn: string): string {
  const found = CHANNELS_IMPORT.exec(text);
  if (found) {
    const names = found[1].split(",").map((one) => one.trim()).filter(Boolean);
    if (names.includes(fn)) return text;
    return text.slice(0, found.index) + `import { ${[...names, fn].join(", ")} } from "@chloejs/core/channels";` + text.slice(found.index + found[0].length);
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*["']@chloejs\/core\/channels["']/.test(text) || new RegExp(`\\b${fn}\\b`).test(text)) {
    throw new InCode(`agent.ts imports from @chloejs/core/channels some other way, so ${fn} is added in the file.`);
  }
  const imports = [...text.matchAll(/^import .*;?\s*$/gm)];
  const last = imports.at(-1);
  const line = `import { ${fn} } from "@chloejs/core/channels";\n`;
  if (!last) return line + text;
  const end = last.index + last[0].length;
  return text.slice(0, end) + (text[end - 1] === "\n" ? "" : "\n") + line.trimEnd() + text.slice(end);
}

/** The text with `fn` out of its import from `@chloejs/core/channels` when nothing else in the file uses it, and the import with it when it is the last name. */
function dropImport(text: string, fn: string): string {
  const found = CHANNELS_IMPORT.exec(text);
  if (!found) return text;
  const names = found[1].split(",").map((one) => one.trim()).filter(Boolean);
  if (!names.includes(fn)) return text;
  const rest = text.slice(0, found.index) + text.slice(found.index + found[0].length).replace(/^\n/, "");
  if (new RegExp(`\\b${fn}\\b`).test(rest)) return text;
  const kept = names.filter((one) => one !== fn);
  if (kept.length) return text.slice(0, found.index) + `import { ${kept.join(", ")} } from "@chloejs/core/channels";` + text.slice(found.index + found[0].length);
  return rest;
}

/** Takes the groups along `path` out, deepest first, while they are empty objects. */
function pruneEmpty(text: string, at: number, path: string[]): string {
  let out = text;
  for (let depth = path.length; depth > 2; depth--) {
    let open = at;
    let found: Entry | undefined;
    for (const key of path.slice(0, depth)) {
      found = entries(out, open).find((one) => one.key === key);
      if (!found) return out;
      open = found.valueStart;
    }
    if (found && out[found.valueStart] === "{" && entries(out, found.valueStart).length === 0) out = put(out, at, path.slice(0, depth), null, "agent.ts");
    else break;
  }
  return out;
}

/**
 * agent.ts's text with `name` in `without` when `on` is false and out of it
 * when true, and `without` taken out when nothing is left in it. Throws
 * `InCode` when `without` is not a plain list of words.
 */
export function setWithoutIn(text: string, name: string, on: boolean): string {
  const at = agentObject(text);
  const found = entries(text, at).find((one) => one.key === "without");
  const now = found ? literal(text.slice(found.valueStart, found.valueEnd)) : [];
  if (!Array.isArray(now) || now.some((one) => typeof one !== "string")) throw new InCode("without is written as code in agent.ts, so it is changed in the file.");
  const list = on ? now.filter((one) => one !== name) : now.includes(name) ? now : [...now, name];
  return put(text, at, ["without"], list.length ? `[${list.map((one) => JSON.stringify(one)).join(", ")}]` : null, "agent.ts");
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

function put(text: string, open: number, path: string[], value: string | null, file = "chloe.config.ts"): string {
  const all = entries(text, open);
  const [key, ...rest] = path;
  const found = all.find((one) => one.key === key);
  if (!found && all.some((one) => one.key === null)) {
    throw new InCode(`${key} may be set by code beside it in ${file}, so it is changed in the file.`);
  }
  if (!found) {
    if (value === null) return text;
    return insert(text, open, all, `${said(key)}: ${rest.reduceRight((inside, part) => `{ ${said(part)}: ${inside} }`, value)}`);
  }
  if (rest.length) {
    if (text[found.valueStart] !== "{") throw new InCode(`${key} is written as code in ${file}, so it is changed in the file.`);
    return put(text, found.valueStart, rest, value, file);
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
  // The last entry on a line has no comma of its own, so the one before it goes instead.
  const before = found.end === found.valueEnd ? text.slice(0, found.start).replace(/,\s*$/, " ") : text.slice(0, found.start);
  return before + text.slice(found.end).replace(/^[ \t]+/, "");
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
