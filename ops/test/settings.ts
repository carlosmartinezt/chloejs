// Settings: the config, and the .env file it reads secrets from.

import { about, is } from "#chloe/ops/check";

{
  about("settings, and what wins");
  const { declareSettings, readSettings } = await import("@chloejs/core");

  const base = { model: { preferredRoute: ["gateway" as const], judgeModel: "a" } };
  is("a default fills in what the config does not mention", readSettings(base).model.gatewayUrl, "https://ai-gateway.vercel.sh/v1/chat/completions");
  is("what the config says is what it says", readSettings(base).model.preferredRoute, ["gateway"]);
  is("and one key declared leaves its neighbours alone", readSettings(base).model.judgeModel, "a");
  is("a setting nobody set is empty rather than missing", readSettings({}).node, "");
  is("the port listens on this machine only unless the config says", readSettings({}).serve, { host: "127.0.0.1", port: 3067, url: "" });
  let portAsText = "";
  try {
    readSettings({ serve: { port: "8080" } } as never);
  } catch (error) {
    portAsText = error instanceof Error ? error.message : "";
  }
  is("a port handed over from .env as text is refused, saying it is a number", portAsText.includes("serve.port is a number"), true);
  {
    const { settings } = await import("@chloejs/core");
    const { ownAddress } = await import("#chloe/serve/http");
    const before = settings.serve;
    settings.serve = { host: "0.0.0.0", port: 8080, url: "" };
    is("listening on every address is reached on loopback", ownAddress(), "http://127.0.0.1:8080");
    settings.serve = { host: "::1", port: 8080, url: "" };
    is("an IPv6 host goes in brackets", ownAddress(), "http://[::1]:8080");
    settings.serve = before;
  }
  is("each agent's own settings are under its name", readSettings({ agents: { tempo: { telegram: "t" } } }).agents.tempo.telegram, "t");
  is("and what it does not say is empty", readSettings({ agents: { tempo: { telegram: "t" } } }).agents.tempo.slack.app_token, "");
  let misspelt = "";
  try {
    readSettings({ agents: { tempo: { telegarm: "t" } } } as never);
  } catch (error) {
    misspelt = error instanceof Error ? error.message : "";
  }
  is("a misspelt key under an agent is refused rather than ignored", misspelt.includes("telegarm"), true);
  {
    const { settings, unclaimed } = await import("@chloejs/core");
    const before = settings.agents;
    settings.agents = { tempo: { telegram: "t", slack: { bot_token: "", app_token: "" }, whatsapp: { phone_number_id: "", token: "", app_secret: "" }, email: { address: "", password: "", imap: "", smtp: "" } } };
    is("an entry for an agent that exists is claimed", unclaimed(["tempo"]), []);
    is("one left behind by a rename is not", unclaimed(["growth"]), ["tempo"]);
    settings.agents = before;
  }
  // A config may hand a setting the variable itself, which is how it says where
  // a credential comes from without holding one.
  is(
    "a setting handed a variable nothing set is one the config did not say",
    readSettings({ serve: { host: process.env.NOTHING_SETS_THIS } }).serve.host,
    "127.0.0.1",
  );
  is("and a key is a setting like any other", readSettings({ model: { key: "k_x" } }).model.key, "k_x");
  // Nothing is read from the environment by itself, so the config shows every value.
  {
    process.env.CHLOE_SERVE_HOST = "0.0.0.0";
    process.env.CHLOE_CONNECTIONS_GOOGLE_ACCOUNT = "env@example.com";
    is("a setting is never read from the environment by itself", [readSettings({}).serve.host, readSettings({}).connections.google.account], ["127.0.0.1", ""]);
    delete process.env.CHLOE_SERVE_HOST;
    delete process.env.CHLOE_CONNECTIONS_GOOGLE_ACCOUNT;
  }
  is("but one the config hands over is read", readSettings({ connections: { resend: { api_key: "re_x" } } }).connections.resend.api_key, "re_x");

  // The config is type checked, so these are for a value handed over from .env
  // and for a config that is not TypeScript. Each one says what to set instead
  // of what shape failed, which is the whole reason this is not a parser.
  const said = (declared: unknown) => {
    try {
      readSettings(declared as never);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message.split("\n").slice(1).join(" ") : "";
    }
  };
  is("a setting that is not a choice is refused, and the choices are named",
    said({ model: { preferredRoute: ["telepathy"] } }),
    'model.preferredRoute has "telepathy" in it, and each one is "claude", "codex", "antigravity", "opencode", "direct", "gateway".');
  is("a key that is no setting is refused, and says what there is",
    said({ modle: {} }).startsWith("settings.modle is not a setting. Under settings there is model,"), true);
  is("a misspelt key under an agent names the agent, not a star",
    said({ agents: { tempo: { telegarm: "t" } } }),
    "agents.tempo.telegarm is not a setting. Under agents.tempo there is telegram, slack, whatsapp, email.");
  is("a switch given a word is refused", said({ connections: { resend: { alerts: "yes" } } }), "connections.resend.alerts is true or false.");
  is("a list given a word is refused", said({ model: { models: "a,b" } }), "model.models is a list of words.");
  is("a group given a word is refused", said({ model: "claude" }), "model holds more settings, so it is an object.");
  is("connections.google.client takes the file's own shape", said({ connections: { google: { client: { web: { client_id: "x" } } } } }), "");
  is("and refuses what is neither that nor a path", said({ connections: { google: { client: 7 } } }), "connections.google.client is the client file, its path, or its contents as one string.");
  is("a switch handed over as a word is refused too", said({ connections: { resend: { alerts: "true" } } }), "connections.resend.alerts is true or false.");

  const thrown = (declared: unknown) => {
    try {
      readSettings(declared as never);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "";
    }
  };
  is("a config written for a remote dashboard says it is gone", thrown({ dashboard: { remote: { api_key: "chl_workspace_x" } } }).includes("dashboard is gone"), true);
  is("and one written for cloud", thrown({ cloud: { api_key: "chl_workspace_x" } }).includes("dashboard is gone"), true);
  is("and one written for page", thrown({ page: "builtin" }).includes("dashboard is gone"), true);
  is("sign-in alerts are on unless somebody says", readSettings({}).connections.resend.alerts, true);

  {
    // What loadAll does with the config's settings: into the same object
    // everything already holds.
    const { settings } = await import("@chloejs/core");
    declareSettings({ connections: { resend: { email_from: "chloe <x@example.com>" } } });
    is("what the config declares reaches the settings everything reads", settings.connections.resend.email_from, "chloe <x@example.com>");
    is("and a setting it says nothing about is left at its default", settings.serve.host, "127.0.0.1");
    declareSettings({ model: { preferredRoute: ["gateway"] } });
    is("declaring again drops what the last one said", settings.connections.resend.email_from, "");
    // Back to what the test config says, which is where the stand-in gateway comes from.
    await (await import("@chloejs/core")).loadSettings();
  }
}

