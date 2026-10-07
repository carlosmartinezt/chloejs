// Tokens for other systems, from a shell on the box that runs chloe.
//
//   npx chloe tokens                              every token, revoked ones included
//   npx chloe tokens make <name>                  a token for the API
//   npx chloe tokens make <name> --agent <id>     one that reaches that agent and nothing else
//   npx chloe tokens revoke <id>                  stops one working, now
//
// The same three things the dashboard does, so setting an agent up never needs
// a browser: a web chat box needs a token made for its agent, and whoever is
// setting it up may be a program with no way to click. It writes the same file
// the service reads, and the service reads it again when it changes, so a token
// made here works at once, with chloe running or not.
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { agent: { type: "string" } },
  allowPositionals: true,
});
const [word, ...rest] = positionals;

try {
  const { makeToken, revokeToken, tokens } = await import("#chloe/serve/tokens");

  if (!word) {
    const all = tokens();
    if (all.length === 0) console.log("No tokens yet. npx chloe tokens make <name> makes one.");
    for (const one of all) {
      const state = one.revoked ? `revoked ${one.revoked.slice(0, 10)}` : one.lastUsed ? `last used ${one.lastUsed.slice(0, 10)}` : "never used";
      console.log(`${one.id}  ${one.name}${one.agent ? ` (${one.agent} only)` : ""}  made ${one.created.slice(0, 10)}, ${state}`);
    }
  } else if (word === "make") {
    const name = rest.join(" ").trim();
    if (!name) throw new Error("Say what it is for: npx chloe tokens make <name>.");
    if (values.agent) {
      // Asked of the config rather than trusted, because a token for an agent
      // that is not there would be made, kept, and never work.
      const { agentIds } = await import("#chloe/load/load");
      const ids = await agentIds();
      if (!ids.includes(values.agent)) throw new Error(`chloe.config.ts has no agent called ${values.agent}. It has: ${ids.join(", ")}.`);
    }
    const { secret, token } = makeToken(name, values.agent);
    console.log(secret);
    console.error(
      `\nThat is the token, and the only time it is shown: only its hash is kept. Its id is ${token.id}, for revoking it.` +
        (values.agent ? `\nIt reaches ${values.agent} and nothing else.` : ""),
    );
  } else if (word === "revoke") {
    const [id] = rest;
    if (!id) throw new Error("Say which: npx chloe tokens revoke <id>. npx chloe tokens lists the ids.");
    const token = revokeToken(id);
    console.log(`${token.name} no longer works.`);
  } else {
    throw new Error(`npx chloe tokens takes make or revoke, or nothing to list them, not "${word}".`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
