# Chloe

[![npm](https://img.shields.io/npm/v/@chloejs/core)](https://www.npmjs.com/package/@chloejs/core)

**[chloejs.org](https://chloejs.org)**: the docs, the examples and the reference.

Chloe is a TypeScript agent framework that uses AI only when you need it.

You write the workflow in code, **and ask AI where a step needs judgement**. You
decide where deterministic work ends and where non-deterministic work begins.

```sh
npm install @chloejs/core
npx chloe setup       # the files, a model, the one password: it asks, and checks
npx chloe             # the agents, the cron lines and one port on 127.0.0.1:3067
```

`setup` writes `chloe.config.ts` and one agent with two jobs, asks which model to
use and makes one call to be sure it answers, then runs the job that asks no
model, so the first thing you see is a finished run. Run it again later and it
leaves what is already there alone.

- **No build step in your project**, and an edit to a job is live in under a second
- **One dependency**, zod, and one SQLite file
- **Node 22.18** or newer

[Get started](https://chloejs.org/docs/start) ·
[Examples](https://chloejs.org/examples) ·
[Primitives](https://chloejs.org/docs/primitives)

## Somewhere to watch it from

The runtime serves its own page, and `@chloejs/ui` turns that into a dashboard.
Both are on the box it runs on. To watch it from anywhere without opening a
port, point it at a Chloe Cloud.

Make a workspace there, and put the key it shows you once in `.env`, beside
`chloe.config.ts`, which is one of the questions `npx chloe setup` asks:

```sh
CHLOE_API_KEY=chl_workspace_...
```

That is the whole of it: `https://dashboard.chloejs.org` is where it looks
unless `cloud.url` in settings says otherwise. It connects out and stays
connected, and that dashboard can then show this runtime and send it what you
ask for. Nothing reaches in: there is no port to open, no domain and no
certificate. What may be asked for is switch by switch
in `cloud.remote`, off for memory and for writes until you say otherwise, and
taking the key out leaves everything running exactly as it was.

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
| Models | A Claude subscription, a ChatGPT plan, opencode, or any model a gateway key reaches. A job can pick its own. |
| Agents | Tools, approvals and a budget, set where the step is written. |
| Tools | A description, a schema and one call. Typed at both ends. A tool that needs somebody signed in brings that with it. |
| Human approvals | A run parks for days and carries on when somebody answers. |
| Channels | Telegram, Slack and WhatsApp, one file each, and no dependency of their own. A question goes out where the person is. |
| Memory | A folder of notes per agent, in one git repository of their own: one commit per run, under the agent's name. |
| Self-improvement | An agent can rewrite its skills, jobs and instructions if you let it, never its code. Every change can be undone. |
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
package.json           with "type": "module", so node reads your .ts files
chloe.config.ts        the agents this copy runs, and every setting
your-agent/agent.ts    what the agent is: its jobs, tools and channels
```

A setting is a choice about how the runtime behaves, so it goes in the config
with the agents, where it is typed and committed:

```ts
export default defineConfig({
  agents: [tempo],
  settings: {
    model: { default: "anthropic/claude-sonnet-5" },
    email: { provider: "resend" },
  },
})
```

What it leaves out is the default. Every setting is the `Settings` interface in
`core/settings.ts`, with its one line of explanation on it, so your editor tells
you what each one is as you write it. `DEFAULTS` beside it is what each one is
when nobody says, and the table on chloejs.org is read out of both.

A value that is this box's goes in `.env` beside the config instead, mode 600 and
never committed: every credential, and anything naming a home directory, a
machine or a person. Every setting has a name there, `CHLOE_` and its path in
capitals, so a box can run with nothing declared at all:

```
CHLOE_MODEL_KEY=...
CHLOE_RESEND_API_KEY=re_...
CHLOE_AGENTS_TEMPO_TELEGRAM=123456789:ABC...
CHLOE_CLOUD_REMOTE_WRITE=false
```

A variable beats the config, a list is written with commas, and a switch that
is neither `true` nor `false` is refused at startup rather than read as off.
`state`, `memory` and `node` are read before the config is, so those three are
only read from here.

```sh
npx chloe account                # set the one password
npx chloe                        # the one process, on 127.0.0.1:3067
npx chloe agent <name>           # talk to one agent
npx chloe agent <name> <job>     # run one job now, without waiting for its cron line
npx chloe install                # run it as a service, so it survives a reboot
```

Without `@chloejs/ui` the runtime serves a plain page of its own. With it, that
page is the dashboard. The runtime never names that package: it serves whatever
installed package declares a page.

## What is in here

The package is this repo, compiled into `dist/` on publish. Node refuses to
strip types for anything under `node_modules`, so what you install is
JavaScript; your own agent files are outside `node_modules` and node reads
those directly, which is why there is still no build step in your project.

```
index.ts     what "@chloejs/core" is when you import it
server.ts    the server, which `npx chloe` runs
model/       asking a model, and tools/, the only thing a model can be handed
load/        what an agent and a job are, and reading them off disk
timer/       cron lines and every(), published as "@chloejs/core/timer"
serve/       the one port: every route, the login, tokens, the plain page
core/        the floor. steps.ts runs a job, turn.ts runs a prompt, clock.ts
             starts each job when its cron line is due
scorers/     how a run is marked
services/    the work itself, called straight from a job, published as
             "@chloejs/core/services"
channels/    the ways in, for an agent to bind
ops/         cli.ts, which is `npx chloe`, and what it runs: the tests, the
             evals, talking to an agent, setting the password, and install.sh
test-agent/  the agent the tests load. Not published
```

Seven entrances and no others: `@chloejs/core`, `@chloejs/core/services`,
`@chloejs/core/tools`, `@chloejs/core/channels`, `@chloejs/core/scorers`,
`@chloejs/core/timer` and `@chloejs/core/test`.

## Use code when you know what to do. Use AI when you do not.

Start with a job that asks nobody anything. Add the step that needs judgement
when you find it, and read what it cost.

The docs are at [chloejs.org](https://chloejs.org). Its reference pages are read
out of this source on every push to `main`, so they cannot describe a version of
the code that does not exist.

MIT.
