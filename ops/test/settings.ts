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
  about("a feature switched from the page, in agent.ts");
  const { setFeatureIn, InCode } = await import("#chloe/serve/config");
  const file = (features: string) =>
    `import { defineAgent } from "@chloejs/core";\n\nexport default defineAgent({\n  id: "a",\n  // How it is reached.\n  model: "m",${features}\n  instructions: "Hi.",\n});\n`;
  is(
    "a switch where there is no features adds it, after the last entry",
    setFeatureIn(file(""), "selfImprovement", false).split("\n").slice(-4).join("\n"),
    '  instructions: "Hi.",\n  features: { selfImprovement: false },\n});\n',
  );
  is("one beside another keeps it", setFeatureIn(file("\n  features: { runScripts: true },"), "selfImprovement", false), file("\n  features: { runScripts: true, selfImprovement: false },"));
  is("switching one back takes it out", setFeatureIn(file("\n  features: { runScripts: true, selfImprovement: false },"), "selfImprovement", null), file("\n  features: { runScripts: true },"));
  is("and features with it when nothing is left", setFeatureIn(file("\n  features: { selfImprovement: false },"), "selfImprovement", null), file(""));
  const refused = (() => {
    try {
      return setFeatureIn(file("\n  features: shared,"), "memory", false);
    } catch (error) {
      return error;
    }
  })();
  is("features written as code is the file's to change", refused instanceof InCode, true);
}
