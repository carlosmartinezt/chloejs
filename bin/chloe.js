#!/usr/bin/env node
// What `npx chloe` reaches. Plain JavaScript and never compiled, because it is
// the one file that has to run before anything has decided which copy of the
// runtime to load.
//
// Two shapes of install, and they load different files:
//
//   installed    node_modules/@chloejs/core is the published package. dist/ is
//                all there is, and it is imported here in this process.
//   by path      a symlink to a clone of the chloejs repo. The source is the
//                copy being worked on and dist/ beside it may be stale or
//                missing, so node is started again with the condition that
//                picks the source. Running the stale one against a service
//                that runs the source is the thing this avoids.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = fileURLToPath(new URL("ops/cli.ts", root));

if (!existsSync(source)) {
  await import(new URL("dist/ops/cli.js", root).href);
} else {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--conditions=chloe-source", source, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  // Passed on rather than left to the terminal, so a chloe started by a script
  // still stops when whatever started it is asked to.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
