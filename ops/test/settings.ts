// Settings: the config, the environment, and the .env file.

import { about, is } from "#chloe/ops/check";

{
  about("settings, and what wins");
  const { declareSettings, nameInEnv, readSettings } = await import("@chloejs/core");

  const base = { model: { prefer: ["gateway" as const], judge: "a" } };
  is("a default fills in what the config does not mention", readSettings(base, {}).model.gateway, "https://ai-gateway.vercel.sh/v1/chat/completions");
  is("what the config says is what it says", readSettings(base, {}).model.prefer, ["gateway"]);
  is("and one key declared leaves its neighbours alone", readSettings(base, {}).model.judge, "a");
  is("a setting nobody set is empty rather than missing", readSettings({}, {}).node, "");
  is("each agent's own settings are under its name", readSettings({ agents: { tempo: { telegram: "t" } } }, {}).agents.tempo.telegram, "t");
  is("and what it does not say is empty", readSettings({ agents: { tempo: { telegram: "t" } } }, {}).agents.tempo.slack.app_token, "");
  let misspelt = "";
  try {
    readSettings({ agents: { tempo: { telegarm: "t" } } } as never, {});
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
    readSettings({ cloud: { url: process.env.NOTHING_SETS_THIS } }, {}).cloud.url,
    "https://dashboard.chloejs.org",
  );
  is("and the workspace key is a setting like any other", readSettings({ cloud: { api_key: "chl_workspace_x" } }, {}).cloud.api_key, "chl_workspace_x");
  is("read from the environment by its own name", readSettings({}, { CHLOE_CLOUD_API_KEY: "chl_from_env" }).cloud.api_key, "chl_from_env");
  is("and by the name it had before", readSettings({}, { CHLOE_API_KEY: "chl_from_env" }).cloud.api_key, "chl_from_env");

  // The config is type checked, so these are for a value out of the environment
  // and for a config that is not TypeScript. Each one says what to set instead
  // of what shape failed, which is the whole reason this is not a parser.
  const said = (declared: unknown, env: Record<string, string> = {}) => {
    try {
      readSettings(declared as never, env);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message.split("\n").slice(1).join(" ") : "";
    }
  };
  is("a setting that is not a choice is refused, and the choices are named",
    said({ model: { prefer: ["telepathy"] } }),
    'model.prefer has "telepathy" in it, and each one is "claude", "codex", "opencode", "gateway".');
  is("a key that is no setting is refused, and says what there is",
    said({ modle: {} }).startsWith("settings.modle is not a setting. Under settings there is model,"), true);
  is("a misspelt key under an agent names the agent, not a star",
    said({ agents: { tempo: { telegarm: "t" } } }),
    "agents.tempo.telegarm is not a setting. Under agents.tempo there is telegram, slack, whatsapp.");
  is("a switch given a word is refused", said({ cloud: { remote: { write: "yes" } } }), "cloud.remote.write is true or false.");
  is("a list given a word is refused", said({ model: { models: "a,b" } }), "model.models is a list of words.");
  is("a group given a word is refused", said({ model: "claude" }), "model holds more settings, so it is an object.");
  is("a route is checked like the setting it is", said({ model: { routes: { openai: "telepathy" } } }).startsWith("model.routes.openai is"), true);
  is("google.client takes the file's own shape", said({ google: { client: { web: { client_id: "x" } } } }), "");
  is("and refuses what is neither that nor a path", said({ google: { client: 7 } }), "google.client is the client file, its path, or its contents as one string.");
  is("a switch out of the environment is checked the same way", said({}, { CHLOE_CLOUD_REMOTE_WRITE: "true" }), "");

  let moved = "";
  try {
    readSettings({ cloud: { key: "chl_workspace_x" } } as never, {});
  } catch (error) {
    moved = error instanceof Error ? error.message : "";
  }
  is("cloud.key in the config is refused, and names the setting instead", moved.includes("cloud.api_key, not cloud.key"), true);
  is("and the dashboard's address is what it is unless somebody says", readSettings({}, {}).cloud.url, "https://dashboard.chloejs.org");

  {
    // What loadAll does with the config's settings: into the same object
    // everything already holds, and the environment still over the top.
    //
    // The variable is taken out first, because this suite runs from whichever
    // project installed the runtime and that project's .env may well set it. A
    // declaration it beats is a declaration this cannot see.
    const { settings } = await import("@chloejs/core");
    const name = nameInEnv(["alerts", "email_from"]);
    const inEnv = process.env[name];
    delete process.env[name];
    declareSettings({ alerts: { email_from: "chloe <x@example.com>" } });
    is("what the config declares reaches the settings everything reads", settings.alerts.email_from, "chloe <x@example.com>");
    is("and a setting it says nothing about is left at its default", settings.cloud.url, "https://dashboard.chloejs.org");
    declareSettings({ model: { prefer: ["gateway"] } });
    is("declaring again drops what the last one said", settings.alerts.email_from, "");
    if (inEnv !== undefined) process.env[name] = inEnv;
  }
  {
    // AI_GATEWAY_URL is set at the top of this file, for the stand-in gateway.
    const { settings } = await import("@chloejs/core");
    declareSettings({ model: { gateway: "https://declared" } });
    is("the environment beats what the config declares", settings.model.gateway, process.env.AI_GATEWAY_URL);
    declareSettings({});
  }
}

