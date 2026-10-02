// A job written as code, for when markdown frontmatter is not enough.
//
// It takes one of two things, and this is the line the whole repo turns on:
//
//   markdown:  the job is a prompt. A model reads the situation and decides.
//   run:       the job is code. Nothing asks a model unless the code does.
import type { z } from "zod";

import type { Prompt } from "#chloe/core/markdown";
import type { Data, Work } from "#chloe/core/steps";

/**
 * What defineJob is given, and what a job file is checked against as it is
 * written: an id and a description always, a zod schema wherever there is a
 * shape, and one of `run` or `markdown` (the loader refuses both or neither,
 * the editor cannot).
 */
export interface JobConfig<
  State = Data,
  Result = unknown,
  Args = Data,
> {
  /**
   * What the run history files it under, and what `npm run agent` and the
   * evals call it. A file named jobs/<id>.ts is listed as the job's file on the
   * page; any other name works, and a file may hold several jobs.
   */
  id: string;
  /** One line on what it does, shown beside the id. */
  description: string;
  /**
   * When it runs by itself. Five fields: minute, hour, day of month, month,
   * day of week. Without one it runs only when somebody starts it.
   */
  cron?: string;
  timezone?: string;
  /** When this job should not run on the agent's own model. */
  model?: string;
  /** The prompt: a string for a one-liner, or `prompt("./name.md")`. */
  markdown?: string | Prompt;
  /**
   * The job, when it is code. Branch with `if`, loop with `for`, and put every
   * piece of work inside a `step`: a finished step is replayed, not run again,
   * when a run that was waiting carries on, and a line outside one runs again
   * every time the job resumes.
   */
  run?: (work: Work<State, Args>) => Promise<Result>;
  /**
   * A zod schema for the extra things this job is started with by hand, beyond
   * the message: the API's JSON, or `npm run agent`. The shape is the
   * contract, and a caller that does not fit it is refused before the run
   * begins rather than halfway through it. `work.args` is what it parsed.
   *
   * Most jobs declare nothing: the message arrives as `work.input` either
   * way, and a job with no `args` still reads it. A channel sends a fixed
   * envelope, so a job meant to be reachable from one finds `text` and
   * whichever of `from`, `chat`, `user`, `thread` and `replyTo` it cares about
   * there. See https://chloejs.org/docs/jobs.
   *
   * A job with a cron line and a required field cannot run on that line, so
   * give those fields a default.
   */
  args?: z.ZodType<Args>;
  /**
   * A zod schema for the shared store every step can read and write. `work.state`
   * starts as what it parses `{}` into, so a field with a default starts filled.
   * It survives a pause.
   */
  state?: z.ZodType<State>;
  /**
   * What to say about what `run` returned, in full: a chat is sent it whole,
   * and the overview shows its first line. A job without one says what it
   * returned when that is a string, and shows no line otherwise.
   */
  response?: (result: Result) => string;
}

/**
 * Only here so a job file is type checked as it is written.
 *
 * What to send is an `id` and a `description`, and then one of `run` or
 * `markdown`, never both:
 *
 * ```ts
 * export default defineJob({
 *   id: "hello",
 *   description: "Says hello.",
 *   run: async (work) => work.step("say hello", () => "hello"),
 * });
 * ```
 *
 * A job that returns facts instead of words says what they mean in `response`,
 * once for the chat and the overview both:
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
 * Every key is on `JobConfig`, a line each saying what it does, and the editor
 * lists them and checks them as the object is written.
 */
export function defineJob<
  State = Data,
  Result = unknown,
  Args = Data,
>(definition: JobConfig<State, Result, Args>): JobConfig<State, Result, Args> {
  return definition;
}
