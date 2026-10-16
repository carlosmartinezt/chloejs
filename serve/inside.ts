// What one agent is made of, for the page that shows it: what it is told to
// do, what it knows how to do, the ways in it binds and what it can reach
// outside this box.
//
// No credential is ever read out here. A setting is reported as filled in or
// not, and which setting it is, so somebody knows what to go and put there.
import { settings } from "#chloe/core/settings";
import { modelFor } from "#chloe/model/choices";
import { ownKey, sdkModel } from "#chloe/model/key";
import { providerOf, routeFor, type Route } from "#chloe/model/model";
import { describe, descriptionOf, neededBy } from "#chloe/model/tool";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { allAbilities, abilityOn, abilityToolSet, abilityValues, type Agent } from "#chloe/load/load";
import { defaultOf, valueAtName, type OptionSpec } from "#chloe/load/options";
import { alwaysOnTools, money, spentText } from "#chloe/core/turn";
import { saidChannel, saidIn, type Said } from "./config.ts";
import { BadRequest, NotFound } from "./errors.ts";

/** One way in or one way out, said the same way so one page draws both. */
export interface Way {
  /** What it is called, in the words the settings and the log use. */
  name: string;
  /** What it is, in one line. */
  does: string;
  /**
   * Which settings it reads, as paths into the settings, comma separated, or
   * empty when it needs none. Never the values.
   */
  needs: string;
  /** Whether it is set up. Null when there is nothing to set up. */
  ready: boolean | null;
  /** What is missing before it works, one line each, when it says. */
  missing?: string[];
  /** Whether somebody can sign in to it from the page. */
  signIn?: boolean;
  /** How it was set up, as the agent's definition wrote it. Never a credential. */
  settings?: { name: string; value: string }[];
}

/**
 * Every string the settings hold, however deep. A credential reaches the
 * settings from .env, so a value that is in there is a credential whatever the
 * option it was handed to is called.
 */
function inSettings(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const word = value.trim();
    if (word.length >= 8) found.add(word);
  } else if (Array.isArray(value)) {
    for (const one of value) inSettings(one, found);
  } else if (value && typeof value === "object") {
    for (const one of Object.values(value)) inSettings(one, found);
  }
  return found;
}

/**
 * Whether a piece of text is a credential rather than something somebody
 * chose. No list of option names to keep up to date, so a channel anybody
 * writes is treated like the ones that ship here. Two things say so:
 *
 * - the settings hold it, which is where a token handed to a channel comes
 *   from, and
 * - it reads like a key: a long run with no spaces in it mixing letters and
 *   numbers. A setting somebody typed is a word, a name, a number or an
 *   address, and none of those is that.
 *
 * It errs towards hiding. A value that is really a choice and looks like a key
 * is shown as hidden, and the agent's own file says what it is.
 */
function credential(text: string, held: Set<string>): boolean {
  const word = text.trim();
  if (held.has(word)) return true;
  return word.length >= 24 && !/\s/.test(word) && /[a-z]/i.test(word) && /[0-9]/.test(word);
}

/** One option's value, as short as it can be said, with any credential in it hidden. */
function said(value: unknown, held: Set<string>): string {
  if (typeof value === "string") return credential(value, held) ? "hidden" : value;
  if (Array.isArray(value)) return value.map((one) => said(one, held)).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([name, one]) => `${name} ${said(one, held)}`)
      .join(", ");
  }
  return String(value);
}

/**
 * The options a channel was made with, all of them, which say who may reach
 * the agent and how it answers. What is here is the shape of the channel and
 * never the way in to it: a value that is a credential is hidden wherever it
 * sits, however deep, and whatever its option is called.
 */
function optionsOf(channel: { name: string; madeWith?: string }): { name: string; value: string }[] {
  if (!channel.madeWith) return [];
  let options: Record<string, unknown>;
  try {
    options = JSON.parse(channel.madeWith) as Record<string, unknown>;
  } catch {
    return [];
  }
  const held = inSettings(settings);
  return Object.entries(options)
    .filter(([name, value]) => value !== undefined && !(name === "name" && value === channel.name))
    .map(([name, value]) => ({ name, value: said(value, held) }));
}