{
  about("a setting out of the environment");
  const { readSettings, nameInEnv } = await import("@chloejs/core");

  is("a setting is CHLOE_ and its path, in capitals", nameInEnv(["resend", "api_key"]), "CHLOE_RESEND_API_KEY");
  is(
    "the environment beats the config",
    readSettings({ cloud: { url: "https://declared" } }, { CHLOE_CLOUD_URL: "https://env" }).cloud.url,
    "https://env",
  );
  is(
    "and beats one key without clearing its neighbours",
    readSettings({ cloud: { sync: { runs: false } } }, { CHLOE_CLOUD_URL: "https://env" }).cloud.sync.runs,
    false,
  );
  is("a switch reads as a switch", readSettings({}, { CHLOE_CLOUD_REMOTE_WRITE: "true" }).cloud.remote.write, true);
  is("and the switches beside it are left alone", readSettings({}, { CHLOE_CLOUD_REMOTE_WRITE: "true" }).cloud.remote.memory, false);
  is("a list is written with commas", readSettings({}, { CHLOE_MODEL_MODELS: "one/a, one/b" }).model.models, ["one/a", "one/b"]);
  is("a route is named after its provider", readSettings({}, { CHLOE_MODEL_ROUTES_OPENAI: "codex" }).model.routes.openai, "codex");
  is(
    "an agent's token is under its name",
    readSettings({}, { CHLOE_AGENTS_TEMPO_TELEGRAM: "t" }).agents.tempo.telegram,
    "t",
  );
  is(
    "and so is a token two deep",
    readSettings({}, { CHLOE_AGENTS_TEMPO_SLACK_BOT_TOKEN: "xoxb" }).agents.tempo.slack.bot_token,
    "xoxb",
  );
  is(
    "an agent the config spells with a dash is the same agent",
    Object.keys(readSettings({ agents: { "test-agent": {} } }, { CHLOE_AGENTS_TEST_AGENT_TELEGRAM: "t" }).agents),
    ["test-agent"],
  );
  is(
    "and so is one the config says nothing about, because loadAll hands the names over",
    Object.keys(readSettings({}, { CHLOE_AGENTS_TEST_AGENT_TELEGRAM: "t" }, ["test-agent"]).agents),
    ["test-agent"],
  );
  is(
    "an agent nothing knows about is named as the variable spells it",
    Object.keys(readSettings({}, { CHLOE_AGENTS_TEST_AGENT_TELEGRAM: "t" }).agents),
    ["test_agent"],
  );
  is("the older name a setting had still works", readSettings({}, { MODEL_VIA: "codex" }).model.prefer, ["codex"]);
  is("and the name from the schema wins over it", readSettings({}, { MODEL_VIA: "codex", CHLOE_MODEL_PREFER: "claude" }).model.prefer, ["claude"]);

  let switched = "";
  try {
    readSettings({}, { CHLOE_CLOUD_REMOTE_WRITE: "please" });
  } catch (error) {
    switched = error instanceof Error ? error.message : "";
  }
  is("a switch that is neither is refused, not read as off", switched, 'CHLOE_CLOUD_REMOTE_WRITE is "please", and a switch is true or false.');

  let misspelt = "";
  try {
    readSettings({}, { CHLOE_AGENTS_TEMPO_TELEGARM: "t" });
  } catch (error) {
    misspelt = error instanceof Error ? error.message : "";
  }
  is("a misspelt variable under an agent is refused rather than ignored", misspelt.includes("names no setting"), true);

}

{
  about("the .env file beside chloe.config.ts");
  const { readEnvFile } = await import("#chloe/core/env");

  is("a plain line", readEnvFile("CHLOE_CLOUD_API_KEY=chl_workspace_x").CHLOE_CLOUD_API_KEY, "chl_workspace_x");
  is("blank lines and comments are passed over", Object.keys(readEnvFile("\n# a note\nA=1\n")), ["A"]);
  is("quotes around a value come off", readEnvFile('A="one two"').A, "one two");
  is("and so does export in front, so a shell reads the same file", readEnvFile("export A=1").A, "1");
  is("a value may hold an =", readEnvFile("A=b=c").A, "b=c");
  is("a line with no = is not a setting", readEnvFile("nonsense").nonsense, undefined);
  is("space either side of the name is not part of it", readEnvFile("  A = 1  ").A, "1");
}
