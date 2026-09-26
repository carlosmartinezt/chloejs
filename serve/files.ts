// An agent's own folder, read from the page and written back to.
//
// Markdown is writable and nothing else is. Words are what the page is for,
// and the watcher makes a saved skill live in under a second. A .ts saved from
// a browser would be live just as fast with nothing type checking it, so code
// is edited where `npm run check` runs.
//
// The agent's memory is never reached from here, even when it is a folder
// inside this one: a token may read these routes, and every read of a memory
// is recorded first, by serve/memory.ts and nothing else.
//
// The edge of the folder is confine()'s job, inside the calls below: a path
// from the page is as untrusted as a path from a model.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { confine } from "#chloe/core/confine.ts";
import { agentDir, memoryDir } from "#chloe/core/paths.ts";
import { listFiles, readFiles, writeFiles } from "#chloe/services/filesService.ts";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  children?: Entry[];
}

/** Deep enough for any agent folder, and an end to it if something links in a circle. */
const DEPTH = 6;

/** Made by a program, not by anybody, so it is not part of what an agent is. */
const JUNK = ["__pycache__", "node_modules"];

/** Whether a path is the agent's memory or inside it, however either is reached. */
function inMemory(agent: string, path: string): boolean {
  const memory = memoryDir(agent);
  if (!memory || !existsSync(memory)) return false;
  const real = realpathSync(memory);
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // Not there yet, or a broken link: compared as written.
  }
  return resolved === real || resolved.startsWith(real + sep);
}

/** Everything in one agent's folder, folders first, as a tree. */
export async function tree(agent: string, path = "", depth = 0): Promise<Entry[]> {
  const { entries } = await listFiles(agentDir(agent), path || undefined);
  const out: Entry[] = [];
  for (const entry of entries) {
    const dir = entry.endsWith("/");
    const name = dir ? entry.slice(0, -1) : entry;
    if (JUNK.includes(name)) continue;
    const at = path ? `${path}/${name}` : name;
    if (inMemory(agent, join(agentDir(agent), at))) continue;
    out.push({
      name,
      path: at,
      dir,
      children: dir && depth < DEPTH ? await tree(agent, at, depth + 1) : undefined,
    });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** What the page may write back. */
export const editable = (path: string): boolean => path.endsWith(".md");

/**
 * One thing in the folder, whichever kind it is. Every path in the tree is an
 * address, so a folder answers with what is in it rather than with an error.
 * Nothing there is `null`, which the route turns into a 404, and so is the
 * agent's memory.
 */
export async function open(agent: string, path: string) {
  const resolved = confine(agentDir(agent), path);
  if (!existsSync(resolved) || inMemory(agent, resolved)) return null;
  if (statSync(resolved).isDirectory()) {
    return { path, dir: true as const, entries: await tree(agent, path) };
  }
  const file = await readFiles(agentDir(agent), path);
  return { path, dir: false as const, content: file.content, editable: editable(path) };
}

export async function save(agent: string, path: string, content: string) {
  if (!editable(path)) throw new Error(`${path} is not markdown.`);
  if (inMemory(agent, confine(agentDir(agent), path))) throw new Error(`${path} is in the agent's memory.`);
  const written = await writeFiles(agentDir(agent), path, content);
  return { path, bytes: written.bytes };
}