/** What a channel was made with, as the JSON it keeps. Empty when it keeps none. */
function madeWith(channel: { madeWith?: string }): Record<string, unknown> {
  try {
    return channel.madeWith ? (JSON.parse(channel.madeWith) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One tool as the page shows it. */
export interface ToolShown {
  /** The name the model calls it by. */
  name: string;
  /** What the page calls it, like "Read file". Absent for a tool the agent wrote itself: the page says its name in words. */
  title?: string;
  /** What the model is told it is for. */
  does: string;
  /** Where it comes from, like "abilities.memory", "always" for one every agent has, or absent for the agent's own. */
  from?: string;
  /** Whether the agent has it. A tool in `without` is shown, switched off. */
  on: boolean;
  /** Only in a conversation with its owner. */
  ownerOnly?: boolean;
  /** What it takes, in the words the model is given for each. */
  takes: { name: string; about: string; required: boolean }[];
}

/** One tool, with what it takes read off its schema. */
async function shown(name: string, tool: Parameters<typeof describe>[1], rest: Omit<ToolShown, "name" | "does" | "takes">): Promise<ToolShown> {
  const schema = await describe(name, tool).then((one) => one.parameters, () => ({}) as Record<string, any>);
  const required: string[] = schema.required ?? [];
  const takes = Object.entries((schema.properties ?? {}) as Record<string, { description?: string }>).map(([key, one]) => ({
    name: key,
    about: one.description ?? "",
    required: required.includes(key),
  }));
  return { name, ...((tool as { title?: string }).title && { title: (tool as { title?: string }).title }), does: descriptionOf(tool).trim(), ...rest, takes };
}

/**
 * What an agent can do: every tool it is bound, the ones it has switched off,
 * and the ones every agent has, each with what the model is told it is for
 * and what it takes.
 */
export async function toolsOf(agent: Agent): Promise<ToolShown[]> {
  const from = agent.toolsFrom ?? {};
  const mine = Object.entries(agent.tools ?? {}).map(([name, tool]) => shown(name, tool, { on: true, ...(from[name] && { from: from[name] }) }));
  const off = Object.entries(agent.toolsOff ?? {}).map(([name, tool]) => shown(name, tool, { on: false, ...(from[name] && { from: from[name] }) }));
  // What an ability that is off would bring, so what switching it on does is plain.
  const brings = allAbilities().filter((one) => !abilityOn(agent.abilities, one.name)).flatMap((one) =>
    Object.entries(abilityToolSet(agent, one.name, agent.abilities, true)).map(([name, tool]) => shown(name, tool, { on: false, from: `abilities.${one.name}` })),
  );
  const always = alwaysOnTools(agent).map((one) => shown(one.name, one.tool, { on: true, from: "always", ...(one.ownerOnly && { ownerOnly: true }) }));
  return (await Promise.all([...mine, ...off, ...brings, ...always])).sort((a, b) => a.name.localeCompare(b.name));
}

/** One ability as the page shows it. */
export interface AbilityShown {
  name: string;
  /** What the page calls it. */
  label: string;
  on: boolean;
  does: string;
  /** Every tool it can add. */
  tools: string[];
  /** The connection it works through, and what that still needs before it works. */
  needs?: { name: string; missing: string[] };
  /** The fields it takes, with what each is now. Absent for an ability that is only on or off. */
  fields?: {
    name: string;
    label: string;
    about: string;
    kind: string;
    pick?: string[];
    numbers?: boolean;
    value: unknown;
    default: unknown;
    /** The file writes it as code, so it is shown and left alone. */
    code: boolean;
  }[];
  /** The file writes the whole ability as code, so its fields are shown and left alone. */
  code?: boolean;
}

/** Every ability, whether this agent has it on, its fields as they are now and what each does. */
export async function abilitiesOf(agent: Agent): Promise<AbilityShown[]> {
  const file = join(agent.folder, "agent.ts");
  const text = existsSync(file) ? await readFile(file, "utf8").catch(() => "") : "";
  return Promise.all(
    allAbilities().map(async (one): Promise<AbilityShown> => {
      const said = text ? safely(() => saidIn(text, "abilities", one.name)) : ({ kind: "code" } as Said);
      const values = one.fields ? abilityValues(agent.abilities, one.name) : {};
      const missing = one.needs ? await one.needs.missing().catch((error: Error) => [error.message]) : [];
      return {
        name: one.name,
        label: one.label,
        on: abilityOn(agent.abilities, one.name),
        does: one.does,
        tools: one.tools,
        ...(one.needs && { needs: { name: one.needs.name, missing } }),
        ...(one.fields && {
          fields: one.fields.map((spec) => ({
            name: spec.name,
            label: spec.label,
            about: spec.about,
            kind: spec.kind,
            ...(spec.pick && { pick: spec.pick }),
            ...(spec.numbers && { numbers: true }),
            value: values[spec.name],
            default: defaultOf(spec),
            code: said.kind === "code" || (said.kind === "fields" && (said.fields[spec.name] === "code" || "..." in said.fields)),
          })),
        }),
        ...(said.kind === "code" && { code: true }),
      };
    }),
  );
}

/** The labels of the abilities that are on, for the agent's own page. */
export function abilityNames(agent: Agent): { name: string; label: string; on: boolean }[] {
  return allAbilities().map((one) => ({ name: one.name, label: one.label, on: abilityOn(agent.abilities, one.name) }));
}

const safely = <T,>(work: () => T): T | { kind: "code" } => {
  try {
    return work();
  } catch {
    return { kind: "code" };
  }
};

/** Whether a setting has been filled in. An object counts when it has anything in it. */
const filled = (value: string | Record<string, unknown> | undefined): boolean =>
  typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value && value.trim());

/** One channel as the page shows it: every channel chloe ships whether the agent has it or not, and the agent's own. */
export interface ChannelShown {
  name: string;
  /** What the page calls it. */
  label: string;
  does: string;
  on: boolean;
  /** A channel the agent wrote itself: shown, and not changed here. */
  own?: boolean;
  /** The options that are plain values, as a form. */
  fields: OptionShown[];
  /** The settings that hold its tokens, and whether each is filled. Never a value. */
  secrets: { path: string; label: string; set: boolean }[];
  /** The connection it works through, and what that still needs. */
  needs?: { name: string; missing: string[] };
  /** The agent's file writes the whole channel as code. */
  code?: boolean;
  /** Options it was made with that are not fields, such as the tools or the job it names, as the file wrote them. */
  settings: { name: string; value: string }[];
}

/** One field of an ability or a channel, as the page's form takes it. */
export interface OptionShown {
  name: string;
  label: string;
  about: string;
  kind: string;
  pick?: string[];
  numbers?: boolean;
  value: unknown;
  default: unknown;
  /** The file writes it as code, so it is shown and left alone. */
  code: boolean;
  required?: boolean;
}

/** A value fit for the page: a word, a number, a switch or a list of them, and nothing a form could not hold. */
const plain = (value: unknown): unknown =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.every((one) => typeof one === "string" || typeof one === "number"))
    ? value
    : undefined;

/** The form of an ability's or a channel's fields, from what agent.ts says now. */
function optionsShown(specs: OptionSpec[], said: Said, value: (name: string) => unknown): OptionShown[] {
  return specs.map((spec) => {
    const code = said.kind === "code" || (said.kind === "fields" && (said.fields[spec.name] === "code" || "..." in said.fields));
    const now = value(spec.name);
    return {
      name: spec.name,
      label: spec.label,
      about: spec.about,
      kind: spec.kind,
      ...(spec.pick && { pick: spec.pick }),
      ...(spec.numbers && { numbers: true }),
      value: plain(now === undefined ? defaultOf(spec) : now),
      default: defaultOf(spec),
      code,
      ...(spec.required && { required: true }),
    };
  });
}

/**
 * Every channel chloe ships, on or off for this agent, with its options as
 * fields and which of its tokens are filled in, then the agent's own. A
 * channel's options are read from what agent.ts says, because the channel
 * made from them keeps no copy.
 */
export async function channelsOf(agent: Agent): Promise<ChannelShown[]> {
  const CHANNELS = (await import("#chloe/channels/catalog")).channelKinds();
  const file = agent.folder ? join(agent.folder, "agent.ts") : "";
  const text = file && existsSync(file) ? await readFile(file, "utf8").catch(() => "") : "";
  const held = settings.agents[agent.id] as unknown as Record<string, unknown> | undefined;
  const filledAt = (path: string) => filled(path.split(".").reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), held) as string | undefined);
  const shipped = await Promise.all(
    CHANNELS.map(async (kind): Promise<ChannelShown> => {
      const channel = agent.channels.find((one) => one.name === kind.name);
      const said = text ? safely(() => saidChannel(text, kind.name, kind.fn)) : ({ kind: "code" } as Said);
      // What the file writes plainly, else what the running channel was made with, for a value the file writes as code.
      const made = channel ? madeWith(channel) : {};
      const valueOf = (name: string) => (said.kind === "fields" && name in said.values ? said.values[name] : valueAtName(made, name));
      const needs = channel?.needs ? { name: channel.needs.name, missing: await channel.needs.missing().catch((error: Error) => [error.message]) } : undefined;
      const names = kind.fields.map((one) => one.name.split(".")[0]);
      return {
        name: kind.name,
        label: kind.label,
        does: (channel && kind.doing?.(agent)) || kind.does,
        on: Boolean(channel),
        fields: optionsShown(kind.fields, said, valueOf),
        secrets: kind.secrets.map((one) => ({ ...one, set: filledAt(one.path) })),
        ...(needs && { needs }),
        ...(said.kind === "code" && channel && { code: true }),
        settings: channel ? optionsOf(channel).filter((one) => !names.includes(one.name)) : [],
      };
    }),
  );
  const own = agent.channels
    .filter((one) => !CHANNELS.some((kind) => kind.name === one.name))
    .map((channel): ChannelShown => ({
      name: channel.name,
      label: channel.name,
      does: "A way in of this agent's own, written in code.",
      on: true,
      own: true,
      fields: [],
      secrets: [],
      settings: optionsOf(channel),
    }));
  return [...shipped, ...own];
}

