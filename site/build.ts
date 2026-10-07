// Builds the runtime's own page into site/page.html, the one file the server
// sends (see serveOwnPage() in serve/page.ts): index.html with the script and
// the stylesheet written into it. React and esbuild are only needed here, so a
// project that installs the runtime installs neither.
import { readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const dir = import.meta.dirname;

const [script, sheet] = await Promise.all([
  build({
    entryPoints: [`${dir}/main.tsx`],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    minify: true,
    write: false,
  }),
  build({ entryPoints: [`${dir}/site.css`], bundle: true, minify: true, write: false }),
]);

// Replaced by a function, because a replacement string reads `$&` and its
// kind as patterns, and a minified bundle is full of dollar signs.
const page = (await readFile(`${dir}/index.html`, "utf8"))
  .replace("<!-- style -->", () => `<style>${sheet.outputFiles[0].text}</style>`)
  .replace("<!-- script -->", () => `<script type="module">${script.outputFiles[0].text}</script>`);

await writeFile(`${dir}/page.html`, page);
