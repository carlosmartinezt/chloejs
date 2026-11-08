// The files that are part of a conversation, kept in the agent's memory, and
// the files an agent makes on the way to sending one.
//
// A file somebody sent, or one the agent handed over, goes in `attachments/` in the
// agent's memory, where its owner can browse it and the agent can find it
// again later. That folder is kept out of the memory's history: a file deleted
// there is gone, and the history stays small.
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { STATE } from "#chloe/core/paths";

/** The folder in an agent's memory that conversations' files are kept in. */
export const FILES = "attachments";

/** How long a made file is kept, in days. */
export const KEEP_DAYS = 30;

/**
 * The folder an agent's made files wait in: `made/<agent id>` in the state
 * folder, for what is not worth keeping in its memory, like a picture from a
 * page or a worksheet. Made if it is not there, and files in it older than
 * `KEEP_DAYS` are deleted. A script is handed it as `MADE_FOLDER`.
 */
export async function madeFolder(agent: string): Promise<string> {
  const folder = madeFolderOf(agent);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await forget(folder);
  return folder;
}

/** Where `madeFolder` is, without making it. */
export function madeFolderOf(agent: string): string {
  return `${STATE}/made/${agent}`;
}

/**
 * Keeps one file of a conversation in `attachments/` in the agent's memory, and
 * returns its full path. The name is the time it came and its own name made
 * safe, like `2026-10-12T14-03-22-form.pdf`, so two files with one name both
 * stay. The folder holds a `.gitignore` of `*`, so whatever repository the
 * memory is in never takes these files into its history.
 *
 * - `memory`: the agent's memory folder.
 * - `name`: the file's name as it was sent. Default: "file".
 * - `data`: its contents.
 */
export async function keepInMemory(memory: string, name: string | undefined, data: Buffer): Promise<string> {
  const folder = `${memory}/${FILES}`;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(`${folder}/.gitignore`, "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  for (let n = 1; ; n++) {
    const path = `${folder}/${stamped(name, n)}`;
    const written = await writeFile(path, data, { mode: 0o600, flag: "wx" }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      },
    );
    if (written) return path;
  }
}

/**
 * Saves one file in the agent's made files (`madeFolder`), and returns its
 * full path, named as `keepInMemory` names one.
 *
 * - `agent`: the agent's id.
 * - `name`: the file's name. Default: "file".
 * - `data`: its contents.
 */
export async function keepMade(agent: string, name: string | undefined, data: Buffer): Promise<string> {
  const folder = await madeFolder(agent);
  const path = `${folder}/${stamped(name)}`;
  await writeFile(path, data, { mode: 0o600 });
  return path;
}

/** A file's name made safe, after the time now, like `2026-10-12T14-03-22-form.pdf`. */
function stamped(name: string | undefined, n = 1): string {
  const safe = basename(name || "file").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(-100) || "file";
  return `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}-${n > 1 ? `${n}-` : ""}${safe}`;
}

/** Deletes the files in `folder` older than `KEEP_DAYS`. */
async function forget(folder: string): Promise<void> {
  const before = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of await readdir(folder).catch(() => [])) {
    const info = await stat(`${folder}/${name}`).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < before) await unlink(`${folder}/${name}`).catch(() => {});
  }
}
