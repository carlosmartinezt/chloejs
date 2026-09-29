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
      if (channel.name === "telegram") {
        return {
          name: "telegram",
          does: "A Telegram bot. Anyone it is told to listen to can talk to this agent.",
          needs: `agents.${agent.name}.telegram`,
          ready: filled(settings.agents[agent.name]?.telegram),
        };
      }
      if (channel.name === "slack") {
        const slack = settings.agents[agent.name]?.slack;
        return {
          name: "slack",
          does: "A Slack app. It answers in a direct message or wherever it is invited.",
          needs: `agents.${agent.name}.slack`,
          ready: filled(slack?.bot_token) && filled(slack?.app_token),
        };
      }
      if (channel.name === "api") {
        return {
          name: "api",
          does: "A token another system holds may chat to this agent and run its jobs.",
          needs: "",
          ready: null,
        };
      }
      return { name: channel.name, does: "A way in of this agent's own.", needs: "", ready: null };
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
