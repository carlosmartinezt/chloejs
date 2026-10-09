// What a job does, checked by running it.
//
// A job is code, so it is tested rather than scored: `npm run evals` is for
// the prompts, and this is for the machinery underneath them. Each file in
// ops/test/ is one part of the runtime and runs its cases as it loads, in the
// order below. ops/test/shared.ts sets up the stand-ins they all use, and is
// imported first.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { failed } from "#chloe/ops/check";
import { gateway } from "./test/shared.ts";

for (const part of ["steps", "settings", "google", "connections", "routes", "loading"]) await import(`./test/${part}.ts`);

// Then whatever the repo that installed chloe tests about its own jobs. A
// file named `<job>.test.ts` anywhere in an agent's folder runs its cases as
// it loads, so there is no list of them to keep and nothing to register.
for (const agent of (await (await import("@chloejs/core")).loadAll()).values()) {
  for (const found of await readdir(agent.folder, { recursive: true, withFileTypes: true })) {
    if (!found.isFile() || !found.name.endsWith(".test.ts")) continue;
    await import(pathToFileURL(join(found.parentPath, found.name)).href);
  }
}

for (const part of [
  "files",
  "telegram",
  "slack",
  "whatsapp",
  "email",
  "api-channel",
  "web-channel",
  "turns",
  "notes",
  "services",
  "server",
  "memory-routes",
  "people",
  "setup",
]) {
  await import(`./test/${part}.ts`);
}

await rm(process.env.CHLOE_STATE!, { recursive: true, force: true });
gateway.close();
console.log(failed() === 0 ? "\nAll clear." : `\n${failed()} to fix above.`);
process.exit(failed() === 0 ? 0 : 1);
