// A job written as code, for when markdown frontmatter is not enough.
//
// It takes one of two things, and this is the line the whole repo turns on:
//
//   markdown:  the job is a prompt. A model reads the situation and decides.
//   run:       the job is code. Nothing asks a model unless the code does.
import type { z } from "zod";

import type { Prompt } from "#chloe/core/markdown";
import type { Data, Work } from "#chloe/core/steps";
import type { SdkModel } from "#chloe/model/key";

/**
 * The options you give `defineJob`. Every job needs an `id`, a
 * `description`, and exactly one of `run` (the job is code) or `markdown`
 * (the job is a prompt). Your editor cannot catch a job with both or with
 * neither, but the agent will not load with one.
 */
export interface JobConfig<
  State = Data,
  Result = unknown,
  Args = Data,
  /** The type `args` accepts before it is parsed. `agent.run` uses it so your editor can check `input`. */
  ArgsIn = Args,
> {
  /**
   * The job's id, like `"morning-report"`. The run history files its runs
   * under it, and `npx chloe agent <agent> <job>` and the evals use it.
   * People can start the job from a chat by sending `/<id>`. Required.
   *
   * Do not change it after the job has run. A job in a file named
   * `jobs/<id>.ts` is shown on the dashboard with that file. Any other file
   * name works too, and one file can hold several jobs.
   */
  id: string;
  /** One line on what the job does. The dashboard shows it next to the id. Required. */
  description: string;
  /**
   * When the job runs by itself, as a cron line with five fields: minute,
   * hour, day of month, month, day of week. For example, `"0 7 * * *"` is
   * every day at 07:00. You can also write `every.day.at("07:00")`, with
   * `every` from `@chloejs/core/timer`.
   *
   * Default: none, so the job runs only when somebody starts it. A cron line
   * that cannot be read stops the agent from loading.
   */
  cron?: string;
  /** The timezone for `cron`, like `"America/New_York"`. Daylight saving time is handled for you. Default: `"UTC"`. */
  timezone?: string;
  /**
   * The model for this job, when it should not use the agent's model. A name
   * like `"anthropic/claude-haiku-4.5"`, or an AI SDK model like
   * `anthropic("claude-opus-5-5")`. Default: the agent's model. A model
   * picked for this job on the dashboard, or with `/models` in a chat, comes
   * first.
   */
  model?: string | SdkModel;
  /**
   * The job's prompt, for a job that is a prompt: a string, or
   * `prompt("jobs/morning.md")` for a file inside the agent's folder. The
   * agent answers it with its instructions and its tools. Give either
   * `markdown` or `run`, not both.
   */
  markdown?: string | Prompt;
  /**
   * The job's code, for a job that is code. Use `if` and `for` as normal, and
   * put each piece of real work (sending, writing, spending, calling a
   * service) inside `work.step()`. Give either `run` or `markdown`, not both.
   *
   * This matters because a job that pauses to wait for an answer runs again
   * from the top when it continues. A finished step gives back its saved
   * result and does not run again. Code outside a step runs again each time,
   * so if it sends or writes something, that happens twice.
   */
  run?: (work: Work<State, Args>) => Promise<Result>;
  /**
   * A zod schema for the values the job takes when somebody starts it by
   * hand, from the API or `npx chloe agent`. Read them as `work.args`. If the
   * values do not fit the schema, the job is refused before the run starts.
   *
   * Default: none, and then the job refuses any values it is sent. Most jobs
   * need none: the message that started the job is always in `work.input`
   * (`text`, `from`, `chat`, `user`, `thread`, `replyTo` and the rest). See
   * https://chloejs.org/docs/jobs.
   *
   * In a chat, `/<id> some words` fills the fields of `args` in order, and the
   * last field takes the rest of the line. A job with a `cron` line cannot run
   * on it if `args` has a required field, so give those fields a default.
   */
  args?: z.ZodType<Args, ArgsIn>;
  /**
   * A zod schema for data that every step of a run can read and change. Read
   * it as `work.state` and change it with `work.setState()`. It is kept while
   * the job pauses to wait for an answer.
   *
   * It starts as the schema's parse of `{}`, so give a field a default to
   * start it filled.
   */
  state?: z.ZodType<State>;
  /**
   * Turns what `run` returned into the words people see. A chat gets the
   * whole text, and the overview on the dashboard shows its first line.
   *
   * Default: if `run` returns a string, that string is used. Otherwise there
   * are no words.
   */
  response?: (result: Result) => string;
}

/**
 * Defines a job. It returns what you give it, unchanged, so that your editor
 * checks the job as you write it.
 *
 * Give an `id` and a `description`, and then either `run` or `markdown`,
 * not both:
 *
 * ```ts
 * export default defineJob({
 *   id: "hello",
 *   description: "Says hello.",
 *   run: async (work) => work.step("say hello", () => "hello"),
 * });
 * ```
 *
 * If `run` returns data and not words, use `response` to turn the data into
 * words for the chat and the overview:
 *
 * ```ts
 * export default defineJob({
 *   id: "site-check",
 *   description: "Asks every site and says which are down.",
 *   run: async (work) => ({ checked: 12, down: ["a.co"] }),
 *   response: (r) => (r.down.length === 0 ? `All ${r.checked} sites up.` : `${r.down.join(", ")} down.`),
 * });
 * ```
 *
 * Every option is on `JobConfig`, with a note on what it does. Your editor
 * lists them and checks them as you write.
 */
export function defineJob<
  State = Data,
  Result = unknown,
  Args = Data,
  ArgsIn = Args,
>(definition: JobConfig<State, Result, Args, ArgsIn>): JobConfig<State, Result, Args, ArgsIn> {
  return definition;
}