{
  about("the name a secret is given in .env");
  const { nameInEnv, whereKeyGoes } = await import("@chloejs/core");
  is("a secret is CHLOE_ and its path, in capitals", nameInEnv(["connections", "resend", "api_key"]), "CHLOE_CONNECTIONS_RESEND_API_KEY");
  is("a capital inside a word is split off", nameInEnv(["model", "gatewayUrl"]), "CHLOE_MODEL_GATEWAY_URL");
  is("a key's message says the .env name and the config line", whereKeyGoes(["agents", "test-agent", "telegram"]),
    'in .env as CHLOE_AGENTS_TEST_AGENT_TELEGRAM, and in chloe.config.ts\'s settings as `agents: { "test-agent": { telegram: process.env.CHLOE_AGENTS_TEST_AGENT_TELEGRAM } }`');
}

{
  about("the .env file beside chloe.config.ts");
  const { readEnvFile } = await import("#chloe/core/env");

  is("a plain line", readEnvFile("CHLOE_MODEL_KEY=k_x").CHLOE_MODEL_KEY, "k_x");
  is("blank lines and comments are passed over", Object.keys(readEnvFile("\n# a note\nA=1\n")), ["A"]);
  is("quotes around a value come off", readEnvFile('A="one two"').A, "one two");
  is("and so does export in front, so a shell reads the same file", readEnvFile("export A=1").A, "1");
  is("a value may hold an =", readEnvFile("A=b=c").A, "b=c");
  is("a line with no = is not a setting", readEnvFile("nonsense").nonsense, undefined);
  is("space either side of the name is not part of it", readEnvFile("  A = 1  ").A, "1");

  const { changeEnvText } = await import("#chloe/core/env");
  const before = "# keys\nCHLOE_MODEL_KEY=old\nOTHER=1\nCHLOE_MODEL_KEY=older\n";
  is("a name set again replaces its line and keeps the rest", changeEnvText(before, { CHLOE_MODEL_KEY: "new" }), "# keys\nCHLOE_MODEL_KEY=new\nOTHER=1\n");
  is("a new name goes at the end", changeEnvText("A=1", { CHLOE_X: "2" }), "A=1\nCHLOE_X=2\n");
  is("null takes the line out", changeEnvText(before, { CHLOE_MODEL_KEY: null }), "# keys\nOTHER=1\n");
  is("a value in quotes is read back as it was given", readEnvFile(changeEnvText("", { CHLOE_X: '"q"' })).CHLOE_X, '"q"');
  const refuses = (changes: Record<string, string>) => {
    try {
      changeEnvText("", changes);
      return false;
    } catch {
      return true;
    }
  };
  is("a name without CHLOE_ is refused, so a page cannot set NODE_OPTIONS", refuses({ NODE_OPTIONS: "--require x" }), true);
  is("and so is where things are kept", refuses({ CHLOE_STATE: "/tmp" }), true);
  is("and a value on two lines", refuses({ CHLOE_X: "a\nB=2" }), true);
}

