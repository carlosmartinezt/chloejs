// The files people send an agent, kept on disk so its scripts can open them.
//
// A message's files go to the model as they are. An agent that can run
// scripts also gets each one saved here, and the path in the message, so a
// script can be handed it. Each agent has its own folder in the state folder,
// and a file is kept for KEEP_DAYS.
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { STATE } from "#chloe/core/paths";

/** How long a file someone sent is kept, in days. */
export const KEEP_DAYS = 30;

/** The folder an agent's received files are kept in: `received/<agent id>` in the state folder. */
export function receivedFolder(agent: string): string {
  return `${STATE}/received/${agent}`;
}

/**
 * Saves one file a person sent the agent, and returns its full path. The name
 * is the time it came and its own name made safe, like
 * `2026-10-12T14-03-22-form.pdf`, so two files with one name both stay. Files
 * in that folder older than `KEEP_DAYS` are deleted first.
 *
 * - `agent`: the agent's id.
 * - `name`: the file's name as it was sent. Default: "file".
 * - `data`: its contents.
 */
export async function keepReceived(agent: string, name: string | undefined, data: Buffer): Promise<string> {
  const folder = receivedFolder(agent);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await forget(folder);
  const safe = basename(name || "file").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(-100) || "file";
  const path = `${folder}/${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}-${safe}`;
  await writeFile(path, data, { mode: 0o600 });
  return path;
}

/** Deletes the files in `folder` older than `KEEP_DAYS`. */
async function forget(folder: string): Promise<void> {
  const before = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of await readdir(folder).catch(() => [])) {
    const info = await stat(`${folder}/${name}`).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < before) await unlink(`${folder}/${name}`).catch(() => {});
  }
}
