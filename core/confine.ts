// Keeping a caller-supplied path inside one folder.
//
// This is the boundary, so it is code and not a sentence in a prompt: nothing
// a model says can talk its way past it. It knows nothing about what is in the
// folder, only where the folder ends, and the few things no folder ever hands
// out: credentials, and chloe's own records.
//
// The records matter because an agent's folder can hold them. An agent defined
// in chloe.config.ts lives in the project folder, which holds `.env` and
// `data/`, where `login.json` has the secret that signs every session.
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { STATE } from "./paths.ts";

/** Never reachable through a file tool, whatever the folder is. */
const NEVER = [".git", ".ssh", "secrets", "node_modules"];

/** `.env`, `.env.local` and the like. */
const isEnv = (name: string) => name === ".env" || name.startsWith(".env.");

const within = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/** The state folder as it really is, or as written when it is not there yet. */
const state = () => (existsSync(STATE) ? realpathSync(STATE) : resolve(STATE));

/**
 * Whether `path` is chloe's state folder or inside it, reached from a folder
 * that is not. A memory kept inside the state folder still reads its own files.
 */
function inState(base: string, path: string): boolean {
  return within(path, state()) && !within(base, state());
}

/**
 * Whether a name is one of those, or `full`, when given, is the state folder.
 * For something listing a folder, which should leave them out rather than show
 * a folder that cannot be opened, and should certainly not stop listing
 * everything else because one of them is there.
 */
export function unreachable(name: string, full?: string): boolean {
  if (NEVER.includes(name) || isEnv(name)) return true;
  if (!full) return false;
  try {
    return realpathSync(full) === state();
  } catch {
    return resolve(full) === state();
  }
}

/**
 * Returns the full path of `input`, after checking that it is inside the
 * folder `root`. Throws if it is not. Use it before you read or write a file
 * whose path came from a model or a person.
 *
 * `input` can be relative to `root`, or a full path inside it. If the path
 * exists, links in it are followed first, so a link inside the folder cannot
 * lead out of it. The path does not have to exist yet, so you can check a new
 * file before you write it.
 *
 * It also refuses any path that goes through `.git`, `.ssh`, `secrets` or
 * `node_modules`, any `.env` file, and the state folder from a folder that
 * holds it.
 */
export function confine(root: string, input: string): string {
  const base = realpathSync(root);
  const inside = (p: string) => p === base || p.startsWith(base + sep);

  const normalized = resolve(input.startsWith(base) ? input : resolve(base, input));
  if (!inside(normalized)) throw new Error(`Path is outside ${base}: ${input}`);

  const hit = normalized.slice(base.length).split(sep).find((part) => NEVER.includes(part) || isEnv(part));
  if (hit) throw new Error(`${hit} is not readable or writable through this tool.`);
  if (inState(base, normalized)) throw new Error(`${input} is chloe's own records, not readable or writable through this tool.`);

  try {
    const real = realpathSync(normalized);
    if (!inside(real)) throw new Error(`Path resolves outside ${base}: ${input}`);
    if (inState(base, real)) throw new Error(`${input} is chloe's own records, not readable or writable through this tool.`);
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalized;
    throw error;
  }
}
