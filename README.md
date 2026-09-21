# Chloe

A TypeScript job runner where AI is a step, not the runtime.

Use deterministic code wherever you can, and give autonomy to a model only where
the task genuinely needs judgement, or a sequence nobody can write down in
advance. Most agent frameworks put the model in charge and let it call your
code. Here the job is in charge, and a model is something the job calls.

Three primitives say how much autonomy a piece of work is getting:

| | | |
| --- | --- | --- |
| `work.step()` | I know what to do. | You control the workflow and the action. |
| `work.model()` | I know what to ask. | You control the workflow. The model answers one question. |
| `work.agent()` | I know what I want. | You control the boundaries. The model picks the order inside them. |

Most of a job is the first one. A job that needs no judgement never reaches a
model and spends nothing:

```ts
// jobs/stuck-orders.ts
export default defineJob({
  id: "stuck-orders",
  cron: every(2).hours,
  description: "Finds orders that are paid for and late, and tells the warehouse.",
  run: async (work) => {
    const all = await work.step("read the orders", () => orders());
    const late = all.filter((one) => stuck(one));
    if (late.length === 0) return { checked: all.length, late: [] };
    await work.step("tell the warehouse", () => tellTheWarehouse(late));
    return { checked: all.length, late: late.map((one) => one.id) };
  },
});
```

When a step needs judgement, it is a step of its own with a shape for the
answer, and the run record prices it:

```ts
const read = await work.model("work out what each one is about", {
  model: "anthropic/claude-haiku-4.5",
  output: Sorted,
  prompt: waiting.map((one) => `${one.id} (${one.at}): ${one.text}`).join("\n\n"),
});
```

And when the order of the work cannot be known in advance, and only then, you
hand that over too, bounded by the tools you give it and the limits you set:

```ts
const reason = await work.agent(`work out why ${one.name} stopped ordering`, {
  goal: `${one.name}, customer ${one.id}, last ordered on ${one.lastOrder}. Work out why, and what to do about it.`,
  tools: [ordersTheyPlaced, whatTheyWroteIn, whatWasFoundBefore],
  approve: (call) => call.args.customer === one.id || `${one.id} is the customer being looked into`,
  output: Reason,
  maxSteps: 8,
  budget: 0.05,
});
```

The autonomy is over the order and nothing else. Four limits stay in the file:
`tools` is what it may do at all, `approve` is which of those calls may run
(asked before each one, with the arguments the model wrote), `maxSteps` and
`budget` are how far it may go in turns and in dollars, and `output` is the
shape of the answer.

Three things follow, and they are the whole design:

1. **The autonomy is named in the file.** Not a default, not something a helper
   does on your behalf. If you cannot point at the line, it does not happen.
2. **A model answers in a shape.** Validated against a zod schema, so free text
   never reaches the next step's control flow.
3. **The run record says what each step was and what it cost.** A job that
   quietly grew a second model call shows up as a second line and a bigger
   number.

## Which one to reach for

Ask which sentence is true, and write that one.

1. I know the operations and the order. That is `step`.
2. I know the question and the shape of the answer. That is `model`.
3. I know the outcome and the tools, and nothing about the order. That is `agent`.

If you can write the rules down, it is code. "Restart it if it is down" is code.
"Say what today looked like" is a model. "Work out why this failed" is an agent.

An agent step keeps what matters yours: it can call nothing it was not handed,
only the calls you allow run, it stops at the turn or the dollar you set, its
answer is validated against your schema, and every call it made is on the run
with its arguments and whether it was allowed. The step is priced as a whole,
and a step that hit a limit is written down too.

