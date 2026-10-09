---
title: Run an AI agent on a schedule
order: 14
summary: Give a job a cron line and it runs on its own, in your timezone, with every run written down and no two runs overlapping.
---

A scheduled agent is a job with a `cron` line. `npx chloe` keeps every cron line
of every agent, so there is no separate scheduler to set up.

## A job on a timer

`every` from `@chloejs/core/timer` writes the cron line in words, and
`timezone` is a real timezone name, so daylight saving is handled. Without one,
the line is read in UTC. This job checks the orders every two hours and asks no
model, so it costs nothing:

```ts file=example/jobs/stuck-orders.ts#default
```

This one sorts the inbox every 15 minutes with one model call per run, however
many messages came in:

```ts file=example/jobs/sort-messages.ts#default
```

## A prompt on a timer

A job can be only words. This one runs every Sunday evening and decides for
itself whether there is anything to say:

```ts file=example/jobs/how-it-went.ts
```

## What a schedule promises

- **No overlap.** A second run of the same job is skipped, not queued.
- **No silent mistakes.** A cron line that cannot run evenly, like every 7
  minutes, is refused when the file loads, with the reason.
- **No lost waits.** A job waiting on a person survives a restart.
- **A record.** Every run writes down each step and what it cost.

Every form `every` takes is in [A job is a workflow](/docs/jobs#when-it-runs).

## Keep it running

Nothing fires unless `npx chloe` is running. `npx chloe install` makes it a
service, a systemd user unit on Linux or a launchd agent on a Mac, so it keeps
going after you close the terminal and after a reboot.
