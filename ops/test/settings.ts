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
    settings.agents = { tempo: { telegram: "t", slack: { bot_token: "", app_token: "" }, whatsapp: { phone_number_id: "", token: "", app_secret: "" } } };
    is("an entry for an agent that exists is claimed", unclaimed(["tempo"]), []);
    is("one left behind by a rename is not", unclaimed(["growth"]), ["tempo"]);
    settings.agents = before;
  }
  // A config may hand a setting the variable itself, which is how it says where
  // a credential comes from without holding one.
  is(
    "a setting handed a variable nothing set is one the config did not say",
    readSettings({ dashboard: { remote: { url: process.env.NOTHING_SETS_THIS } } }).dashboard.remote.url,
    "https://dashboard.chloejs.org",
  );
  is("and the workspace key is a setting like any other", readSettings({ dashboard: { remote: { api_key: "chl_workspace_x" } } }).dashboard.remote.api_key, "chl_workspace_x");
  // Nothing is read from the environment by itself, so the config shows every value.
  {
    process.env.CHLOE_DASHBOARD_REMOTE_URL = "https://env";
    process.env.CHLOE_DASHBOARD_REMOTE_API_KEY_NOT_NAMED = "chl_from_env";
    is("a setting is never read from the environment by itself", readSettings({}).dashboard.remote.url, "https://dashboard.chloejs.org");
    delete process.env.CHLOE_DASHBOARD_REMOTE_URL;
    delete process.env.CHLOE_DASHBOARD_REMOTE_API_KEY_NOT_NAMED;
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
    'model.preferredRoute has "telepathy" in it, and each one is "claude", "codex", "opencode", "gateway".');
  is("a key that is no setting is refused, and says what there is",
    said({ modle: {} }).startsWith("settings.modle is not a setting. Under settings there is model,"), true);
  is("a misspelt key under an agent names the agent, not a star",
    said({ agents: { tempo: { telegarm: "t" } } }),
    "agents.tempo.telegarm is not a setting. Under agents.tempo there is telegram, slack, whatsapp.");
  is("a switch given a word is refused", said({ dashboard: { remote: { allow: { write: "yes" } } } }), "dashboard.remote.allow.write is true or false.");
  is("a list given a word is refused", said({ model: { models: "a,b" } }), "model.models is a list of words.");
  is("a group given a word is refused", said({ model: "claude" }), "model holds more settings, so it is an object.");
  is("connections.google.client takes the file's own shape", said({ connections: { google: { client: { web: { client_id: "x" } } } } }), "");
  is("and refuses what is neither that nor a path", said({ connections: { google: { client: 7 } } }), "connections.google.client is the client file, its path, or its contents as one string.");
  is("a switch handed over as a word is refused too", said({ dashboard: { remote: { allow: { write: "true" } } } }), "dashboard.remote.allow.write is true or false.");

  const thrown = (declared: unknown) => {
    try {
      readSettings(declared as never);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "";
    }
  };
  is("a config written for cloud says where it went", thrown({ cloud: { api_key: "chl_workspace_x" } }).includes("cloud is dashboard.remote now"), true);
  is("and one written for page", thrown({ page: "builtin" }), "settings: page is dashboard.local now.");
  is("the local page is a setting", readSettings({ dashboard: { local: "builtin" } }).dashboard.local, "builtin");
  is("and the dashboard's address is what it is unless somebody says", readSettings({}).dashboard.remote.url, "https://dashboard.chloejs.org");
  is("sign-in alerts are on unless somebody says", readSettings({}).connections.resend.alerts, true);

  {
    // What loadAll does with the config's settings: into the same object
    // everything already holds.
    const { settings } = await import("@chloejs/core");
    declareSettings({ connections: { resend: { email_from: "chloe <x@example.com>" } } });
    is("what the config declares reaches the settings everything reads", settings.connections.resend.email_from, "chloe <x@example.com>");
    is("and a setting it says nothing about is left at its default", settings.dashboard.remote.url, "https://dashboard.chloejs.org");
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

  is("a plain line", readEnvFile("CHLOE_DASHBOARD_REMOTE_API_KEY=chl_workspace_x").CHLOE_DASHBOARD_REMOTE_API_KEY, "chl_workspace_x");
  is("blank lines and comments are passed over", Object.keys(readEnvFile("\n# a note\nA=1\n")), ["A"]);
  is("quotes around a value come off", readEnvFile('A="one two"').A, "one two");
  is("and so does export in front, so a shell reads the same file", readEnvFile("export A=1").A, "1");
  is("a value may hold an =", readEnvFile("A=b=c").A, "b=c");
  is("a line with no = is not a setting", readEnvFile("nonsense").nonsense, undefined);
  is("space either side of the name is not part of it", readEnvFile("  A = 1  ").A, "1");
}
