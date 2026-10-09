---
title: A job is a workflow
order: 3
summary: Every option a job takes, what its code is handed, when it runs, and the one rule that makes carrying on after a pause safe.
---

A job is an async function made of steps, or a prompt. It is written with
`defineJob` and runs only when the agent's `jobs` lists it.

```ts file=example/jobs/stuck-orders.ts#default
```

## Options

| Option | Default | What it controls |
|---|---|---|
| `id` | required | What its runs are filed under, and its name in commands. Do not change it once it has run. |
| `description` | required | One line, shown beside the id. |
| `run` | | The job as code. A job has `run` or `markdown`, never both. |
| `markdown` | | The job as a prompt: `prompt("jobs/<id>.md")` for a file in the agent's folder, or the words themselves. See [A prompt with tools](/docs/prompts). |
| `cron` | none | When it runs by itself. Without one, it runs only when somebody starts it. |
| `timezone` | `"UTC"` | The timezone its cron line is read in, like `"America/New_York"`. Daylight saving is handled. |
| `model` | the agent's | The model this job asks, like `"anthropic/claude-haiku-4.5"`. |
| `args` | none | A zod schema for what it is started with by hand. [Below](#starting-one-with-something). |
| `state` | none | A zod schema for the store every step shares, which survives a pause. |
| `response` | the returned string | Turns what `run` returned into words: a chat gets them whole, and the dashboard shows the first line. |

## What `run` is handed

| | What it does |
|---|---|
| `work.step(name, fn)` | Does something once and writes down what it returned. |
| `work.model(name, options)` | Asks a model one question, answered in a shape you give. |
| `work.agent(name, options)` | Gives a model a goal and tools, and lets it pick the order, inside limits you set. |
| `work.ask(name, options)` | Stops and waits for a person. See [Asking a person](/docs/asking-a-person). |
| `work.state`, `work.setState(next)` | The shared store. A step's result is for the next step; `state` is what the whole job builds up. |
| `work.args` | What this run was started with, already checked against `args`. It does not change. |
| `work.input` | Where the run came from, and the message. [Below](#starting-one-with-something). |
| `work.memory` | The path of the agent's memory folder. |
| `work.agentId`, `work.runId`, `work.owner` | Whose job, which run, and who it is for. |

The options of `model` and `agent`, and when to use which, are in
[Step, model, agent](/docs/primitives).

## Work happens inside a step

A job that waited on a person carries on by running the function again from the
top, with each finished step handing back what it returned last time instead of
running again. So **a line outside a step runs again on every resume**: if it
sends, writes or spends, it does so twice. Code outside a step only decides.

If the job was edited while a run was waiting, the run stops and says the job
changed, rather than handing a recorded answer to the wrong step. Start it
again.

A run that was going when chloe stopped is closed as failed. Only a run waiting
on a person survives a restart.

## Two runs never overlap

A second run of the same job is skipped, not queued, and a job waiting on
somebody does not start again. A job that takes longer than its own interval
runs less often than its cron line says.

## When it runs

`cron` is a cron line, and `every` from `@chloejs/core/timer` writes one in
words:

```ts
every(15).minutes               // */15 * * * *
every(4).hours                  // 0 */4 * * *
every.hour.at(30)               // 30 * * * *
every.day.at("07:00")           // 0 7 * * *
every.day.at("10:45", "22:45")  // 45 10,22 * * *
every.weekday.at("9:30")        // 30 9 * * 1-5
every.monday.at("9:00")         // 0 9 * * 1
every.month.on(1).at("09:00")   // 0 9 1 * *
```

A line that cannot run evenly is refused as the file loads, with the reason:
`every(7).minutes` would run at :56 and again at :00, `every.month.on(31)` would
skip short months, and two times with different minutes need two jobs. A plain
cron string works too.

Without a `cron`, a job runs when somebody starts it: the Run button on the
dashboard, `npx chloe agent <agent> <job>`, `POST /api/agents/<agent>/job/<id>`,
or `/<job id>` in a chat.

## Starting one with something

**The message** is always there, in `work.input`, with nothing to declare:

| | |
|---|---|
| `text` | what was said, with the `/command` taken off |
| `from` | the channel it came through, like `"telegram"` |
| `chat` | the conversation's id on that channel |
| `chatTitle` | the conversation's name, when it has one |
| `user` | who sent it, by name |
| `userId` | who sent it, by their id on that channel: an email address, a Telegram id, a visitor's id |
| `thread` | the conversation as chloe files it |
| `replyTo` | the message this one answered, when it did |

A run the clock started has an empty `input`.

**Anything else** is declared in `args`, a zod schema, and read from
`work.args`:

```ts
export default defineJob({
  id: "refunds-for",
  description: "Pays one customer's refunds.",
  args: z.object({ customer: z.string().min(1) }),
  run: async (work) => {
    const customer = work.args.customer;
  },
});
```

What it is sent is checked **before the run exists**, so a caller that sent the
wrong thing is told at once. Anything not in `args` is refused rather than
dropped, and a job with no `args` takes only a message.

- **Over the API**, as a query string or JSON, the body winning where they
  overlap. Everything in a query string is a string, so ask for a number with
  `z.coerce.number()`.

```sh
curl -X POST "http://127.0.0.1:3067/api/agents/shop/job/refunds-for?customer=c-42" \
  -H "authorization: Bearer $CHLOE_TOKEN"
```

- **From a chat**, as `/<job id>` and words. The words fill `args` in order, and
  the last field takes the rest of the line, so with
  `args: z.object({ location: z.string() })`, `/check-weather New York` is one
  location. A command missing a field is answered with how to write it. Only a
  person's message starts a job this way: a model's reply that reads
  `/<job id>` is only sent.

A job with a cron line cannot be handed `args` on that line, so give each field
a default, or leave the cron off.
