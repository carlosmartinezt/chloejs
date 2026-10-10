#!/usr/bin/env node
// What `npx chloe` and the service run: the server, with chloe.config.ts. The
// server itself is `startChloe` in serve/start.ts, kept apart so this file is only
// ever run and never imported by the project it loads.
import { startChloe } from "#chloe/serve/start";

await startChloe(undefined, { remote: process.argv.includes("--remote") });
