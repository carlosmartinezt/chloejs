---
title: Run an AI agent on a schedule
order: 14
summary: Give a job a cron line and it runs on its own, in your timezone, with every run written down and no two runs overlapping.
---

A scheduled AI agent is a job with a `cron` line. `npx chloe` keeps every cron
line of every agent, so there is no separate scheduler, queue or cron table to
set up.

## A job on a timer

`every` from `@chloejs/core/timer` writes the cron line in words, and
`timezone` is a real timezone name, so daylight saving is handled for you. This
one checks the orders every two hours and never asks a model, so it costs
nothing to run:

```ts file=example/jobs/stuck-orders.ts#default
```

The same works for a job with a model in it. This one sorts the inbox every 15
minutes, and one model call sorts everything that came in, so the price is per
run and not per message:

```ts file=example/jobs/sort-messages.ts#default
```

## A prompt on a timer

A job can also be only a prompt, with the words in a markdown file beside it.
This one runs every Sunday evening and decides for itself whether there is
anything to say:

```ts file=example/jobs/how-it-went.ts
```

## What a schedule promises

- **No overlap.** A second run of the same job is skipped rather than queued,
  so a job that takes longer than its interval runs less often, never twice at
  once.
- **No silent mistakes.** A cron line that cannot be said evenly, like every 7
  minutes, is refused when the file loads, with the reason.
- **No lost waits.** A job waiting on a person survives a restart and carries
  on from where it stopped.
- **A record.** Every run, scheduled or not, writes down each step and what it
  cost.

Every form `every` takes is in [A job is a workflow](/docs/jobs#when-a-job-runs).
A job without a cron line runs only when somebody starts it: from the page, a
chat, the API or `npx chloe agent <agent> <job>`.

## Keep it running

`npx chloe` has to be running for anything to fire. `npx chloe install` makes it
a service and starts it, a systemd user unit on Linux and a launchd agent on a
Mac, so it keeps going after you close the terminal and after a reboot.

Next: [build an AI agent in TypeScript](/docs/build-an-ai-agent), or see
[the examples](/examples), each on its own schedule.
