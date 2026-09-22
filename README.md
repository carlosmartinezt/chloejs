# Chloe

[![npm](https://img.shields.io/npm/v/@chloejs/core)](https://www.npmjs.com/package/@chloejs/core)

**[chloejs.org](https://chloejs.org)**: the docs, the examples and the reference.

Chloe is a TypeScript agent framework that uses AI only when you need it.

You write the workflow in code, **and ask AI where a step needs judgement**. You
decide where deterministic work ends and where non-deterministic work begins.

```sh
npm install @chloejs/core @chloejs/ui
```

- **No build step**, and an edit to a job is live in under a second
- **One dependency**, zod, and one SQLite file
- **Node 22.18** or newer

[Get started](https://chloejs.org/docs/start) ·
[Examples](https://chloejs.org/examples) ·
[Primitives](https://chloejs.org/docs/primitives)

## The least autonomy that does the job

Three ways to do a piece of work. Start at the top, and move down only when you
have to.

| | | |
| --- | --- | --- |
| `work.step()` | I know what to do. | Deterministic work. You control the workflow and the action. |
| `work.model()` | I know what to ask. | Judgement, in a shape. You control the workflow, the model controls the answer. |
| `work.agent()` | I know what I want. | Bounded autonomy. You control the goal and the boundaries, the model controls the order. |

There is a fourth. `work.ask()` stops the job and waits for a person.

## Ordinary code, one model decision, optional autonomy

A whole job, from the example on chloejs.org. Code loads the inbox, a model says
what each message is about, and the ones that need looking into get an agent.

```ts
export default defineJob({
  id: "order-issues",
  cron: every(15).minutes,
  description: "Reads what customers wrote in and looks into the ones that need looking into.",
  run: async (work) => {
    const messages = await work.step("load messages", () => unread());

    const looked: string[] = [];
    for (const message of messages) {
      const issue = await work.model("classify issue", {
        prompt: message.text,
        output: Issue,
      });
      if (!issue.needsInvestigation) continue;

      const found = await work.agent("investigate issue", {
        goal: `Find out what went wrong for customer ${message.customer}, and recommend what to do.`,
        tools: [getOrders, pastMessages],
        maxSteps: 6,
        budget: 0.05,
      });

      looked.push(`${message.id}: ${found}`);
    }

    return { looked };
  },
});
```

## Keep the application in charge

Your rules, loops, conditions and queries stay in TypeScript. The model is asked
one thing, and the `if` above it decides whether to ask at all.

```ts
const late = orders.filter((order) => order.daysLate > 2);
if (late.length === 0) return;

const summary = await work.model("summarise the delays", {
  prompt: late.map(describe).join("\n"),
  output: Summary,
});
```

A morning with nothing late costs nothing.

## You can point at the line that asks a model

The run record has one line per step, with what it was, how long it took and
what it cost. A job that quietly grew a second model call shows up as a second
line and a bigger number.

## Sometimes you know the goal, not the steps

The model chooses the order. You choose what it can reach and how far it can
go: `tools` is all it can reach, `approve` is which of those calls may run,
`maxSteps` and `budget` are how far it can go and what it may spend, and
`output` is the shape of the answer. Everything it did is on the run.

## Some decisions should not belong to a model

The run stops, the question goes to whoever should answer it, and the job
carries on when they do. It can wait days, and it survives a restart while it
waits.

```ts
const approved = await work.ask("refund $2,400?", {
  question: "A-4417 arrived broken. Refund it?",
  answer: z.boolean(),
  within: "2d",
  otherwise: false,
});

if (approved) await work.step("issue refund", () => refund(order));
```

The answer is checked against the shape the ask named. No model is involved.

## Jobs survive the real world

Steps, model calls, agent loops and human pauses are all part of one durable
run, and you can open any of them.

- A finished step replays from the record.
- A job resumes after a restart.
- An approval can wait for days.
- Every tool call an agent made is recorded.
- Cost is tracked per step and per run.
- Two runs of the same job never overlap.

One rule makes the replay safe: **work happens inside a step, and code outside a
step only decides.** A step is written down, so it never runs twice. A line
outside one runs again on every resume, so it must not send, write or spend.

## What comes with it

| | |
| --- | --- |
| Durable jobs | Steps are written down as they finish, and replayed on a resume. |
| Schedules | Cron lines in TypeScript, with real time zones. |
| Models | Any model the gateway reaches, and a job can pick its own. |
| Agents | Tools, approvals and a budget, set where the step is written. |
| Tools | A description, a schema and one call. Typed at both ends. |
| Human approvals | A run parks for days and carries on when somebody answers. |
| Channels | Telegram and Slack, one file each. A question goes out where the person is. |
| Memory | Notes an agent keeps, and skills it can rewrite. |
| Run history | Every step of every run, with its arguments and its answer. |
| Cost tracking | Per step, per run, per job. |
| Structured output | Zod on every model and agent answer, retried once. |
| Testing and evals | Jobs run for real against a stand-in gateway. Prompts are scored. |

## Code is tested. Words are scored.

Your deterministic logic gets ordinary tests. Your prompts get evals. Neither
spends real money: a test runs against a stand-in gateway, and an eval answers
every tool from the case.

```sh
npm run test          # the jobs: does it do the thing
npm run evals <name>  # the prompts: did the model decide well
```

## Run it wherever Node runs

Your code, your models, your machine. One process serves the page, keeps every
cron line and answers the channels. The runtime's only dependency is zod and its
state is one SQLite file, so moving machine is copying a folder.

Three files, and you have an agent:

```
chloe.config.ts        the agents this copy runs
settings.json          which model, and how to reach it
your-agent/agent.ts    what the agent is: its jobs, tools and channels
```

```sh
npm run account                  # make the one account
npm start                        # the one process, on 127.0.0.1:3067
npm run agent <name>             # talk to one agent
npm run agent <name> <job>       # run one job now, without waiting for its cron line
```

Without `@chloejs/ui` the runtime serves a plain page of its own. With it, that
page is the dashboard. The runtime never names that package: it serves whatever
installed package declares a page.

## What is in here

The package is this repo: what is at the top is what is published.

```
index.ts     what "@chloejs/core" is when you import it
server.ts    the server, and the only thing that is run
model/       asking a model, and tools/, the only thing a model can be handed
load/        what an agent and a job are, and reading them off disk
timer/       cron lines and every(), published as "@chloejs/core/timer"
serve/       the one port: every route, the login, tokens, the plain page
core/        the floor. steps.ts runs a job, turn.ts runs a prompt, clock.ts
             starts each job when its cron line is due
scorers/     how a run is marked
services/    the work itself, called straight from a job
channels/    the ways in, for an agent to bind
ops/         the tests, the evals, talking to an agent, making the account,
             and install.sh, which installs the service
test-agent/  the agent the tests load. Not published
```

Six entrances and no others: `@chloejs/core`, `@chloejs/core/tools`,
`@chloejs/core/channels/<name>`, `@chloejs/core/scorers`, `@chloejs/core/timer` and
`@chloejs/core/test`.

## Use code when you know what to do. Use AI when you do not.

Start with a job that asks nobody anything. Add the step that needs judgement
when you find it, and read what it cost.

The docs are at [chloejs.org](https://chloejs.org). Its reference pages are read
out of this source on every push to `main`, so they cannot describe a version of
the code that does not exist.

MIT.
