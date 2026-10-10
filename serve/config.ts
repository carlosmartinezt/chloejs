// chloe.config.ts, read and written from the page. A save is loaded as the
// next reload would load it, and type checked when the project has
// TypeScript, and put back with the reason when either fails.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { envNames } from "#chloe/core/env";
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