{
  about("the Configuration page's edits to chloe.config.ts");
  const { setInConfig, valueAt, InCode } = await import("#chloe/serve/config");

  const laidOut = `import { defineConfig } from "@chloejs/core";

export default defineConfig({
  agents: [cc],
  settings: {
    // The gateway's key.
    model: {
      key: process.env.CHLOE_MODEL_KEY, // from .env
    },
    connections: {
      google: {
        account: "a@example.com",
        client: process.env.CHLOE_GOOGLE_CLIENT
      },
    },
  },
});
`;
  is("a value is read where it is", valueAt(laidOut, ["connections", "google", "account"]), { kind: "value", text: '"a@example.com"' });
  is("a value nobody wrote is absent", valueAt(laidOut, ["connections", "resend", "api_key"]), { kind: "absent" });
  is(
    "changing one value changes those characters and nothing else",
    setInConfig(laidOut, ["connections", "google", "account"], '"b@example.com"'),
    laidOut.replace('"a@example.com"', '"b@example.com"'),
  );
  is(
    "a new value in a group goes on its own line, after the last one, with a comma before it",
    setInConfig(laidOut, ["connections", "google", "callback"], '"https://x"'),
    laidOut.replace("client: process.env.CHLOE_GOOGLE_CLIENT\n", 'client: process.env.CHLOE_GOOGLE_CLIENT,\n        callback: "https://x",\n'),
  );
  is(
    "and a comment on the last line stays with its own value",
    setInConfig(laidOut, ["model", "defaultModel"], '"m"'),
    laidOut.replace("// from .env\n", '// from .env\n      defaultModel: "m",\n'),
  );
  is(
    "a group that is not there is written in",
    setInConfig(laidOut, ["connections", "resend", "email_to"], '"me@example.com"'),
    laidOut.replace("      },\n    },\n  },\n});", '      },\n      resend: { email_to: "me@example.com" },\n    },\n  },\n});'),
  );
  is(
    "taking a value out takes its line",
    setInConfig(laidOut, ["connections", "google", "account"], null),
    laidOut.replace('        account: "a@example.com",\n', ""),
  );
  is("taking out what is not there changes nothing", setInConfig(laidOut, ["owner"], null), laidOut);

  const oneLine = `export default defineConfig({ agents: [test], settings: { model: { key: process.env.CHLOE_MODEL_KEY } } });\n`;
  is(
    "in a group on one line, a new value goes on that line",
    setInConfig(oneLine, ["model", "defaultModel"], '"m"'),
    `export default defineConfig({ agents: [test], settings: { model: { key: process.env.CHLOE_MODEL_KEY, defaultModel: "m" } } });\n`,
  );
  is(
    "and a config with no settings gets them",
    setInConfig(`export default defineConfig({ agents: [] });\n`, ["owner"], '"telegram:1"'),
    `export default defineConfig({ agents: [], settings: { owner: "telegram:1" } });\n`,
  );
  is(
    "a brace or a comma inside words or a comment is not read as code",
    setInConfig(`export default defineConfig({ settings: { owner: "a, {b}", /* } */ node: "" } });\n`, ["node"], '"/usr/bin"'),
    `export default defineConfig({ settings: { owner: "a, {b}", /* } */ node: "/usr/bin" } });\n`,
  );

  const spread = `export default defineConfig({ settings: { ...shared, model: { defaultModel: "m" } } });\n`;
  let refused: unknown;
  try {
    setInConfig(spread, ["owner"], '"x"');
  } catch (error) {
    refused = error;
  }
  is("a value a spread beside it may set is refused as code", refused instanceof InCode, true);
  is("and is read as code", valueAt(spread, ["owner"]), { kind: "code" });
  is("though one written out beside the spread is still changed", setInConfig(spread, ["model", "defaultModel"], '"n"'), spread.replace('"m"', '"n"'));
  refused = undefined;
  try {
    setInConfig(`export default defineConfig({ settings: { model: shared } });\n`, ["model", "key"], '"x"');
  } catch (error) {
    refused = error;
  }
  is("so is a group that is a variable", refused instanceof InCode, true);
}