The example on [chloejs.org](https://chloejs.org/examples) is a small shop's
back office with a job at each level: late orders, a support inbox, buying stock, a customer who
went quiet, a refund somebody has to decide, and one job that is a prompt from
end to end. Its `do/` folder stands in for the systems a shop already has, so it
runs with nothing installed.

## Start

Node 22.18 or newer, because Node runs the TypeScript directly and none of this
is built.

```sh
npm install chloejs
```

Three files, and you have an agent:

```
chloe.config.ts        the agents this copy runs
settings.json          which model, and how to reach it
your-agent/agent.ts    what the agent is: its jobs, tools and channels
```

Then `npm run account` makes the one account, and `npm start` runs the one
process: it answers the API, keeps every cron line, answers the channels, and
serves a small site of its own on `127.0.0.1:3067` showing what is loaded.
`npm install` [`chloejs-ui`](https://www.npmjs.com/package/chloejs-ui) and that
site becomes a dashboard. The runtime has never heard of that package: it serves
whatever installed package declares a page, which is a convention anyone can
meet.

`npm run agent <name>` talks to one agent from the
terminal, and `npm run agent <name> <job>` runs one job without waiting for its
cron line.

There is no build and no deploy. The process watches each agent's folder, so an
edit to a job is live in under a second, including a new agent folder. A change
to the runtime itself needs a restart.

## What is in here

The package is this repo: what is at the top is what is published. One
dependency, zod.

The dashboard is [`chloejs-ui`](https://www.npmjs.com/package/chloejs-ui), a
package of its own so that a box which only runs jobs installs zod and nothing
else. Without it the runtime still has a site, plain HTML it writes itself, and
everything carries on.

```
index.ts     what "chloejs" is when you import it: every name an agent is
             written with, and nothing else
server.ts    the server, and the only thing that is run. Names no agent
model/       asking a model: the two ways of reaching one, the last few
             messages, how a question reaches a person, and tools/, which
             is the only thing a model can be handed
load/        what an agent and a job are, and reading them off disk
timer/       cron lines and every(), on their own: imports nothing else
             here, and is published as "chloejs/timer"
serve/       the one port. http.ts is every route as one list, each carrying
             the line that documents it, so GET /api is generated rather than
             written twice. login.ts and tokens.ts are who may call what,
             site.ts is the runtime's own plain site, page.ts finds a better
             one if a package offers it, files.ts and memory.ts are the two
             folders it reads and writes, and pass.ts lets a sandboxed frame
             read one
core/        the floor. steps.ts runs a job, turn.ts runs a prompt, and
             clock.ts starts each job when its cron line is due. Those three
             reach into load/, model/ and timer/; the rest imports nothing
             else here: paths, staying inside a folder, a small file an agent
             keeps, the database, frontmatter, words in a markdown file
scorers/     how a run is marked: what it did, and what it said
do/          the work itself, called straight from a job: running a command,
             sending mail, reading mail, one folder's files. Published from
             "chloejs"
channels/    the ways in, for an agent to bind in its own channels/
ops/         the tests, the evals, talking to an agent from the terminal,
             making the account, and install.sh, which installs the service.
             Run by a person, not by the service
test-agent/  the agent the tests load in this repo, with chloe.config.ts.
             Not published
```

Six entrances and no others: `chloejs`, `chloejs/tools` for a tool to hand a
model, `chloejs/channels/<name>` for a way in, `chloejs/scorers` for marking a
run, `chloejs/timer` for when a job runs, and `chloejs/test` for testing a job.

## A job is a workflow

A job is an async function, so branching and looping are `if` and `for`. Waiting
for a person is `ask`, and the process may restart while it waits: carrying on
means running the function again from the top, with every finished step handing
back what it returned last time.

One rule makes that safe: **work happens inside a step, and code outside a step
only decides.** A step is written down, so it never runs twice. A line outside
one runs again on every resume, so it must not send, write or spend.

```ts
const go = await work.ask("restart?", {
  question: `Restart ${down.join(", ")}?`,
  answer: z.boolean(),
  within: "2h",
  otherwise: false,
});
```

An answer from a person is matched against the schema, not read by a model. The
whole point of stopping to ask was to take the judgement out of the machine.

## Two halves, checked differently

```sh
npm run test          # the runtime and the jobs: does it do the thing
npm run evals <name>  # the prompts: did the model decide well
```

Jobs are code, so they are tested: a file named `<job>.test.ts` beside the job
runs its cases, and the runner finds it. Prompts can only be scored, so an eval
file says what every tool answers and what the agent should have done about it.
Nothing in a case runs for real, so an eval cannot restart a site or send an
email.

## Docs

[chloejs.org](https://chloejs.org). The reference pages there are read out of
this source on every push to `main`, so they cannot describe a version of the
code that does not exist.

MIT.
