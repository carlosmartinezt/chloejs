// Keeping a caller-supplied path inside one folder.
//
// This is the boundary, so it is code and not a sentence in a prompt: nothing
// a model says can talk its way past it. It knows nothing about what is in the
// folder, only where the folder ends.
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Never reachable through a file tool, whatever the folder is. */
const NEVER = [".git", ".ssh", "secrets", "node_modules"];

/**
 * Whether a name is one of those. For something listing a folder, which should
 * leave them out rather than show a folder that cannot be opened, and should
 * certainly not stop listing everything else because one of them is there.
 */
export function unreachable(name: string): boolean {
  return NEVER.includes(name);
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
 * `node_modules`.
 */
export function confine(root: string, input: string): string {
  const base = realpathSync(root);
  const inside = (p: string) => p === base || p.startsWith(base + sep);

  const normalized = resolve(input.startsWith(base) ? input : resolve(base, input));
  if (!inside(normalized)) throw new Error(`Path is outside ${base}: ${input}`);

  const hit = normalized.slice(base.length).split(sep).find((part) => NEVER.includes(part));
  if (hit) throw new Error(`${hit} is not readable or writable through this tool.`);

  try {
    const real = realpathSync(normalized);
    if (!inside(real)) throw new Error(`Path resolves outside ${base}: ${input}`);
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalized;
    throw error;
  }
}