{
  about("an ability switched from the page, in agent.ts");
  const { setOptionsIn, saidIn, InCode } = await import("#chloe/serve/config");
  const file = (abilities: string) =>
    `import { defineAgent } from "@chloejs/core";\n\nexport default defineAgent({\n  id: "a",\n  // How it is reached.\n  model: "m",${abilities}\n  purpose: "Hi.",\n});\n`;
  const set = (text: string, name: string, change: { on?: boolean; set?: Record<string, unknown> }, defaultOn = false) =>
    setOptionsIn(text, "abilities", name, change, defaultOn);
  is(
    "a switch where there is no abilities adds it, after the last entry",
    set(file(""), "selfImprovement", { on: false }, true).split("\n").slice(-4).join("\n"),
    '  purpose: "Hi.",\n  abilities: { selfImprovement: false },\n});\n',
  );
  is("one beside another keeps it", set(file("\n  abilities: { runScripts: true },"), "selfImprovement", { on: false }, true), file("\n  abilities: { runScripts: true, selfImprovement: false },"));
  is("switching a default-on one back takes it out", set(file("\n  abilities: { runScripts: true, selfImprovement: false },"), "selfImprovement", { on: true }, true), file("\n  abilities: { runScripts: true, selfImprovement: false },").replace("selfImprovement: false", "selfImprovement: true"));
  is("a default-off one switched off is taken out, and abilities with it when nothing is left", set(file("\n  abilities: { web: true },"), "web", { on: false }), file(""));
  is("on, a default-off one is written true", set(file(""), "web", { on: true }).includes("abilities: { web: true }"), true);

  const fields = (text: string) => text.split("\n").find((line) => line.includes("abilities")) ?? "";
  is("a field turns true into its fields", fields(set(file("\n  abilities: { email: true },"), "email", { set: { days: 3 } })), "  abilities: { email: { days: 3 } },");
  is("another joins it", fields(set(file("\n  abilities: { email: { days: 3 } },"), "email", { set: { reply: true } })), "  abilities: { email: { days: 3, reply: true } },");
  is("a list is written as a list", fields(set(file("\n  abilities: { email: true },"), "email", { set: { sendTo: ["a@b.co", "c@d.co"] } })), '  abilities: { email: { sendTo: ["a@b.co", "c@d.co"] } },');
  is("a field set to null is taken out, and true comes back when none is left", fields(set(file("\n  abilities: { email: { days: 3 } },"), "email", { set: { days: null } })), "  abilities: { email: true },");
  is("a field on an ability that is not there turns it on", fields(set(file(""), "calendar", { set: { add: true } })), "  abilities: { calendar: { add: true } },");
  is("a field inside a group is written inside it", set(file("\n  abilities: { email: true },"), "email", { set: { "a.b": 1 } }).includes("email: { a: { b: 1 } }"), true);
  is("and the group goes when its last field does", fields(set(file("\n  abilities: { email: { a: { b: 1 } } },"), "email", { set: { "a.b": null } })), "  abilities: { email: true },");
  is("a field the file writes as code is left alone", (() => { try { return set(file("\n  abilities: { email: { search: mine, days: 3 } },"), "email", { set: { search: "x" } }); } catch (error) { return error instanceof InCode; } })(), true);
  is("and the others beside it are still the page's", fields(set(file("\n  abilities: { email: { search: mine, days: 3 } },"), "email", { set: { days: 5 } })), "  abilities: { email: { search: mine, days: 5 } },");
  is("an ability written as code is the file's to change", (() => { try { return set(file("\n  abilities: shared,"), "memory", { on: false }, true); } catch (error) { return error instanceof InCode; } })(), true);
  is("what the file says is read back", [saidIn(file(""), "abilities", "web").kind, saidIn(file("\n  abilities: { web: false },"), "abilities", "web"), saidIn(file("\n  abilities: { email: bound },"), "abilities", "email").kind, saidIn(file("\n  abilities: { email: { days: 2, search: mine } },"), "abilities", "email")], ["absent", { kind: "flag", on: false }, "code", { kind: "fields", fields: { days: "value", search: "code" }, values: { days: 2 } }]);

  const { setWithoutIn } = await import("#chloe/serve/config");
  is("a tool switched off adds a without list", setWithoutIn(file(""), "readEmail", false).split("\n").slice(-3).join("\n"), '  without: ["readEmail"],\n});\n');
  is("a second one joins it", setWithoutIn(file('\n  without: ["readEmail"],'), "readPage", false), file('\n  without: ["readEmail", "readPage"],'));
  is("switching one back takes it out", setWithoutIn(file('\n  without: ["readEmail", "readPage"],'), "readEmail", true), file('\n  without: ["readPage"],'));
  is("and the list with the last one", setWithoutIn(file('\n  without: ["readPage"],'), "readPage", true), file(""));
  is("switching off one that is off changes nothing", setWithoutIn(file('\n  without: ["readPage"],'), "readPage", false), file('\n  without: ["readPage"],'));
  const code = (() => {
    try {
      return setWithoutIn(file("\n  without: others,"), "readEmail", false);
    } catch (error) {
      return error;
    }
  })();
  is("a list written as code is the file's to change", code instanceof InCode, true);

  // Channels are calls in agent.ts, and the page edits the call.
  const { setChannelIn, saidChannel } = await import("#chloe/serve/config");
  const doors = (channels: string, imports = 'import { defineAgent } from "@chloejs/core";\nimport { telegramChannel } from "@chloejs/core/channels";\n') =>
    `${imports}\nexport default defineAgent({\n  id: "a",\n  model: "m",${channels}\n  purpose: "Hi.",\n});\n`;
  const door = (text: string, name: string, fn: string, change: { on?: boolean; set?: Record<string, unknown>; starter?: Record<string, unknown> }) => setChannelIn(text, name, fn, change);
  const line = (text: string) => text.split("\n").find((one) => one.includes("channels:")) ?? "";
  is("a channel is added as its call, and its function imported", [line(door(doors(""), "slack", "slackChannel", { on: true })), door(doors(""), "slack", "slackChannel", { on: true }).includes('import { telegramChannel, slackChannel } from "@chloejs/core/channels";')], ["  channels: { slack: slackChannel() },", true]);
  is("with the options it cannot work without", line(door(doors(""), "email", "emailChannel", { on: true, starter: { mailbox: "gmail" }, set: { allowFrom: ["a@b.co"] } })), '  channels: { email: emailChannel({ mailbox: "gmail", allowFrom: ["a@b.co"] }) },');
  is("an import is made when there is none", door(doors("", 'import { defineAgent } from "@chloejs/core";\n'), "api", "apiChannel", { on: true }).includes('import { apiChannel } from "@chloejs/core/channels";'), true);
  is("an option goes inside the call", line(door(doors('\n  channels: { telegram: telegramChannel() },'), "telegram", "telegramChannel", { set: { allowFrom: [1] } })), "  channels: { telegram: telegramChannel({ allowFrom: [1] }) },");
  is("beside the others, and a group of options is written as a group", line(door(doors('\n  channels: { email: emailChannel({ allowFrom: ["a@b.co"] }) },'), "email", "emailChannel", { set: { "start.when": "Rarely." } })), '  channels: { email: emailChannel({ allowFrom: ["a@b.co"], start: { when: "Rarely." } }) },');
  is("an option taken out goes back to the bare call when none is left", line(door(doors('\n  channels: { email: emailChannel({ start: { when: "x" } }) },'), "email", "emailChannel", { set: { "start.when": null } })), "  channels: { email: emailChannel() },");
  is("a channel taken out takes its import, and channels, with it", [door(doors('\n  channels: { telegram: telegramChannel() },'), "telegram", "telegramChannel", { on: false }).includes("channels"), door(doors('\n  channels: { telegram: telegramChannel() },'), "telegram", "telegramChannel", { on: false }).includes("telegramChannel")], [false, false]);
  is("the import stays when the function is used elsewhere", door(doors('\n  channels: { a: telegramChannel(), b: telegramChannel({ name: "b" }) },'), "a", "telegramChannel", { on: false }).includes('import { telegramChannel }'), true);
  is("an option the file writes as code is left alone", (() => { try { return door(doors('\n  channels: { telegram: telegramChannel({ allowFrom: ids }) },'), "telegram", "telegramChannel", { set: { allowFrom: [1] } }); } catch (error) { return error instanceof InCode; } })(), true);
  is("a channel written some other way is the file's", (() => { try { return door(doors("\n  channels: { telegram: mine },"), "telegram", "telegramChannel", { on: false }); } catch (error) { return error instanceof InCode; } })(), true);
  is("what the file says is read back", [saidChannel(doors(""), "telegram", "telegramChannel").kind, saidChannel(doors("\n  channels: { telegram: telegramChannel() },"), "telegram", "telegramChannel").kind, saidChannel(doors("\n  channels: { telegram: mine },"), "telegram", "telegramChannel").kind, saidChannel(doors('\n  channels: { telegram: telegramChannel({ allowFrom: [1], x: y }) },'), "telegram", "telegramChannel")], ["absent", "fields", "code", { kind: "fields", fields: { allowFrom: "value", x: "code" }, values: { allowFrom: [1] } }]);
}
