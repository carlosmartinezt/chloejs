// Loading agents and jobs: cron lines, notes, and what a job may import.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, db } from "./shared.ts";

{
  about("every agent in this repo still loads");
  const { loadAll } = await import("@chloejs/core");

  // One bad file in a jobs folder takes down every job that agent
  // has, silently: the cron lines simply stop existing. That is how a
  // nightly-backup.test.ts sitting beside the job it tests stopped the backup
  // for as long as nobody looked. Loading them all is the cheapest way to
  // notice.
  const { defineAgent } = await import("@chloejs/core");
  const here = defineAgent({ id: "here", model: "m", description: "", instructions: "Hello." });
  is("an agent's folder is the one it is written in, unless it says", here.folder, import.meta.dirname);
  is("and it can say", defineAgent({ ...here, id: here.id, folder: "/elsewhere" }).folder, "/elsewhere");

  const all = await loadAll().then((found) => found, (error: Error) => error);
  is("every agent loads", all instanceof Error ? all.message : null, null);

  // Only where the config lists the test agent, which is this repo: the suite
  // also runs inside a project that installed the runtime, and its agents' jobs
  // are not this suite's to run.
  if (!(all instanceof Error) && all.has("test")) {
    const { default: test } = await import(pathToFileURL(join(import.meta.dirname, "../../test-agent/agent.ts")).href);
    const { default: hello } = await import(pathToFileURL(join(import.meta.dirname, "../../test-agent/jobs/hello.ts")).href);
    is("an agent runs its own job", (await test.run({ job: hello })).text, "hello");
    answers.push("Hi back.");
    is("and is asked one thing", (await test.ask({ prompt: "Hi." })).text, "Hi back.");
  }
  for (const agent of all instanceof Error ? [] : all.values()) {
    // A job is only on the clock if the agent imports it, so one written and
    // never named would sit there looking like a job and never run. A .ts file
    // may hold any number of jobs under any name, so its exports are read; a
    // .md file is a job's words, so it has to be one of a named job's files.
    const ids = new Set(agent.jobs.map((one) => one.id));
    const files = new Set(agent.jobs.flatMap((one) => one.files));
    const inJobs = await readdir(join(agent.folder, "jobs")).catch(() => [] as string[]);
    const unnamed: string[] = [];
    for (const file of inJobs) {
      if (file.endsWith(".md") && !files.has(`jobs/${file}`)) unnamed.push(`jobs/${file}`);
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const exported = await import(pathToFileURL(join(agent.folder, "jobs", file)).href);
      for (const value of Object.values(exported as Record<string, unknown>)) {
        const job = value as { id?: unknown; run?: unknown; markdown?: unknown } | null;
        const isJob = typeof job === "object" && job !== null && typeof job.id === "string" && Boolean(job.run || job.markdown);
        if (isJob && !ids.has(job.id as string)) unnamed.push(`jobs/${file}: ${job.id}`);
      }
    }
    is(`every job in ${agent.id}'s jobs folder is named in its agent.ts`, unnamed, []);
  }
}

