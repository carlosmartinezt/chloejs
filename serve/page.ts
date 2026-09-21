// Finding a better page than the built-in one, if the repo installed a package
// that offers it.
//
// The runtime does not know chloejs-ui exists. It knows a convention: any
// installed package whose package.json has a "chloePage" naming a folder with
// an index.html in it is offering a page, and the first one found is served
// instead of site.ts's. That is what makes `npm install chloejs-ui` upgrade the
// site with nothing configured, and what lets somebody else's dashboard take
// its place the same way.
//
// Looked for once, at startup. A package installed while the process is running
// is not picked up until it restarts, which is the same as every other
// dependency.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { ROOT } from "#chloe/core/paths.ts";

export interface Page {
  /** The package that offered it, for saying so at startup. */
  name: string;
  /** The folder its index.html is in. */
  dir: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

let scanned: Page | null | undefined;

/**
 * The installed page, or null when there is none. node_modules is walked once
 * and the answer kept.
 *
 * CHLOE_PAGE=builtin ignores whatever is installed and serves the runtime's
 * own site instead. That is how you tell a broken dashboard from a broken
 * runtime without uninstalling anything.
 */
export function installedPage(): Page | null {
  if (process.env.CHLOE_PAGE === "builtin") return null;
  if (scanned === undefined) scanned = pageIn(`${ROOT}/node_modules`);
  return scanned;
}

/** The first package in a node_modules folder that offers a page, or null. */
export function pageIn(modules: string): Page | null {
  if (!existsSync(modules)) return null;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    // A scope holds packages rather than being one.
    const packages = entry.name.startsWith("@")
      ? readdirSync(`${modules}/${entry.name}`).map((one) => `${entry.name}/${one}`)
      : [entry.name];
    for (const name of packages) {
      const offered = offers(`${modules}/${name}`);
      if (offered) return { name, dir: offered };
    }
  }
  return null;
}

let head: string | undefined;

/**
 * What the installed page wants at the top of every HTML file shown from a
 * memory: the contents of `note-head.html` in its folder, or "" when it has
 * none. Its links should be root-relative, like `/notes.css`, since the page's
 * own files are served at the root. Read once, like the page itself.
 */
export function noteHead(): string {
  if (head !== undefined) return head;
  const page = installedPage();
  const file = page ? `${page.dir}/note-head.html` : "";
  head = file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return head;
}

/** The folder a package offers as a page, if it offers one and it is really there. */
function offers(dir: string): string | null {
  let declared: unknown;
  try {
    declared = (JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { chloePage?: unknown }).chloePage;
  } catch {
    return null;
  }
  if (typeof declared !== "string" || !declared) return null;
  const at = resolve(dir, declared);
  // A package that says it has a page but has not been built yet is not an
  // error worth stopping for: the built-in page is still there.
  if (!existsSync(`${at}/index.html`)) {
    console.error(`${dir} offers a page at ${declared}, but there is no index.html in it. Has it been built?`);
    return null;
  }
  return at;
}

/**
 * Serves one file out of the page's folder, or the page itself.
 *
 * A file that is there is that file. Anything else is one of the page's own
 * addresses, so it gets index.html and the browser works out which view it is.
 * That is a proxy's `try_files {path} /index.html`.
 *
 * It used to decide by whether the address had a dot in it, which is right for
 * /page.js and wrong for /agents/chloe/memory/notes/curriculum.html: an address
 * inside the page can name a file somewhere else, and a dot in it is not a
 * reason to go looking for that file here. Every deep link to a memory file was
 * a 404.
 */
export async function servePageFile(response: ServerResponse, page: Page, path: string): Promise<boolean> {
  const asked = path.includes(".") ? inside(page.dir, path) : null;
  const found = asked && existsSync(asked) && statSync(asked).isFile() ? asked : `${page.dir}/index.html`;
  try {
    const body = await readFile(found);
    response.writeHead(200, { "content-type": TYPES[extname(found)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not here.\n");
  }
  return true;
}

/** Keeps a browser's path inside the page's folder. */
function inside(dir: string, path: string): string | null {
  const at = resolve(join(dir, path));
  return at === dir || at.startsWith(dir + sep) ? at : null;
}
