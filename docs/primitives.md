---
title: Step, model, agent
order: 2
summary: The three kinds of step a job is made of, which one to use, and the options and limits of each.
---

Use plain code wherever you can, and give a model room only where a step needs
judgement. A job says which it is doing, step by step:

| | Use it when | What the model decides |
|---|---|---|
| `work.step()` | you know what to do | nothing |
| `work.model()` | you know what to ask | the answer to one question, in a shape you set |
| `work.agent()` | you know only what you want | the order of the work, inside the tools and limits you set |

Reach down that list, not up it. Each one down costs more, takes longer, and can
answer differently tomorrow. Before adding a model step, say in one sentence
what judgement it makes: if the sentence is a rule, write the rule.

## work.step: you know what to do

A query, a request, a calculation, a file, an email. Plain TypeScript, written
down once so a resumed run does not do it twice.

```ts file=example/jobs/stuck-orders.ts#default
```

Paid for, not shipped, past the promised date: that is a rule, so it is code,
and nothing in the job can spend money or answer differently tomorrow.

## work.model: you know what to ask

Code gathers the facts, one step asks the model, and code decides what to do
with the answer. Classifying, extracting, summarising, ranking, writing the
words.

```ts file=example/jobs/sort-messages.ts#default
```

| Option | Default | What it controls |
|---|---|---|
| `prompt` | required | The question, with the facts it needs. |
| `output` | required | The shape the answer must have: a zod schema, or an AI SDK output like `Output.choice({ options: ["billing", "sales"] })` or `Output.array({ element })`. `Output.text()` is refused. |
| `instructions` | none | What the model should know before the question. |
| `model` | the job's | A model for this one step. |

An answer that does not fit the shape is sent back to the model once, saying
what was wrong. If it still does not fit, the run fails. Free text never
reaches your next line of code.

## work.agent: you know only what you want

When what to look at next depends on what the last answer said, hand a model a
goal and some tools. It decides what to call and in what order; everything
else stays in your file.

```ts file=example/jobs/why-they-left.ts#default
```

| Option | Default | What it controls |
|---|---|---|
| `prompt` | required | What you want done, not how. |
| `tools` | required | Everything it may call. Nothing else is reachable from inside the step. |
| `output` | its words, as a string | The shape of its final answer, as for a model step. |
| `stopWhen` | 10 steps | When it must stop, as the AI SDK's: `isStepCount(8)`, `hasToolCall("done")`, or a list. |
| `budget` | none | Dollars it may spend. Checked between turns, so the turn that crosses it is paid for and nothing after. |
| `toolApproval` | every call allowed | Asked before each call, with the input the model wrote. Below. |
| `instructions` | none | What it should know before it starts. |
| `model` | the job's | A model for this one step. |

Reaching `stopWhen` or `budget` ends the step with an error saying which, not a
half answer. Every call it made, with its arguments, what came back and whether
it was allowed, is on the run, with the step's cost.

### Which calls may run

`toolApproval` is code, so it can check anything code can: that it is the
customer it was sent to look into, that the amount is under a hundred. Answer
`"approved"`, or `{ type: "denied", reason }`, and the model is told the reason
and carries on.

Give a function per tool, `{ ordersTheyPlaced: theirs }`, and each is handed
that tool's input with its type. One function for every tool,
`({ toolCall }) => ...`, sees the input as `unknown`, so write the check to
refuse a missing field: `amount < 100` refuses when there is no amount,
`!(amount > 100)` allows it. A tool's own `needsApproval` is asked after.

### When a person has to say yes

Answer `"user-approval"`, or mark the tool `needsApproval`, and the run stops
before that call:

```ts file=example/jobs/order-issues.ts#refund
```

The run's owner is asked on the channel they use, with what the agent wants to
do and the input it chose. A yes runs the call and the step carries on, without
asking the model again. A no, or no answer in two hours, refuses the call, and
the model is told. A run with nobody to ask refuses such a call, and so does a
chat, because a chat turn does not wait.

## Which one

1. I know the operations and the order: `step`.
2. I know the question and the shape of the answer: `model`.
3. I know the outcome and the tools, and nothing about the order: `agent`.

"Restart it if it is down" is a step. "Say what today looked like" is a model.
"Work out why this failed" is an agent. A whole job that is open ended from
end to end is a [prompt](/docs/prompts), and a job that stops for a person is
[asking a person](/docs/asking-a-person).
