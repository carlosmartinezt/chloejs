// How a question reaches a person, and nothing else.
//
// An address is "channel:who", like "telegram:12345". The channel half is
// looked up here, so chloe/ knows that questions go out somewhere without
// knowing that Telegram exists: index.ts registers the ways in and out, the
// same way it binds a channel's routes.
//
// This is the piece the team version needs first. An address already names one
// person, so the day there are two, an ask goes to the right one without any
// of this changing.

import { holdBack } from "#chloe/core/current";
import { settings } from "#chloe/core/settings";

/**
 * A function that sends a message to one person on a channel.
 *
 * `to` is the part of the address after the `:`, such as `12345` in
 * `telegram:12345`. `choices` lists the possible answers when there are only
 * a few, so the channel can show them as buttons.
 */
export type Send = (to: string, text: string, choices?: string[]) => Promise<void>;

const ways = new Map<string, Send>();

/**
 * Tells chloe how to send messages on a channel, so a job's `ask` can reach
 * people there. A channel you write yourself calls this once, when it starts.
 *
 * `channel` is the first part of an address, such as `telegram`. Pass the
 * agent's id as `agent` so that only this agent's messages go out this way:
 * two agents on Telegram are two bots, and a question from one must not come
 * from the other. Without `agent`, it is used for any agent that has no way
 * of its own on that channel.
 */
export function reachBy(channel: string, send: Send, agent = ""): void {
  ways.set(agent ? `${agent}/${channel}` : channel, send);
}

/** Taking a way out back, when a channel stops. */
export function unreach(channel: string, agent = ""): void {
  ways.delete(agent ? `${agent}/${channel}` : channel);
}

function way(channel: string, agent: string): Send | undefined {
  return (agent && ways.get(`${agent}/${channel}`)) || ways.get(channel);
}

/**
 * Splits an address such as `telegram:12345` into its two parts:
 * `{ channel: "telegram", to: "12345" }`. Throws if the text is not an address.
 */
export function split(address: string): { channel: string; to: string } {
  const at = address.indexOf(":");
  if (at < 1 || at === address.length - 1) {
    throw new Error(`${JSON.stringify(address)} is not an address. Write it as "channel:who", like "telegram:12345".`);
  }
  return { channel: address.slice(0, at), to: address.slice(at + 1) };
}

/**
 * Returns `true` if a running channel can send to this address for this
 * agent. It checks the channel part only, not that the person exists.
 * Returns `false` for text that is not an address.
 */
export function canReach(address: string, agent = ""): boolean {
  try {
    return Boolean(way(split(address).channel, agent));
  } catch {
    return false;
  }
}

/**
 * Sends a message to an address, such as `telegram:12345`, through the
 * channel running for that agent. Pass `choices` to show the possible answers
 * as buttons, where the channel can.
 *
 * Throws if no running channel can reach the address. In a trial run it
 * sends nothing, and the run's record keeps what it would have sent.
 */
export async function deliver(address: string, text: string, agent = "", choices?: string[]): Promise<void> {
  const { channel, to } = split(address);
  const send = way(channel, agent);
  // Refuse rather than park a run nobody will ever see a question from.
  if (!send) {
    throw new Error(
      `Nothing here can reach ${JSON.stringify(channel)}. Registered: ${[...ways.keys()].join(", ") || "none"}.`,
    );
  }
  if (holdBack({ kind: "message", to: address, text })) return;
  await send(to, text, choices);
}

const owners = new Map<string, string>();

/** A channel says who an agent's person is: the first chat it lets in. */
export function ownedBy(agent: string, address: string): void {
  owners.set(agent, address);
}

/**
 * Returns the address of the agent's owner, such as `telegram:12345`. A job's
 * questions and approvals go to this person when no one else is named.
 *
 * It is `owner` in settings, if set. If not, it is the first id in
 * `allowFrom` of the agent's Telegram, Slack or WhatsApp channel. Returns
 * `""` if there is neither.
 */
export function owner(agent = ""): string {
  return settings.owner || owners.get(agent) || "";
}
