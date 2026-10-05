// What one agent is made of, for the page that shows it: what it is told to
// do, what it knows how to do, the ways in it binds and what it can reach
// outside this box.
//
// No credential is ever read out here. A setting is reported as filled in or
// not, and which setting it is, so somebody knows what to go and put there.
import { settings } from "#chloe/core/settings";
import { modelFor } from "#chloe/model/choices";
import { routeFor } from "#chloe/model/model";
import { connectionsUsed, descriptionOf } from "#chloe/model/tool";
import type { Agent } from "#chloe/load/load";
import { collectsAt } from "#chloe/channels/whatsapp";
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

/** What an agent can do: every tool it is bound, with what the model is told it is for. */
export function toolsOf(agent: Agent): { name: string; does: string }[] {
  return Object.entries(agent.tools ?? {})
    .map(([name, tool]) => ({ name, does: descriptionOf(tool).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a setting has been filled in. An object counts when it has anything in it. */
const filled = (value: string | Record<string, unknown> | undefined): boolean =>
  typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value && value.trim());

/**
 * The ways in this agent binds. A channel chloe ships says which setting holds
 * its token; one written in an agent's own channels/ folder is named and
 * nothing more, because only it knows what it needs.
 */
export function channelsOf(agent: Agent): Way[] {
  return agent.channels
    .map((channel): Way => {
      const how = optionsOf(channel);
      if (channel.name === "telegram") {
        return {
          name: "telegram",
          does: "A Telegram bot. Anyone it is told to listen to can talk to this agent.",
          needs: `agents.${agent.id}.telegram`,
          ready: filled(settings.agents[agent.id]?.telegram),
          settings: how,
        };
      }
      if (channel.name === "slack") {
        const slack = settings.agents[agent.id]?.slack;
        return {
          name: "slack",
          does: "A Slack app. It answers in a direct message or wherever it is invited.",
          needs: `agents.${agent.id}.slack`,
          ready: filled(slack?.bot_token) && filled(slack?.app_token),
          settings: how,
        };
      }
      if (channel.name === "whatsapp") {
        const whatsapp = settings.agents[agent.id]?.whatsapp;
        const box = collectsAt(agent.id, channel.name);
        return {
          name: "whatsapp",
          does:
            "A number on WhatsApp's own API. It answers one-to-one messages, and WhatsApp allows no groups on it." +
            (box ? ` Paste ${box} into the app's WhatsApp page: that is the post box it collects from.` : ""),
          needs: `agents.${agent.id}.whatsapp`,
          ready: filled(whatsapp?.phone_number_id) && filled(whatsapp?.token) && filled(whatsapp?.app_secret),
          settings: how,
        };
      }
      if (channel.name === "api") {
        return {
          name: "api",
          does: "A token another system holds may chat to this agent and run its jobs.",
          needs: "",
          ready: null,
          settings: how,
        };
      }
      return { name: channel.name, does: "A way in of this agent's own.", needs: "", ready: null, settings: how };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What this agent can reach that is not on this box: where its thinking goes,
 * and each connection its tools work through, asked what is missing. A tool
 * that only touches this disk is not here, because nothing outside is involved
 * in it.
 */
export async function connectionsOf(agent: Agent): Promise<Way[]> {
  const model = modelFor(agent);
  const route = routeFor(model);
  const out: Way[] = [
    route === "gateway"
      ? {
          name: "model gateway",
          does: `Where ${model} is asked. Every run of this agent goes through it.`,
          needs: "model.key",
          ready: filled(settings.model.key),
        }
      : {
          name: `${route} CLI`,
          does: `Where ${model} is asked, over a subscription rather than a key.`,
          needs: "",
          ready: null,
        },
  ];
  for (const connection of new Set([...connectionsUsed(agent.tools ?? {}), ...(agent.connections ?? [])])) {
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
  const connection = connectionsUsed(agent.tools ?? {}).find((one) => one.name === name);
  if (!connection?.signIn) throw new NotFound(`${agent.id} has no connection called ${JSON.stringify(name)} to sign in to.`);
  const { signIn } = connection;
  const said = <T>(work: () => Promise<T>) =>
    work().catch((error: Error) => {
      throw new BadRequest(error.message);
    });
  return { start: () => said(() => signIn.start()), finish: (answer) => said(() => signIn.finish(answer)) };
}