/** Where a model is asked, as one of the ways out of this box. */
function wayOf(model: string, route: Route): Way {
  if (route === "gateway") {
    return {
      name: "model gateway",
      does: `Where ${model} is asked. Every run of this agent goes through it.`,
      needs: "model.key",
      ready: filled(settings.model.key),
    };
  }
  if (route === "direct" && sdkModel(model)) {
    return { name: `${providerOf(model)} API`, does: `Where ${model} is asked, on the key its own package reads.`, needs: "", ready: null };
  }
  if (route === "direct") {
    return {
      name: `${providerOf(model)} API`,
      does: `Where ${model} is asked, on ${providerOf(model)}'s own key. Every run of this agent goes through it.`,
      needs: `model.keys.${providerOf(model)}`,
      ready: filled(ownKey(providerOf(model))),
    };
  }
  return { name: `${route} CLI`, does: `Where ${model} is asked, over a subscription rather than a key.`, needs: "", ready: null };
}

/**
 * What this agent can reach that is not on this box: where its thinking goes,
 * and each connection its tools work through, asked what is missing. A tool
 * that only touches this disk is not here, because nothing outside is involved
 * in it.
 */
export async function connectionsOf(agent: Agent): Promise<Way[]> {
  const model = modelFor(agent);
  const out: Way[] = [wayOf(model, routeFor(model))];
  for (const connection of new Set([...neededBy(agent), ...(agent.connections ?? [])])) {
    const missing = await connection.missing().catch((error: Error) => [error.message]);
    out.push({
      name: connection.name,
      does: connection.does,
      needs: connection.settings.join(", "),
      ready: missing.length === 0,
      missing,
      ...(connection.signIn && { signIn: true }),
    });
  }
  return out;
}

/**
 * The sign-in of one of the agent's connections, by name, with what either half
 * throws turned into a refusal in words, which is what the person needs to see.
 */
export function signInOf(agent: Agent, name: string): { start: () => Promise<{ say: string; link?: string }>; finish: (answer: string) => Promise<string> } {
  const connection = neededBy(agent).find((one) => one.name === name);
  if (!connection?.signIn) throw new NotFound(`${agent.id} has no connection called ${JSON.stringify(name)} to sign in to.`);
  const { signIn } = connection;
  const said = <T>(work: () => Promise<T>) =>
    work().catch((error: Error) => {
      throw new BadRequest(error.message);
    });
  return { start: () => said(() => signIn.start()), finish: (answer) => said(() => signIn.finish(answer)) };
}
