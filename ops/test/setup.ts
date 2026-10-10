// The files npx chloe setup writes.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { about, is } from "#chloe/ops/check";

{
  about("the files npx chloe setup writes");

  const { GUIDES, modelLine, STARTER_AGENT, STARTER_MODEL_LINE, starterFiles, withSetting } = await import("#chloe/ops/starter");
  const { ROOT } = await import("@chloejs/core");

  const { findConfig } = await import("#chloe/core/find");
  is("the project is found by walking up", findConfig(join(ROOT, "ops")), ROOT);
  is("and nowhere above the root of the disk has one", findConfig("/"), "");

  const files = starterFiles();
  const config = files.find((one) => one.path === "chloe.config.ts")!.body;
  is(
    "setup writes a first agent beside the config",
    files.map((one) => one.path),
    ["chloe.config.ts", `agents/${STARTER_AGENT}/agent.ts`, `agents/${STARTER_AGENT}/instructions.md`, "tsconfig.json", ".gitignore"],
  );
  is("only with a config it writes, which lists it", files.filter((one) => one.withConfig).length, 2);
  is("and chloe.config.ts does", config.includes(`agents: [${STARTER_AGENT}],`), true);
  is("it has the line setup puts the chosen model in", config.includes(STARTER_MODEL_LINE), true);
  is("the guides setup points to are where the build writes them", GUIDES, "node_modules/@chloejs/core/dist/docs/README.md");
  is(
    "and the model goes in as a setting, with preferredRoute as a list",
    modelLine({ defaultModel: "anthropic/claude-sonnet-5", preferredRoute: "gateway,claude" }),
    'model: { defaultModel: "anthropic/claude-sonnet-5", preferredRoute: ["gateway","claude"] },',
  );
  is(
    "and the key is named where it is read from, never written in",
    modelLine({ defaultModel: "openrouter/free" }, "CHLOE_MODEL_KEY"),
    'model: { defaultModel: "openrouter/free", key: process.env.CHLOE_MODEL_KEY },',
  );
  is(
    "and a provider's own key goes under keys and that provider",
    modelLine({ defaultModel: "openai/gpt-6-luna" }, "OPENAI_API_KEY", ["keys", "openai"]),
    'model: { defaultModel: "openai/gpt-6-luna", keys: { openai: process.env.OPENAI_API_KEY } },',
  );
  const keyLine = "connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } },";
  const withKey = withSetting(config, keyLine);
  is("a key's line goes into the settings setup wrote", withKey?.includes(`  settings: {\n    ${keyLine}\n`), true);
  is("and not twice", withSetting(withKey!, keyLine), null);
  is("nor into a config that already says connections", withSetting(withKey!, "connections: { google: { account: \"you@gmail.com\" } },"), null);

  // Written inside the repo rather than in tmp, because the config imports
  // "@chloejs/core" and a package can only import itself from inside itself.
  // The files are text here, so this is what catches a renamed export.
  await mkdir(join(ROOT, "data"), { recursive: true });
  const folder = await mkdtemp(join(ROOT, "data", "starter-"));
  for (const file of files) {
    await mkdir(dirname(join(folder, file.path)), { recursive: true });
    await writeFile(join(folder, file.path), file.body);
  }
  const declared = (await import(pathToFileURL(join(folder, "chloe.config.ts")).href)).default;
  is("the config it writes loads, with the first agent", declared.agents.map((one: { id: string }) => one.id), [STARTER_AGENT]);
  const { resolveAgent } = await import("#chloe/load/load");
  // The model is setup's to write into the settings, which this config has not been given.
  const agent = await resolveAgent({ ...declared.agents[0], model: "m" });
  is("and the agent loads, with its instructions read from its folder", agent.instructions.startsWith("You were set up"), true);
  is("and may change itself", Boolean(agent.tools?.selfWriteFile), true);
  await rm(folder, { recursive: true, force: true });
}

{
  about("the repository npx chloe setup makes");
  const { firstCommit, hasGit, hasGitName, repositoryOf } = await import("#chloe/ops/git");
  const { tmpdir } = await import("node:os");
  const { realpathSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");

  is("git is here, which the rest of these need", hasGit(), true);
  const project = realpathSync(await mkdtemp(join(tmpdir(), "setup-git-")));
  await mkdir(join(project, "agents/watcher"), { recursive: true });
  await writeFile(join(project, "agents/watcher/instructions.md"), "You are watcher.\n");
  await writeFile(join(project, ".gitignore"), "data\n");
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(join(project, "data/runs.db"), "x");
  is("a folder outside any repository is in none", repositoryOf(project), "");

  // Whatever git says its name is on this machine, with none it still commits.
  const nameless = { ...process.env, HOME: project, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: project };
  const was = { ...process.env };
  Object.assign(process.env, nameless);
  is("with no name set, git has none", hasGitName(project), false);
  firstCommit(project);
  is("it becomes one", repositoryOf(project), project);
  const left = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout.trim();
  is("with what was there committed", left, "");
  const author = spawnSync("git", ["log", "-1", "--format=%an"], { cwd: project, encoding: "utf8" }).stdout.trim();
  is("under setup's name when git has none", author, "npx chloe setup");
  const tracked = spawnSync("git", ["ls-files"], { cwd: project, encoding: "utf8" }).stdout.trim().split("\n");
  is("and nothing .gitignore leaves out", tracked, [".gitignore", "agents/watcher/instructions.md"]);
  for (const key of Object.keys(process.env)) if (!(key in was)) delete process.env[key];
  Object.assign(process.env, was);
  await rm(project, { recursive: true, force: true });
}
