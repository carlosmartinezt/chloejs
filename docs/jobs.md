---
title: A job is a workflow
order: 3
summary: Steps, state, replay, and the one rule that makes carrying on after a pause safe.
---

A job is an input, a state and steps. It is an async function, so branching and
looping are `if` and `for`: a job can stop early (if nothing is late, end), loop
(each refund asked for) and wait (ask before paying a big one). Carrying on after a
pause means running the function again from the top, with every finished step
handing back what it returned last time.

One rule makes that safe: **work happens inside a step, and code outside a step
only decides.** A finished step is written down and replayed, not run again, when
a run that was waiting carries on. A line outside a step runs again every time
the job resumes, so it must not send, write or spend.

That is the price of `if` and `for` instead of a builder API, and it is the trap
worth knowing before you write your second job.

A stop is the other half. A run the service stopped in the middle of is closed as
failed and starts again from its first step on the next run. Only a run waiting
on a person survives the stop, and it carries on from where it parked.

## What a job is handed

- `step(name, fn)` does something, writes down what it returned, and replays
  that instead of doing it again when a run that was waiting carries on.
- `model(name, options)` asks a model one question and validates the answer
  against a zod schema, or an AI SDK `Output` such as `Output.choice`.
- `agent(name, options)` hands a goal and some tools to a model and lets it
  choose the order, inside the tools it was given, the calls you allow and the
  limits you set on turns and on spending.
- `ask(name, options)` stops and waits for a person. See
  [asking a person](/docs/asking-a-person).

The first three are [the autonomy hierarchy](/docs/primitives): reach down it,
not up it.
- `state` is the shared store, with a schema of its own, and it survives a
  pause. A step's result is for the step after it; `state` is what the whole job
  is accumulating. Two channels, not one bag, which is why a parked job can show
  somebody what it already found before it asks them anything.
- `args` is what this run was started with, beyond the message, and it does
  not change. Most jobs declare nothing and never touch it. `state` moves,
  `args` does not, so there is nothing to set.
- `input` is where the run was started from: the text, the channel, the chat
  and who said it (`user`, their name, and `userId`, their id on that channel).
  Always there, so a job that reads what started it declares nothing. A job a
  channel hands every message to (`job` on the channel, see
  [channels](/docs/channels)) reads the message from here.
- `memory` is where its agent remembers things. A job that files something
  there reads the path from here, so the agent's definition is the one place
  that says where.

## A job says what it did

`response` turns what `run` returned into words: a chat is sent them whole, and the
overview shows their first line. The job knows what its result means, so the
page never guesses. A job without one shows no line unless it returned a
string, and a prompt's line is the start of its reply. A job that returns a
string needs nothing else: the string is what the chat is sent.

## A job that was edited under a parked run

The replay checks each step's name as well as its place, because handing the
wrong recorded answer to the wrong step would look like it worked. If the job
changed, the run stops and says so. Start it again.

## Two runs never overlap

Whether it is code or a prompt, a second run of the same job is skipped rather
than queued, and a job already waiting on somebody is not started again. A job
that takes longer than its own interval quietly runs less often than its cron
line says.

## When a job runs

`cron` is a cron line, and `@chloejs/core/timer` writes one in words:

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

What a cron line cannot say evenly is refused as the file loads, with the reason
and the file's name: `every(7).minutes` would run at :56 and again at :00,
`every.month.on(31)` would skip short months, and two times of day with
different minutes need two jobs. A plain cron string still works.

`timezone` is a real timezone name and daylight saving is handled through
`Intl`, so write `every.day.at("07:00")` with `timezone: "America/New_York"` and
stop doing UTC arithmetic in a comment.

Without a `cron` a job runs only when somebody starts it: the Run button,
`npm run agent <agent> <job>`, `POST /api/agents/<agent>/job/<id>`, or a
channel command.

## Starting one with something

A job that is started by hand is told what about in its message: no declaration,
just `work.input`:

```ts
export default defineJob({
  id: "reading-companion",
  description: "Files a Kindle highlight under its book.",
  run: async (work) => {
    const highlight = work.input.text;
  },
});
```

A job that takes more than a message, usually from another system over the API,
says so in `args`, a zod schema, and `work.args` is what came in, already
checked:

```ts
export default defineJob({
  id: "refunds-for",
  description: "Pays one customer's refunds.",
  args: z.object({
    customer: z.string().min(1),
  }),
  run: async (work) => {
    const customer = work.args.customer;
  },
});
```

The shape is the contract, and it is checked **before the run exists**, so a
caller that sent the wrong thing is told so rather than handed a run id and left
to work out later that it failed. The message always rides along outside it: a
job with no `args` still reads `work.input`, and sending only a message to
one is never refused. Anything else sent to it is refused rather than dropped:
a job quietly ignoring what you sent is worse than one that says no.

**Over the API**, as a query string or as JSON, with the body winning where the
two overlap. Everything in a query string is a string, so a job that wants a
number says `z.coerce.number()`.

```sh
curl -X POST "http://127.0.0.1:3067/api/agents/chloe/job/reading-companion?text=a+highlight" \
  -H "authorization: Bearer $CHLOE_TOKEN"
```

**From a channel**, as `/<job id>` at the start of a message. The words after
it fill the job's `args` in order, and the last field takes the rest of the
line, so with `args: z.object({ location: z.string() })`,
`/check-weather New York` is one location. A command missing a field is
answered with how to write it. Every channel also sends the same envelope, so a
job written against it works from all of them:

| | |
| --- | --- |
| `text` | the message with the command taken off |
| `from` | which channel it came through |
| `chat` | the conversation's id there |
| `chatTitle` | what that conversation is called, when it has a name |
| `user` | who sent it |
| `thread` | the conversation as the runtime files it, for reading back what was said before |
| `replyTo` | the message this one was a reply to, when it was |

A job reads whichever of those it cares about off `work.input` and declares
nothing. The reply in the chat is the job's `response`, or what `run` returned when
it returned words.

"If the message starts with `/x`, run `x`" is a rule somebody can write down, so
it is code and nothing asks a model what was meant. A slash message that is not
one of that agent's jobs is an ordinary message and goes to the model as usual.

A job with a cron line and a required `args` field cannot run on that line, so
give those fields a default, or leave the cron off.
