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

import { setting } from "#chloe/core/settings.ts";

/** `choices` is every answer that fits, when there are few enough to list: a channel may show them as buttons. */
export type Send = (to: string, text: string, choices?: string[]) => Promise<void>;

const ways = new Map<string, Send>();

/**
 * Called once per channel that can carry a question out. With an agent, it is
 * that agent's way out only: two agents on Telegram are two bots, and a
 * question from one must not arrive from the other.
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

/** An address, `channel:who`, as its two halves. */
export function split(address: string): { channel: string; to: string } {
  const at = address.indexOf(":");
  if (at < 1 || at === address.length - 1) {
    throw new Error(`${JSON.stringify(address)} is not an address. Write it as "channel:who", like "telegram:12345".`);
  }
  return { channel: address.slice(0, at), to: address.slice(at + 1) };
}

/**
 * Whether a channel that is running for that agent could deliver to that
 * address.
 */
export function canReach(address: string, agent = ""): boolean {
  try {
    return Boolean(way(split(address).channel, agent));
  } catch {
    return false;
  }
}

/**
 * Sends text to an address through whichever channel is running for that
 * agent, with buttons when choices are given.
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
  await send(to, text, choices);
}

const owners = new Map<string, string>();

/** A channel says who an agent's person is: the first chat it lets in. */
export function ownedBy(agent: string, address: string): void {
  owners.set(agent, address);
}

/** Who a run belongs to when nothing says otherwise. */
export function owner(agent = ""): string {
  return setting(owners.get(agent) ?? "", "OWNER");
}
