// A link that opens the page signed in.
//
//   npx chloe link
//
// It signs one browser in, once, within the hour. Making one reads the account
// file, so it takes a shell on this box, the same as `npx chloe account`. It is
// the way in to a copy with no password, and works on one that has one.
import { existsSync } from "node:fs";

import { CONFIG, loadSettings } from "#chloe/load/load";
import { ownAddress, remoteAddress } from "#chloe/serve/http";
import { makeLink } from "#chloe/serve/login";

// Read from the same settings the server read, so the link has its port.
if (existsSync(CONFIG)) await loadSettings();
const address = ownAddress();

console.log(makeLink(address));
console.log("It signs one browser in, once, within the hour.");
if (process.env.SSH_CONNECTION) console.log(`From your own computer, while npx chloe --remote runs: ${makeLink(remoteAddress())}`);

// The link is good either way; it only opens anything while the server runs.
try {
  await fetch(`${address}/api/account`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`Nothing answers at ${address} yet: start chloe with npx chloe, then open it.`);
}
