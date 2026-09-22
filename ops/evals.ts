#!/usr/bin/env node
// Running an agent's evals. `npm run evals`, or `npm run evals cc`.
//
// An eval file says what a good run looks like: the situation the agent woke
// up to, what every tool should answer, and what the agent should and should
// not have done about it. This runs the real agent on the real prompt, answers
// every tool from the file, and marks what came out.
//
// One thing makes it safe to run against a live agent: a tool the case does
// not answer is refused rather than run, so a case cannot restart a service or
// send an email however the run goes wrong.
//
// It runs the agent in this process rather than asking the server. The old
// version went over HTTP to whatever was serving, which meant an eval could
// not be run without the service up, and a case could not be stepped through.
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { loadAll, type Agent, turn, type TurnResult, setting, settings } from "@chloejs/core";
import { settingsAndBody } from "#chloe/core/markdown.ts";
import { calls, type ExpectedCalls as Facts, expectations, type ExpectedOutcome as Judged } from "@chloejs/core/scorers";

/** One morning, one nightly run, one anything: a case in an eval file. */
interface Case extends Facts, Judged {
  name: string;
  prompt?: string;
  answers?: {
    tool: string;
    args?: Record<string, unknown>;
    /** Answer this tool however it was called, for one whose arguments do not change the answer. */
    anyArgs?: boolean;
    /** How many calls this answer covers. Default one, and the next call gets the next answer. */
    times?: number;
    returns: unknown;
  }[];
}

interface EvalFile {
  about?: string;
  /** The job whose prompt these cases run, so the two cannot drift apart. */
  job?: string;
  /** Tools a run may reach for that this file does not care about. Answered with nothing. */
  quiet?: string[];
  cases: Case[];
}

/** What a tool the case does not answer says back, plainly rather than as an empty result. */
const NOTHING = "Nothing here. This is an eval, and the case does not answer this tool.";

/** What the marks have to be for a case to pass. */
const PASS = { calls: 1, expectations: 0.8 } as const;

/** Who marks the writing. Cheaper than the agent being marked, on purpose. */
const JUDGE = setting(settings.model.judge, "JUDGE_MODEL");

/**
 * Answer one tool call from the case.
 *
 * Answers are used in the order written, per tool, so a case that checks a
 * site, restarts it and checks again writes the two answers in that order.
 * An answer with `anyArgs` matches however the tool was called; otherwise the
 * arguments have to match, which is what catches an agent asking about one
 * unit by name when the case answered about all of them.
 */
function answerFrom(one: Case, quiet: string[], skills: Map<string, string>) {
  const left = (one.answers ?? []).flatMap((a) =>
    Array.from({ length: a.times ?? 1 }, () => ({ ...a })),
  );

  return (name: string, args: unknown): unknown => {
    // A skill is answered from the real file rather than from the case. It
    // reads something in this repo and changes nothing, and answering it for
    // real is what makes rewriting a skill move the score.
    if (name === "skill") {
      const asked = (args as { name?: string })?.name ?? "";
      const body = skills.get(asked);
      if (body) return body;
      throw new Error(`No skill called ${JSON.stringify(asked)}. You have: ${[...skills.keys()].join(", ")}`);
    }

    const at = left.findIndex(
      (a) => a.tool === name && (a.anyArgs || JSON.stringify(a.args ?? {}) === JSON.stringify(args)),
    );
    if (at !== -1) return left.splice(at, 1)[0].returns;

    // An agent may keep notes or reach for its folder on any run. None of that
    // is what the case is about, so it is answered with nothing rather than
    // stopping the case.
    if (quiet.includes(name)) return NOTHING;

    // Anything else is the point of the whole design: it does not run.
    throw new Error(
      `This is an eval and the case does not answer ${name}(${JSON.stringify(args)}). ` +
        `Nothing runs for real here. Add an answer for it to the eval file, or list it under "quiet".`,
    );
  };
}

