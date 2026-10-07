// The page every address that is not /api answers with: site/ in this repo,
// built by `npm run build:site` into site/page/, which the package ships as
// dist/site/page/. It holds nothing of the agents': it asks the API, which
// asks for the login.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

/** The built page's folder, beside this file's own folder in the source and in dist/ alike. */
export const PAGE = fileURLToPath(new URL("../site/page", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

let head: string | undefined;

/**
 * What goes at the top of every HTML file shown from a memory: the page's
 * `note-head.html`, which names its stylesheet and script for notes, or ""
 * when the page is not built. Read once.
 */
export function noteHead(): string {
  if (head !== undefined) return head;
  const file = `${PAGE}/note-head.html`;
  head = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return head;
}

/**
 * Serves one file out of the page's folder, or the page itself.
 *
 * A file that is there is that file. Anything else is one of the page's own
 * addresses, so it gets index.html and the browser works out which view it is.
 * An address can name a file somewhere else, like
 * /agents/chloe/memory/notes/curriculum.html, so a dot in it is not a reason to
 * answer 404.
 */
export async function servePage(response: ServerResponse, path: string): Promise<void> {
  const asked = path.includes(".") ? inside(path) : null;
  const found = asked && existsSync(asked) && statSync(asked).isFile() ? asked : `${PAGE}/index.html`;
  try {
    const body = await readFile(found);
    response.writeHead(200, { "content-type": TYPES[extname(found)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    // Only a clone that has not been built gets here: the package ships it.
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end(`The page is not built. Run npm run build:site in ${resolve(PAGE, "../..")}.\n`);
  }
}

/** Keeps a browser's path inside the page's folder. */
function inside(path: string): string | null {
  const at = resolve(join(PAGE, path));
  return at === PAGE || at.startsWith(PAGE + sep) ? at : null;
}
