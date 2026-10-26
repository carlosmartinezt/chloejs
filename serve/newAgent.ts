// A new agent, made from the page: its files written and its line added to
// chloe.config.ts, on this computer or in a machine of its own. No model is
// asked anything: the same request makes the same agent. The record of it is
// the config, as for any agent: its line in `agents` here, or its
// `serve.elsewhere` entry and key when it runs in a machine.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeEnv } from "#chloe/core/env";
import { ROOT } from "#chloe/core/paths";
import { nameInEnv, settings } from "#chloe/core/settings";
import { AGENT_ID, newAgentFiles } from "#chloe/load/newAgent";
import type { Place } from "#chloe/load/plugin";
import { PLUGINS } from "#chloe/plugins/index";
import { addAgentIn, configText, saveConfig, setInConfig } from "./config.ts";
import { BadRequest } from "./errors.ts";

/** Where a new agent can run: this computer, then each place a plugin adds, with why one cannot be used here. */
export async function places(): Promise<{ name: string; label: string; about: string; missing: string }[]> {
  return [
    { name: "here", label: "This computer", about: "A folder beside the others, in this copy. No shell.", missing: "" },
    ...(await Promise.all(PLUGINS.flatMap((one) => one.places ?? []).map(async (one) => ({ name: one.name, label: one.label, about: one.about, missing: await one.missing() })))),
  ];
}

/** The ids being made now, so two requests for one id do not both make it. */
const making = new Set<string>();

/**
 * Makes an agent with that id in `where`, a name from `places()`, and lists it
 * in chloe.config.ts. `taken` is every id this copy already shows. Refused
 * when the id is not one, is taken, or the place cannot be used here.
 */
export async function makeAgent(given: { id: string; name?: string; model?: string; where: string }, taken: string[]): Promise<void> {
  const { id, where } = given;
  const name = given.name?.trim() || undefined;
  if (!AGENT_ID.test(id)) throw new BadRequest("An id is lower case letters, digits and dashes, starting with a letter, like \"inbox\".");
  if (taken.includes(id) || making.has(id)) throw new BadRequest(`There is already an agent called ${id}.`);
  making.add(id);
  try {
    if (where === "here") return await makeHere(id, name, given.model?.trim() || undefined);
    const place = PLUGINS.flatMap((one) => one.places ?? []).find((one) => one.name === where);
    if (!place) throw new BadRequest(`${where} is not somewhere an agent can run here. See GET /api/places.`);
    await makeIn(place, id, name, given.model?.trim() || settings.model.defaultModel);
  } finally {
    making.delete(id);
  }
}

/** Its folder in agents/, and its line in the config. The folder goes again when the config would not load. */
async function makeHere(id: string, name: string | undefined, model: string | undefined): Promise<void> {
  const folder = join(ROOT, "agents", id);
  if (existsSync(folder)) throw new BadRequest(`agents/${id} is already there. Pick another id, or list that folder in chloe.config.ts.`);
  const text = addAgentIn(await configText(), id, `./agents/${id}/agent.ts`);
  await mkdir(folder, { recursive: true });
  try {
    for (const [file, body] of Object.entries(newAgentFiles({ id, name, model }))) await writeFile(join(folder, file), body);
    await saveConfig(text);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

/** A machine made by the place, then its entry in `serve.elsewhere` and its key in .env. */
async function makeIn(place: Place, id: string, name: string | undefined, model: string): Promise<void> {
  const missing = await place.missing();
  if (missing) throw new BadRequest(missing);
  if (!model) throw new BadRequest("Say which model it uses: this copy has no model.defaultModel to give it.");
  // Refused now, before a machine is made, when the config's settings are code.
  setInConfig(await configText(), ["serve", "elsewhere", id], "{}");

  const made = await place.make({ id, files: newAgentFiles({ id, name, shell: true }), model });
  const key = nameInEnv(["serve", "elsewhere", id, "key"]);
  const entry = `{ address: ${JSON.stringify(made.address)}, key: process.env.${key}, start: [${made.start.map((one) => JSON.stringify(one)).join(", ")}] }`;
  writeEnv({ [key]: made.key });
  try {
    await saveConfig(setInConfig(await configText(), ["serve", "elsewhere", id], entry));
  } catch (error) {
    writeEnv({ [key]: null });
    throw new Error(`The machine for ${id} was made, and is not listed: ${(error as Error).message}`);
  }
}