/** Every skill this agent has, by both the names a model might use for it. */
async function skillsOf(agent: Agent): Promise<Map<string, string>> {
  const dir = join(agent.folder, "skills");
  const skills = new Map<string, string>();
  for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"))) {
    const skill = settingsAndBody(await readFile(join(dir, file), "utf8"));
    const named = skill.settings.name;
    for (const key of new Set([named, basename(file, ".md")].filter(Boolean) as string[])) {
      skills.set(key, skill.body);
    }
  }
  return skills;
}

function found(agent: Agent, job: string): string {
  const one = agent.jobs.find((s) => s.id === job);
  // A job made of code is checked by running it, not by scoring what it said.
  if (one?.run) {
    throw new Error(
      `${agent.name}/${job} is code, not a prompt. Evals score what a model decided, and this one decides in code.`,
    );
  }
  if (!one) {
    throw new Error(
      `${agent.name} has no job called ${JSON.stringify(job)}. It has: ${agent.jobs.map((s) => s.id).join(", ")}`,
    );
  }
  return one.prompt;
}

async function runFile(loaded: Agent, file: string): Promise<{ passed: number; failed: number }> {
  const agent = loaded.name;
  const spec = JSON.parse(await readFile(file, "utf8")) as EvalFile;
  const skills = await skillsOf(loaded);
  // Through the loader, so a case runs the prompt the agent wakes up to
  // whether that job is markdown or TypeScript.
  const base = spec.job ? found(loaded, spec.job) : "";

  console.log(`\n${agent}/${basename(file, ".json")}  ${spec.cases.length} cases`);
  if (spec.about) console.log(`  ${spec.about}\n`);

  let passed = 0;
  let failed = 0;

  for (const one of spec.cases) {
    const prompt = one.prompt ?? base;
    if (!prompt) throw new Error(`${file}: case ${one.name} has no prompt and the file names no job.`);

    let result: TurnResult;
    try {
      result = await turn({
        agent: loaded,
        prompt,
        source: "eval",
        instead: answerFrom(one, spec.quiet ?? [], skills),
      });
    } catch (error) {
      console.log(`  ✗ ${one.name}: the run itself failed: ${error instanceof Error ? error.message : error}`);
      failed++;
      continue;
    }

    const fact = calls(result, one);
    const judged = await expectations(prompt, result, one, JUDGE);
    const ok = fact.score >= PASS.calls && judged.score >= PASS.expectations;
    ok ? passed++ : failed++;

    console.log(`  ${ok ? "✓" : "✗"} ${one.name}  calls ${fact.score.toFixed(2)}  expectations ${judged.score.toFixed(2)}  $${result.cost.toFixed(4)}`);
    if (!ok) {
      if (fact.score < PASS.calls) console.log(`      calls: ${fact.reason}`);
      if (judged.score < PASS.expectations) console.log(`      expectations: ${judged.reason}`);
      console.log(`      the whole run: /api/runs/${result.runId}`);
    }
  }
  return { passed, failed };
}

const wanted = process.argv[2];
const agents = [...(await loadAll()).values()].sort((a, b) => a.name.localeCompare(b.name));

let passed = 0;
let failed = 0;
let ran = 0;

for (const agent of agents) {
  const evals = join(agent.folder, "evals");
  if (wanted && wanted !== agent.name) {
    // `npm run evals morning-check` runs one file whatever agent it belongs to.
    const owns = (await readdir(evals).catch(() => [])).some((f) => f === `${wanted}.json`);
    if (!owns) continue;
  }
  for (const file of (await readdir(evals).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    if (wanted && wanted !== agent.name && basename(file, ".json") !== wanted) continue;
    const marks = await runFile(agent, join(evals, file));
    passed += marks.passed;
    failed += marks.failed;
    ran++;
  }
}

if (ran === 0) {
  console.error(wanted ? `Nothing to run for ${JSON.stringify(wanted)}.` : "No eval files anywhere.");
  process.exit(2);
}
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
