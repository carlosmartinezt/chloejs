// Services: email in Markdown, web pages, and a copy of the database.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";
import { db, sent } from "./shared.ts";

{
  about("an email written in Markdown");

  const { markdownToHtml, markdownToText } = await import("@chloejs/core/services");
  const body = "## Today\n\nOne line\nwrapped here.\n\n- a **bold** item\n- [a link](https://example.com)\n\n| day | visits |\n|---|---|\n| Mon | 3 |";
  const html = markdownToHtml(body);
  is("lines next to each other are one paragraph", html.includes("<p style='margin:0 0 14px'>One line wrapped here.</p>"), true);
  is("a heading is a heading", html.includes(">Today</div>"), true);
  is("a list is a list", (html.match(/<li /g) ?? []).length, 2);
  is("a table keeps its rows and drops the rule", (html.match(/<tr>/g) ?? []).length, 2);
  is("what a person typed is escaped", markdownToHtml("<b>hi</b>").includes("&lt;b&gt;"), true);
  is("a link that is not a web or mail address is only words", markdownToHtml("[go](javascript:alert(1))").includes("<a"), false);
  is("a quote cannot end the address early", markdownToHtml("[go](https://x.com/'onmouseover='y)").includes("href='https://x.com/&#39;onmouseover=&#39;y'"), true);
  is(
    "the plain copy has no symbols in it",
    markdownToText(body),
    "Today\n\nOne line\nwrapped here.\n\n- a bold item\n- a link (https://example.com)\n\n  day: visits\n  Mon: 3",
  );
}

{
  about("a provider that carries nothing");

  const { deliverEmail } = await import("@chloejs/core/services");
  const sent = await deliverEmail({ from: "a@example.com", to: ["b@example.com"], tag: "test" }, "Hello", "A body.");
  is("it says it was sent, with the tag in front", [sent.sent, sent.subject], [true, "[test] Hello"]);
  is("and it has no id, because nothing carried it", sent.id, undefined);

  const nobody = await deliverEmail({ from: "a@example.com", to: [] }, "Hello", "A body.").catch((error: Error) => error.message);
  is("nobody to send to is refused rather than dropped", nobody, "Nobody to send to. Give the sender at least one address in to.");
}

{
  about("a copy of the agents' database");

  const { copyDatabase } = await import("@chloejs/core");
  const { DatabaseSync } = await import("node:sqlite");
  const { tmpdir } = await import("node:os");
  const to = join(tmpdir(), `copy-${process.pid}`, "agents.db");
  const copied = await copyDatabase(to);
  const opened = new DatabaseSync(to, { readOnly: true });
  const count = (from: typeof db) => (from.prepare("select count(*) as n from runs").get() as { n: number }).n;
  is("it is written where it was asked for", copied.path, to);
  is("it opens, and holds every run", count(opened), count(db));
  opened.close();
  await rm(join(tmpdir(), `copy-${process.pid}`), { recursive: true, force: true });
}

{
  about("an alert when a job starts failing or works again");

  const { jobTurned } = await import("#chloe/core/alerts");
  const ended = (id: string, finished: string, error: string | null) =>
    db
      .prepare("insert into runs (id, agent, started, finished, source, model, prompt, error, job) values (?, 'alerted', ?, ?, 'schedule', 'm', '', ?, 'daily')")
      .run(id, finished, finished, error);
  ended("alert-1", "2026-01-01T10:00:00.000Z", null);
  is("a run that works after one that worked says nothing", jobTurned("alerted", "daily", "2026-01-01T09:59:00.000Z"), null);
  ended("alert-2", "2026-01-02T10:00:00.000Z", "claude exited 1: error_max_turns");
  is("the first failure says so, with the error", jobTurned("alerted", "daily", "2026-01-02T09:59:00.000Z")?.subject, "alerted/daily is failing");
  ended("alert-3", "2026-01-03T10:00:00.000Z", "claude exited 1: error_max_turns");
  is("a failure after a failure says nothing", jobTurned("alerted", "daily", "2026-01-03T09:59:00.000Z"), null);
  is("a run that left no row says nothing about an older one", jobTurned("alerted", "daily", "2026-01-04T09:59:00.000Z"), null);
  ended("alert-4", "2026-01-04T10:00:00.000Z", null);
  is("working again says so, once", jobTurned("alerted", "daily", "2026-01-04T09:59:00.000Z")?.subject, "alerted/daily works again");
}

{
  about("the guides an agent reads to learn what it could be given");

  const { guides, guide } = await import("#chloe/services/selfService");
  const all = guides();
  is("every guide is listed, with what it covers", all.some((one) => one.page === "connections" && one.about.length > 0), true);
  is("one is read whole by its name", guide("connections").includes("Google"), true);
  let refused = "";
  try {
    guide("../package");
  } catch (error) {
    refused = (error as Error).message;
  }
  is("a path out of the guides is no guide", refused.startsWith("There is no guide called ../package"), true);
}

{
  const { chmod, mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  about("an agent's scripts");
  const { setAgentDirs } = await import("#chloe/core/paths");
  const { listScripts, runScripts } = await import("#chloe/services/scriptsService");
  const folder = await mkdtemp(join(tmpdir(), "chloe-scripts-"));
  const memory = await mkdtemp(join(tmpdir(), "chloe-scripts-memory-"));
  const script = async (path: string, body: string) => {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), body);
    await chmod(join(folder, path), 0o755);
  };
  await script("scripts/where.sh", '#!/bin/sh\nprintf %s "$MEMORY_FOLDER"\n');
  await script("skills/forms/scripts/here.sh", "#!/bin/sh\npwd\n");
  await writeFile(join(folder, "skills", "forms", "SKILL.md"), "---\ndescription: filling forms\n---\nRun the script.");
  await writeFile(join(folder, "skills", "forms", "fields.md"), "Longer notes.");
  setAgentDirs(new Map([["scripter", folder]]), new Map([["scripter", memory]]));
  const failed = (error: Error) => error.message;

  is("a script is told where its agent's memory is", (await runScripts("scripter", "where.sh")).stdout, memory);
  is("its executable files are scripts, named from the skill's folder", await listScripts("scripter"), ["where.sh", "forms/scripts/here.sh"]);
  is("and one runs inside its skill's folder", (await runScripts("scripter", "forms/scripts/here.sh")).stdout.trim(), join(folder, "skills", "forms"));
  is("a name that is a path is refused", await runScripts("scripter", "forms/fields.md").then(() => "", failed), 'No script called "forms/fields.md". You have: where.sh, forms/scripts/here.sh');
  await (await import("@chloejs/core")).loadAll();
}
