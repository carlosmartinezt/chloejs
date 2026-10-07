---
title: Build an AI agent in TypeScript
order: 13
summary: An AI agent in Chloe is a TypeScript file listing its jobs, tools and channels. Here is one, built from the ground up, with a model asked only where it is needed.
---

An AI agent here is not one long prompt. It is a TypeScript file that says what
the agent is: its instructions, the jobs it runs, the tools it may hand a model
and the chats it answers on. Each job is an ordinary async function, and a
model is one kind of step inside it, used where a step needs judgement and
nowhere else.

## Install

Node 22.18 or newer. There is no build step: Node runs the TypeScript as it is.

```sh
npm install @chloejs/core
npx chloe setup
```

`setup` asks a name and a model, writes the files and runs a first job, so the
first thing you see is a finished run. [Start](/docs/start) goes through what it
wrote.

## The agent

One file, `agent.ts`, and it is the whole list. A job that is not on it does not
run. This is the shop the examples on this site come from:

```ts file=example/agent.ts
```

## A job, with a model in the middle

Code reads the inbox, one model step works out what each message is about and
answers in a shape checked against a zod schema, and code decides which desk
each one goes to. Free text never reaches the next line of code.

```ts file=example/jobs/sort-messages.ts#default
```

Most jobs need less than this, and some need no model at all. The test for
which you are writing is in [Step, model, agent](/docs/primitives).

## When the model should choose the order

Sometimes what to look at next depends on what the last answer said. Then a
job hands a model a goal and some tools, and keeps the limits in the file:
which tools, which calls may run, how many turns and how many dollars.

```ts file=example/jobs/why-they-left.ts#default
```

## When a person has to decide

A job can stop, send its question to whoever should answer it, and carry on
when they do, hours or days later, after a restart. That is
[asking a person](/docs/asking-a-person).

## Run it

```sh
npx chloe                           # the agents, their cron lines and their chats
npx chloe agent shop                # talk to it
npx chloe agent shop sort-messages  # run one job now
```

Every run writes down each step, what it was handed, what it returned and what
it cost, so you can see which line asked a model and what that came to.

Next: [run it on a schedule](/docs/schedules), put it on
[Telegram or Slack](/docs/channels), or read [the examples](/examples).
