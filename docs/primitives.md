---
title: Step, model, agent
order: 2
summary: Three primitives, in the order to reach for them, and the test for which one you are writing.
---

Use deterministic code wherever you can. Give autonomy to a model only where the
task genuinely needs judgement, interpretation, or a sequence nobody can write
down in advance.

That is the whole idea, and the three primitives are how a job says which one it
is doing.

| | | |
| --- | --- | --- |
| `work.step()` | I know what to do. | You control the workflow and the action. |
| `work.model()` | I know what to ask. | You control the workflow. The model answers one question. |
| `work.agent()` | I know what I want. | You control the boundaries. The model picks the order inside them. |

Reach down that list, not up it. Every rung costs more money, takes longer, and
can come back different tomorrow than it did today.

## work.step, when you know what to do

A query, a request, a calculation, a file, an email, a command. Ordinary
TypeScript, written down once so a resumed run does not do it twice.

```ts file=example/jobs/stuck-orders.ts#default
```

Paid for, not shipped, past the date the customer was given: that is a rule, and
a rule is code. Nothing in that job can spend anything or answer differently
tomorrow. Most jobs should look like this, and most of them do not yet.

## work.model, when you know what to ask

Code gathers the facts, one named step hands them over with a zod schema for
what must come back, and code decides what to do with the answer. Classifying,
extracting, summarising, ranking, turning a mess into a shape, writing the
words: all of it is this.

```ts file=example/jobs/sort-messages.ts#default
```

What a customer means by what they wrote is a judgement, so it is asked. Which
desk deals with it is a rule, so it stays a lookup table underneath. Two things
make it safe to have a model in the middle of a workflow: the answer is
validated against the schema, so free text never reaches the next line of code,
and the step is named in the file, so the run record can price it.

A shape that is not an object is an AI SDK output instead of a schema, as
`generateText` takes it: `Output.choice({ options: ["billing", "sales"] })`
answers with one of those words, `Output.array({ element })` with a list.
`Output.text()` is refused, because a model step answers in a shape.

**Before adding one, say in a sentence what judgement it is making.** If the
sentence turns out to be a rule, write the rule.

## work.agent, when you know only what you want

Sometimes the order of the work cannot be known in advance: what to look at next
depends on what the last answer said. That is the case for an agent step, and it
is the only case for one.

```ts file=example/jobs/why-they-left.ts#default
```

You give the prompt and the tools, in the words the AI SDK's `generateText`
uses for them. The model decides what to call and in what
order, and the runtime runs it: ask, run what it asked for, put the answer back,
ask again, until it is done.

The autonomy is over the order, and over nothing else. Four limits stay in the
file, and every one of them is named there rather than assumed:

- **`tools` is what it may do at all.** Nothing outside the list that step was
  handed is reachable from inside it.
- **`toolApproval` is which of those calls may run.** It is the AI SDK's: asked
  before each call, with the input the model wrote, and answering `"approved"`,
  or `{ type: "denied", reason }` with a sentence saying why not. A tool's own
  `needsApproval` is asked after it. A refused call never runs: the model is
  told why and carries on.
- **`stopWhen` and `budget` are how far it may go**, in steps and in dollars.
  `stopWhen` is the AI SDK's, `isStepCount(8)` or `hasToolCall("done")`, and
  ten steps when it says nothing; `budget` is chloe's. Reaching either ends the
  step with an error that says which, rather than a quiet half answer. The money is counted between turns, so the turn that
  crosses the line is paid for and nothing after it is.
- **`output` is the shape of what comes back.** Validated like any model step,
  so free text never reaches the next line of code.

The record is the other half of it. Every call it made, with its arguments, what
came back and whether it was allowed to run, is on the run, and the whole step
is priced. A tool answer longer than a few thousand characters is cut short
there, with its true length, so one line of a run cannot be a megabyte. A step that hit a limit is written down too, with what it spent and
what it called before it stopped, because that is the run somebody has to read.
An agent step is recorded like any other step, so a run that parks and resumes
does not live through it twice.

### The limits are code, not words in a prompt

`toolApproval` is code in your job, running while the step waits, so it can
decide anything code can decide: whether that is the customer it was sent to
look into, whether the amount is under a hundred, whether the path is inside the
folder this agent owns.

Give it a function per tool, `{ ordersTheyPlaced: theirs }`, and each one is
handed that tool's input with its type. One function for every tool,
`({ toolCall }) => ...`, sees the input as `unknown`, so write the condition to
refuse a missing field rather than to allow it: `amount < 100` refuses when
there is no amount, `!(amount > 100)` allows.

### When a person has to say yes

Code cannot decide everything. A refund over a hundred dollars, an email to a
customer: some calls should wait for somebody. Answer `"user-approval"` for
them, or mark the tool `needsApproval`, as the AI SDK has it:

```ts file=example/jobs/order-issues.ts#refund
```

The run stops before that call, and its owner is asked about it, on the
channel they talk to the agent on: what the agent wants to do, with the input
the model chose, yes or no. Nothing else in the step waits on them while the
run is parked, and the job does not start again. A yes runs the call and the
step carries on from it, without asking the model again for what it had
already said. A no, or nobody answering in two hours, refuses the call, and
the model is told and carries on. It is still one line in the record, with
every call on it.

A run with nobody to ask refuses such a call. So does a chat, because a chat
turn does not stop and wait.

## The test

Ask which of these three sentences is true, and write that one.

1. I know the operations and the order. That is `step`.
2. I know the question and the shape of the answer. That is `model`.
3. I know the outcome, the tools, and nothing about the order. That is `agent`.

If you can write the rules down, it is code. "Restart it if it is down" is code.
"Say what today looked like" is a model. "Work out why this failed" is an agent.

## A fourth, for a person

A job can also stop and ask somebody, which is not autonomy at all: it is the
opposite. See [asking a person](/docs/asking-a-person).

## A whole job that is a prompt

Some work is open ended from end to end, and then the job itself is words rather
than code: see [a prompt with tools](/docs/prompts). The difference between that
and an agent step is scope. An agent step is a bounded piece of autonomy inside
a workflow you control. A prompt job hands over the whole run.
