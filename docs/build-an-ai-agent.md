---
title: Build an AI agent in TypeScript
order: 13
summary: An AI agent in Chloe is a TypeScript file listing its jobs, tools and channels. Here is one, with a model asked only where it is needed.
---

An agent here is not one long prompt. It is a TypeScript file listing its
instructions, its jobs, the tools it may hand a model, and the chats it answers
on. Each job is an async function, and asking a model is one kind of step
inside it, used only where a step needs judgement.

## Install

```sh
npm install @chloejs/core
npx chloe setup
```

Setup asks a name and a model, writes the files and runs a first job. See
[Start](/docs/start).

## The agent

`agent.ts` is the whole list, and a job not on it does not run. Every option is
in [An agent](/docs/agents).

```ts file=example/agent.ts
```

## A job with a model in the middle

Code reads the inbox, one model step says what each message is about, in a
shape checked against a zod schema, and code decides which desk each goes to.

```ts file=example/jobs/sort-messages.ts#default
```

## When the model should choose the order

When what to look at next depends on the last answer, a job hands a model a
goal and some tools, and keeps the limits in the file: which tools, which calls
may run, how many turns and how many dollars.

```ts file=example/jobs/why-they-left.ts#default
```

Which of the two to write is in [Step, model, agent](/docs/primitives). A job
can also stop and wait for a person to decide: see
[Asking a person](/docs/asking-a-person).

## Run it

```sh
npx chloe                           # the agents, their cron lines and their chats
npx chloe agent shop                # talk to it
npx chloe agent shop sort-messages  # run one job now
```

Every run records each step, what it returned and what it cost, so you can see
which line asked a model and what that came to.

Next: [run it on a schedule](/docs/schedules), put it on
[Telegram, Slack, WhatsApp or email](/docs/channels), or read
[the examples](/examples).
