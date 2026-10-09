// The files npx chloe setup writes.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";

{
  about("the files npx chloe setup writes");

  const { GUIDES, modelLine, STARTER_MODEL_LINE, starterFiles, withSetting } = await import("#chloe/ops/starter");
  const { ROOT } = await import("@chloejs/core");

  const { findConfig } = await import("#chloe/core/find");
  is("the project is found by walking up", findConfig(join(ROOT, "ops")), ROOT);
  is("and nowhere above the root of the disk has one", findConfig("/"), "");

  const files = starterFiles();
  const config = files.find((one) => one.path === "chloe.config.ts")!.body;
  is("setup writes no agent", files.map((one) => one.path), ["chloe.config.ts", ".gitignore", "AGENTS.md", "CLAUDE.md"]);
  is("and chloe.config.ts lists none", config.includes("agents: [],"), true);
  is("it has the line setup puts the chosen model in", config.includes(STARTER_MODEL_LINE), true);
  const guide = files.find((one) => one.path === "AGENTS.md")?.body ?? "";
  is("AGENTS.md sends a coding agent to the guides for the installed version", guide.includes(GUIDES), true);
  is("and tells it the first agent is its to write", guide.includes("write the first agent"), true);
  is("which the build writes into dist/docs", GUIDES, "node_modules/@chloejs/core/dist/docs/README.md");
  is("and CLAUDE.md reads AGENTS.md", files.find((one) => one.path === "CLAUDE.md")?.body, "@AGENTS.md\n");
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
  const keyLine = "dashboard: { remote: { api_key: process.env.CHLOE_DASHBOARD_REMOTE_API_KEY } },";
  const withKey = withSetting(config, keyLine);
  is("a key's line goes into the settings setup wrote", withKey?.includes(`  settings: {\n    ${keyLine}\n`), true);
  is("and not twice", withSetting(withKey!, keyLine), null);
  is("nor into a config that already says dashboard", withSetting(withKey!, "dashboard: { remote: { url: \"https://example.com\" } },"), null);

  // Written inside the repo rather than in tmp, because the config imports
  // "@chloejs/core" and a package can only import itself from inside itself.
  // The config is text here, so this is what catches a renamed export.
  await mkdir(join(ROOT, "data"), { recursive: true });
  const folder = await mkdtemp(join(ROOT, "data", "starter-"));
  await writeFile(join(folder, "chloe.config.ts"), config);
  const declared = (await import(pathToFileURL(join(folder, "chloe.config.ts")).href)).default;
  is("the config it writes loads, with no agents", declared.agents, []);
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
