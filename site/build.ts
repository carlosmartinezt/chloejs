// The runtime's page as files on disk: `npm run build:site`, and everything a
// browser needs lands in site/page/, which serve/page.ts serves. React and
// esbuild are only needed here, so a project that installs the runtime installs
// neither.
//
// Importing this file builds once, which is what dev.ts wants before it starts
// watching. The two option objects are exported for it to watch with, so there
// is one description of how the page is built and not two.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { build, type BuildOptions, type Plugin } from "esbuild";

const dir = import.meta.dirname;
export const out = `${dir}/page`;

/**
 * What the built index.html points at. Each address carries what its file
 * holds, so a new build is new addresses: no browser, edge cache or proxy
 * serves the old bundle after a deploy. Same names on disk, so nothing else
 * changes. Runs after every build, including each rebuild while watching.
 */
async function versioned(): Promise<void> {
  const short = async (file: string): Promise<string> => {
    try {
      return createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 12);
    } catch {
      return "pending";
    }
  };
  const css = await short(`${out}/page.css`);
  const js = await short(`${out}/page.js`);
  const html = await readFile(`${dir}/index.html`, "utf8");
  await writeFile(
    `${out}/index.html`,
    html.replace("/page.css", `/page.css?v=${css}`).replace("/page.js", `/page.js?v=${js}`),
  );
}

const version: Plugin = {
  name: "version",
  setup(task) {
    task.onEnd(() => versioned());
  },
};

export const script: BuildOptions = {
  entryPoints: [`${dir}/main.tsx`],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  minify: true,
  outfile: `${out}/page.js`,
  plugins: [version],
};

/**
 * The mark is inlined, being small. The font is written to page/fonts/
 * under names that carry what they hold, like the bundles, so a new font is a
 * new address.
 */
export const sheet: BuildOptions = {
  entryPoints: [`${dir}/static/styles.css`],
  bundle: true,
  minify: true,
  loader: { ".png": "dataurl", ".woff2": "file" },
  assetNames: "fonts/[name]-[hash]",
  outfile: `${out}/page.css`,
  plugins: [version],
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await Promise.all([build(script), build(sheet)]);

// The watcher builds already rewrote this after each bundle; once more now
// that every bundle is final, so no address names a file half written.
await versioned();

// Named by plain absolute paths, so every address the page answers on finds
// them. notes/ is what the runtime adds to an HTML note shown from a memory:
// note-head.html goes into its head, and names the other two.
await cp(`${dir}/static/icon.png`, `${out}/icon.png`);
await cp(`${dir}/manifest.webmanifest`, `${out}/manifest.webmanifest`);
await cp(`${dir}/static/icons`, `${out}/icons`, { recursive: true });
await cp(`${dir}/static/fonts/OFL-google-sans-code.txt`, `${out}/fonts/OFL-google-sans-code.txt`);
await cp(`${dir}/notes`, out, { recursive: true });