{
  about("when a job runs, written in words");

  const { every, describe, parse } = await import("@chloejs/core/timer");

  // It is a library of its own, so nothing in it may reach into the rest. Found
  // from this file rather than from the repo root, because the runtime is a
  // package and the repo that installed it is somewhere else.
  const timer = join(import.meta.dirname, "../../timer");
  const reaching: string[] = [];
  for (const file of await readdir(timer)) {
    const source = await readFile(join(timer, file), "utf8");
    for (const [, from] of source.matchAll(/^(?:import|export)\b[^;]*?\sfrom\s+"([^"]+)"/gm)) {
      if (!from.startsWith("./") && !from.startsWith("node:")) reaching.push(`${file}: ${from}`);
    }
  }
  is("@chloejs/core/timer imports nothing outside itself", reaching, []);
  const said: [string, string, string][] = [
    [every(15).minutes, "*/15 * * * *", "every 15 minutes"],
    [every(4).hours, "0 */4 * * *", "every 4 hours"],
    [every.minute, "* * * * *", "every minute"],
    [every.hour.at(0), "0 * * * *", "every hour"],
    [every.hour.at(30), "30 * * * *", "every hour at :30"],
    [every.day.at("07:00"), "0 7 * * *", "every day at 07:00 UTC"],
    [every.day.at("22:45", "10:45"), "45 10,22 * * *", "every day at 10:45 and 22:45 UTC"],
    [every.weekday.at("9:30"), "30 9 * * 1-5", "weekdays at 09:30 UTC"],
    [every.weekend.at("10:00"), "0 10 * * 0,6", "weekends at 10:00 UTC"],
    [every.monday.at("9:00"), "0 9 * * 1", "mondays at 09:00 UTC"],
    [every.month.on(1).at("09:00"), "0 9 1 * *", "on the 1st of every month at 09:00 UTC"],
  ];
  for (const [written, line, words] of said) {
    is(`${words} is ${line}`, written, line);
    is(`and the clock reads it`, typeof parse(written), "object");
    is(`and it reads back as "${words}"`, describe(written), words);
  }
  // New York moves its clocks and the line does not: 07:00 there is 11:00 UTC
  // in summer and 12:00 UTC in winter, including on the days it changes.
  const { due } = await import("@chloejs/core/timer");
  const seven = parse(every.day.at("07:00"));
  const at = (utc: string) => due(seven, new Date(utc), "America/New_York");
  is("07:00 New York in summer is 11:00 UTC", [at("2026-07-01T11:00:00Z"), at("2026-07-01T12:00:00Z")], [true, false]);
  is("and in winter is 12:00 UTC", [at("2026-01-15T12:00:00Z"), at("2026-01-15T11:00:00Z")], [true, false]);
  is("the morning the clocks go forward", at("2026-03-08T11:00:00Z"), true);
  is("the morning they go back", at("2026-11-01T12:00:00Z"), true);
  is("a zone other than UTC is said by its city", describe("20 23 * * *", "America/New_York"), "every day at 23:20 New York");
  is("a line every() could not have written stays a cron line", describe("0 9 * 1 *"), undefined);

  const refused = (write: () => string) => {
    try {
      return `wrote ${write()}`;
    } catch (error) {
      return (error as Error).message;
    }
  };
  is("a count that does not divide the hour is refused, with what does",
    refused(() => every(7).minutes),
    "every(7).minutes does not divide an hour evenly, so the gaps would not all be the same. It can be 2, 3, 4, 5, 6, 10, 12, 15, 20, 30.");
  is("every(1) points at the plain way to say it", refused(() => every(1).hours), "every(1).hours is every.hour.at(0).");
  is("a time is on a 24 hour clock", refused(() => every.day.at("7am")),
    '"7am" is not a time. Write it on a 24 hour clock, like "07:00" or "22:45".');
  is("two times one cron line cannot hold are refused",
    refused(() => every.day.at("07:00", "19:30")),
    "07:00, 19:30 do not share a minute, and one cron line has only one. Make them two jobs.");
  is("a day of the month some months do not have is refused",
    refused(() => every.month.on(31).at("09:00")),
    "every.month.on(31): the day is 1 to 28, so it happens in every month.");
}

