// A job written as code, for when markdown frontmatter is not enough.
//
// It takes one of two things, and this is the line the whole repo turns on:
//
//   markdown:  the job is a prompt. A model reads the situation and decides.
//   run:       the job is code. Nothing asks a model unless the code does.
import type { z } from "zod";

import type { Prompt } from "#chloe/core/markdown.ts";
import type { Work } from "#chloe/core/steps.ts";

export interface Definition<
  State extends z.ZodType = z.ZodType<Record<string, unknown>>,
  Result = unknown,
  Input extends z.ZodType = z.ZodType<Record<string, unknown>>,
> {
  /**
   * What the run history files it under, and what `npm run agent` and the
   * evals call it. Name the file after it: jobs/<id>.ts.
   */
  id: string;
  /**
   * When it runs by itself. Five fields: minute, hour, day of month, month,
   * day of week. Without one it runs only when somebody starts it.
   */
  cron?: string;
  /** The prompt: a string for a one-liner, or `prompt("./name.md")`. */
  markdown?: string | Prompt;
  /**
   * The job, when it is code. Branch with `if`, loop with `for`, and put every
   * piece of work inside a `step`: a step is written down so it never runs
   * twice, and a line outside one runs again every time the job resumes.
   */
  run?: (work: Work<z.infer<State>, z.infer<Input>>) => Promise<Result>;
  /**
   * What this job is started with, when it is started by hand rather than by
   * its cron line: a channel command, the API, or `npm run agent`. The shape is
   * the contract, and a caller that does not fit it is refused before the run
   * begins rather than halfway through it.
   *
   * A channel sends a fixed envelope, so a job meant to be reachable from one
   * takes `text` and whichever of `from`, `chat`, `user`, `thread` and
   * `replyTo` it cares about. See https://chloejs.org/docs/jobs.
   *
   * A job with a cron line and a required field cannot run on that line, so
   * give those fields a default.
   */
  input?: Input;
  /**
   * Plain messages, with no command, that this job answers instead of the
   * agent's chat: `answers: (text) => text.includes("https://a.co/")`. A
   * channel that sees one starts the job with the whole message as `text`.
   * Code, not a model: it is asked of every message, so it has to be quick and
   * certain. The first job that says yes gets the message.
   */
  answers?: (text: string) => boolean;
  /**
   * What a finished run did, in one line, from what `run` returned: "15 sites,
   * all up". It is what the overview shows. A job without one shows nothing
   * there, unless it returned a string.
   */
  summary?: (result: Result) => string;
  /**
   * What a chat is sent when this job was started from one, from what `run`
   * returned. Whole, not cut to one line. The summary when unsaid.
   */
  reply?: (result: Result) => string;
  /** The shared store every step can read and write. It survives a pause. */
  state?: State;
  timezone?: string;
  /** When this job should not run on the agent's own model. */
  model?: string;
  /** One line on what it does, shown beside the id. */
  description?: string;
}

/** Only here so a job file is type checked as it is written. */
export function defineJob<
  State extends z.ZodType = z.ZodType<Record<string, unknown>>,
  Result = unknown,
  Input extends z.ZodType = z.ZodType<Record<string, unknown>>,
>(definition: Definition<State, Result, Input>): Definition<State, Result, Input> {
  return definition;
}
