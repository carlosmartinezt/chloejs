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
 * Resolve `input` inside `root`, or throw. Accepts a path relative to the
 * folder or the absolute form of the same file. Symlinks are resolved first, so
 * a link inside the folder cannot point out of it. A path that does not exist
 * yet is fine: a write needs one.
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
