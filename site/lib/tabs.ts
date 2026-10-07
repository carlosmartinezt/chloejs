// Which files are open in a memory, remembered per agent in this browser, so a
// reload does not throw away what you had open. Only the paths are kept.
//
// Opening a file always adds a tab. An editor's "preview" tab, where a single
// click replaces whatever the last one was showing, is deliberately not copied:
// it throws away the file you were just reading.

const KEY = (agent: string) => `chloe.memory.tabs.${agent}`;

export function loadTabs(agent: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY(agent)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
}

export function saveTabs(agent: string, tabs: string[]): void {
  try {
    localStorage.setItem(KEY(agent), JSON.stringify(tabs));
  } catch {
    // A private window, or storage that is full. The tabs still work until
    // the page is reloaded, which is all this was for.
  }
}

/** A tab's name: the file's own, since the path is in the breadcrumbs above it. */
export function tabName(path: string): string {
  return path.split("/").pop() || path;
}

/** Folders a tree has open, per agent, so the tree comes back as you left it. */
const OPEN = (agent: string) => `chloe.memory.open.${agent}`;

export function loadOpen(agent: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN(agent)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function saveOpen(agent: string, open: Set<string>): void {
  try {
    localStorage.setItem(OPEN(agent), JSON.stringify([...open]));
  } catch {
    // Same as above: it only costs the tree its shape across a reload.
  }
}

/**
 * The memory you were last in and the file you last had open in each, so the
 * Memory link goes back to where you were rather than to the top of the first
 * agent's.
 */
const LAST = "chloe.memory.last";
const LAST_FILE = (agent: string) => `chloe.memory.last.${agent}`;

export function lastAgent(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

export function lastFile(agent: string): string | undefined {
  try {
    return localStorage.getItem(LAST_FILE(agent)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** No path forgets the file, which is what closing every tab means. */
export function saveLast(agent: string, path?: string): void {
  try {
    localStorage.setItem(LAST, agent);
    if (path) localStorage.setItem(LAST_FILE(agent), path);
    else localStorage.removeItem(LAST_FILE(agent));
  } catch {
    // Only costs the Memory link its memory of where you were.
  }
}
