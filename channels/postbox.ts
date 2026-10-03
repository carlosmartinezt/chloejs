// Collecting from a post box: a service somewhere else that takes deliveries
// this runtime cannot take itself, because nothing reaches in here, and holds
// them sealed until it is asked. WhatsApp's messages arrive this way, and so do
// emails.
//
// A box is asked for once and kept in the state folder, under the kind of
// channel and the agent, so a restart keeps the same address. The private half
// of the sealing key never leaves that file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STATE } from "#chloe/core/paths";
import { newKeys, unseal, type Sealed } from "#chloe/core/sealed";

/** A post box as this runtime knows it: which box, the key that collects from it, and where. */
export interface Box {
  id: string;
  key: string;
  privateKey: string;
  /** The address deliveries are posted to. */
  at: string;
}

function fileOf(kind: string, agent: string, channel: string): string {
  return join(STATE, kind, `${agent}-${channel}.json`);
}

/** The box this channel collects from, as it was kept, or undefined before one was asked for. */
export function keptBox(kind: string, agent: string, channel: string): Box | undefined {
  try {
    return JSON.parse(readFileSync(fileOf(kind, agent, channel), "utf8")) as Box;
  } catch {
    return undefined;
  }
}

/** This channel's box: the one kept, or a new one asked of `postBox` and kept. */
export async function boxFor(kind: string, agent: string, channel: string, postBox: string): Promise<Box> {
  const file = fileOf(kind, agent, channel);
  if (existsSync(file)) {
    const kept = JSON.parse(readFileSync(file, "utf8")) as Box;
    return { ...kept, at: kept.at || `${postBox}/hook/${kept.id}` };
  }
  const keys = newKeys();
  const response = await fetch(`${postBox}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: keys.publicKey }),
    signal: AbortSignal.timeout(30_000),
  });
  const given = (await response.json().catch(() => ({}))) as { id?: string; key?: string; error?: string };
  if (!given.id || !given.key) throw new Error(`${postBox} would not give out a post box: ${given.error ?? response.status}`);
  const mine = { id: given.id, key: given.key, privateKey: keys.privateKey, at: `${postBox}/hook/${given.id}` };
  mkdirSync(join(STATE, kind), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(mine, null, 2), { mode: 0o600 });
  return mine;
}

/**
 * Asks the box for deliveries, over and over, and asks again the moment it
 * answers. One request is held open for up to half a minute, so a delivery
 * arrives about as fast as it would have down a port. A request that fails waits
 * a little and tries again: the box being down delays deliveries and loses none.
 *
 * Each delivery is opened and handed to `open` with the signature it came with.
 * The box is told it may forget them only once `open` has dealt with all of
 * them, so a crash halfway leaves them in the box. `label` starts every line
 * written to the log.
 */
export async function collectFrom(
  box: Box,
  options: { label: string; signal: AbortSignal; open: (body: string, signature?: string) => Promise<void> },
): Promise<void> {
  const { label, signal, open } = options;
  let wait = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${box.at}/messages?wait=25`, {
        headers: { authorization: `Bearer ${box.key}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      });
      if (!response.ok) throw new Error(`asking for messages: ${response.status}`);
      const { messages = [] } = (await response.json()) as { messages?: { id: string; sealed: Sealed }[] };
      wait = 0;
      const took: string[] = [];
      for (const one of messages) {
        took.push(one.id);
        try {
          const { body, signature } = JSON.parse(unseal(box.privateKey, one.sealed)) as { body: string; signature?: string };
          await open(body, signature);
        } catch (error) {
          console.error(`${label}: a delivery from the post box could not be opened:`, (error as Error).message);
        }
      }
      if (took.length) {
        await fetch(`${box.at}/collected`, {
          method: "POST",
          headers: { authorization: `Bearer ${box.key}`, "content-type": "application/json" },
          body: JSON.stringify({ ids: took }),
          signal: AbortSignal.timeout(30_000),
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      wait = Math.min(60_000, wait ? wait * 2 : 2000);
      console.warn(`${label} could not collect from the post box, trying again in ${Math.round(wait / 1000)}s:`, (error as Error).message);
      await new Promise((done) => setTimeout(done, wait));
    }
  }
}
