// What one agent is made of, for the page that shows it: what it is told to
// do, what it knows how to do, the ways in it binds and what it can reach
// outside this box.
//
// No credential is ever read out here. A setting is reported as filled in or
// not, and which setting it is, so somebody knows what to go and put there.
import { settings } from "#chloe/core/settings";
import { modelFor } from "#chloe/model/choices";
import type { Agent } from "#chloe/load/load";

/** One way in or one way out, said the same way so one page draws both. */
export interface Way {
  /** What it is called, in the words the settings and the log use. */
  name: string;
  /** What it is, in one line. */
  does: string;
  /**
   * Which setting carries its credentials, as a path into settings.json, or
   * empty when it needs none. Never the value.
   */
  needs: string;
  /** Whether that setting is filled in. Null when there is nothing to fill in. */
  ready: boolean | null;
  /** How it was set up, as the agent's definition wrote it. Never a credential. */
  settings?: { name: string; value: string }[];
}

/**
 * Every string the settings hold, however deep. This box keeps its credentials
 * in settings.json, so a value that is in there is a credential whatever the
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
    .map(([name, tool]) => ({ name, does: tool.description.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a setting has anything in it. */
const filled = (value: string | undefined): boolean => Boolean(value && value.trim());

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
          needs: `agents.${agent.name}.telegram`,
          ready: filled(settings.agents[agent.name]?.telegram),
          settings: how,
        };
      }
      if (channel.name === "slack") {
        const slack = settings.agents[agent.name]?.slack;
        return {
          name: "slack",
          does: "A Slack app. It answers in a direct message or wherever it is invited.",
          needs: `agents.${agent.name}.slack`,
          ready: filled(slack?.bot_token) && filled(slack?.app_token),
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
 * and whichever of its tools leave the machine. A tool that only touches this
 * disk is not here, because nothing outside is involved in it.
 */
export function connectionsOf(agent: Agent): Way[] {
  const has = (tool: string) => Object.keys(agent.tools ?? {}).includes(tool);
  const model = modelFor(agent);
  const provider = model.split("/")[0];
  const via = settings.model.routes[provider] || settings.model.via;
  const out: Way[] = [
    via === "gateway" || !via
      ? {
          name: "model gateway",
          does: `Where ${model} is asked. Every run of this agent goes through it.`,
          needs: "model.key",
          ready: filled(settings.model.key),
        }
      : {
          name: `${via} CLI`,
          does: `Where ${model} is asked, over a subscription rather than a key.`,
          needs: "",
          ready: null,
        },
  ];
  if (has("send_email")) {
    out.push(
      settings.email.provider === "resend"
        ? {
            name: "resend",
            does: "Where its mail is sent. Without a key nothing is sent and nothing fails.",
            needs: "resend.api_key",
            ready: filled(settings.resend.api_key),
          }
        : {
            name: "no mail provider",
            does: "Mail is written to the log and sent nowhere.",
            needs: "email.provider",
            ready: null,
          },
    );
  }
  if (has("read_mail")) {
    out.push({
      name: "google",
      does: "The account its mail is read from.",
      needs: "google.account",
      ready: filled(settings.google.account) && filled(settings.google.password),
    });
  }
  if (has("read_web")) {
    out.push({ name: "the web", does: "It can fetch a page. Nothing is needed for that.", needs: "", ready: null });
  }
  return out;
}