{
  about("a job with no cron line, and one with a bad cron line");

  const { jobsOf, markdownJob } = await import("#chloe/load/load");
  const { startClock } = await import("#chloe/core/clock");
  const folder = await mkdtemp(join(tmpdir(), "chloe-jobs-"));
  await mkdir(join(folder, "jobs"));
  await writeFile(join(folder, "jobs/by-hand.md"), "---\ndescription: Says hello.\n---\n\nSay hello.\n");
  const [byHand] = await jobsOf("test", folder, [markdownJob("jobs/by-hand.md")]);
  is("it loads, with its description", byHand.description, "Says hello.");
  is("its id is the file's name", byHand.id, "by-hand");
  is("and has no cron line", byHand.cron, undefined);

  // The clock ticks once as it starts. A job with a cron line of every minute
  // is due, and the one with none is never due.
  const onTheClock = { ...codeJob("every-minute", async () => "ran"), cron: "* * * * *" };
  const offTheClock = codeJob("when-started", async () => "ran");
  delete offTheClock.cron;
  const clock = startClock(() => new Map([["test", { ...agentFor(onTheClock), jobs: [onTheClock, offTheClock] }]]));
  await new Promise((done) => setTimeout(done, 200));
  clock.stop();
  const ran = (job: string) => db.prepare("select count(*) as n from runs where job = ?").get(job) as { n: number };
  is("the clock runs the one with a cron line", ran("every-minute").n, 1);
  is("and says so in the log", db.prepare("select source from runs where job = 'every-minute'").get(), { source: "schedule" });
  is("and leaves the one without", ran("when-started").n, 0);

  await writeFile(join(folder, "jobs/bad.md"), "---\ncron: 61 * * * *\n---\n\nSay hello.\n");
  const refused = await jobsOf("test", folder, [markdownJob("jobs/bad.md")]).then(() => "", (error: Error) => error.message);
  is("a bad cron line is refused as the agent loads, naming the file", refused.includes("jobs/bad.md has a cron line that does not read"), true);

  const twice = await jobsOf("test", folder, [markdownJob("jobs/by-hand.md"), markdownJob("jobs/by-hand.md")])
    .then(() => "", (error: Error) => error.message);
  is("two jobs with one id are refused", twice, "test: two jobs are called by-hand.");

  const both = await jobsOf("test", folder, [{ id: "both", description: "Both.", run: async () => "", markdown: "Say hello." }])
    .then(() => "", (error: Error) => error.message);
  is("a job that is code and a prompt is refused", both, "test job both has both run and markdown. A job is code or a prompt, never both.");

  const old = await jobsOf("test", folder, [{ id: "old", description: "Old.", run: async () => "", summary: () => "" } as never])
    .then(() => "", (error: Error) => error.message);
  is("a job with a summary is told to use response", old, "test job old has summary, which nothing reads. Say it with `response`.");

  const claims = await jobsOf("test", folder, [{ id: "claims", description: "Claims.", run: async () => "", answers: () => true } as never])
    .then(() => "", (error: Error) => error.message);
  is("a job that claims plain messages itself is refused", claims.startsWith("test job claims has answers, which nothing reads."), true);
  await rm(folder, { recursive: true, force: true });
}

{
  about("a note two jobs want at the same moment");

  const { MEMORIES, note } = await import("@chloejs/core");
  const shape = z.object({ sites: z.record(z.string(), z.string()) }).catch({ sites: {} });
  const kept = note("test-note", "sites", shape);

  // One site to begin with, so that an empty answer later can only mean a
  // reader caught the file mid-write. On a note that has never been written,
  // empty is the honest answer and proves nothing.
  await kept.write({ sites: { "one.example.com": "200" } });

  const many: Record<string, string> = {};
  for (let i = 0; i < 20_000; i++) many[`host-${i}.example.com`] = "200";

  // A reader gets the whole of the old file or the whole of the new one. Before
  // the write was a rename it could catch the file truncated, and a half file
  // reads as the schema's default: no sites at all, which is a wrong answer
  // that looks like a right one.
  const reads: Array<Promise<{ sites: Record<string, string> }>> = [];
  const writing = kept.write({ sites: many });
  for (let i = 0; i < 200; i++) reads.push(kept.read());
  await writing;
  const counts = (await Promise.all(reads)).map((one) => Object.keys(one.sites).length);
  is("nobody reads a half written note", counts.filter((n) => n !== 1 && n !== 20_000), []);
  is("and the note itself is whole afterwards", Object.keys((await kept.read()).sites).length, 20_000);
  const left = (await readdir(join(MEMORIES, "test-note"))).filter((f) => f.endsWith(".part"));
  is("the temporary file is renamed, not left behind", left, []);
  await rm(join(MEMORIES, "test-note"), { recursive: true, force: true });
}

{
  about("no job reaches for a tool");

  // A tool is for a model only, whether it is one of chloe's or the agent's
  // own. A job that imports one is either doing work through a wrapper built
  // for a model, or it wanted a `services/` folder and took the first import that
  // compiled. The other direction is fine: a tool may call a job's function.
  const { loadAll } = await import("@chloejs/core");
  const found = [];
  for (const agent of (await loadAll()).values()) {
    found.push(...(await readdir(agent.folder, { recursive: true, withFileTypes: true })));
  }
  const reaching: string[] = [];
  for (const file of found) {
    if (!file.isFile() || !file.name.endsWith(".ts")) continue;
    if (!file.parentPath.endsWith("/jobs")) continue;
    const source = await readFile(join(file.parentPath, file.name), "utf8");
    if (source.includes('"@chloejs/core/tools/') || source.includes('"../tools/')) reaching.push(file.name);
  }
  is("every job calls the work itself", reaching, []);
}
