// The page while you are working on it: `npm run dev:site`.
//
// It builds, and rebuilds on every edit. It serves nothing, because it does not
// have to: the runtime serves site/page/ itself, so the page is on the runtime's own
// address and there is one origin, one port and no proxy. Reload the browser
// after an edit and the new build is what it gets.
import { context } from "esbuild";

// Imported for its side effect as well as its parts: this builds once, and the
// two option objects are what the watchers watch with.
import { out, script, sheet } from "./build.ts";

for (const options of [script, sheet]) await (await context(options)).watch();

console.log(`Watching. Every edit rebuilds into ${out}.`);
console.log("The runtime serves it: open http://127.0.0.1:3067 and reload after an edit.");
