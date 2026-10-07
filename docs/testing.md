---
title: Testing and evals
order: 9
summary: Code is tested, words are scored, and reaching for the wrong one wastes an afternoon.
---

```sh
npm run test          # the runtime and the jobs: does it do the thing
npm run evals <agent> # the prompts: did the model decide well
```

## Jobs are tested

A job is code, so it is tested rather than scored. A test file sits beside the
job it is about, named `<job>.test.ts`, and runs its cases as it loads. The runner
finds every one under your agents, so a new test is a file and nothing else.

```ts file=example/jobs/stuck-orders.test.ts
```

The suite runs jobs for real against an in-memory database and a stand-in gateway
on a loopback port, so it costs nothing and it either passes or it does not.
Moving a job down the ladder should grow this file and shrink the eval file.

## Prompts are scored

Words are the first thing to reach for when a prompt is wrong, and they are also
the easiest thing to make worse without noticing. An eval file is one job of one
agent's, with a case per situation: what every tool answers, and what the agent
should and should not have done about it. Run it before and after you rewrite
instructions or a skill.

Nothing in a case runs for real. A tool the case does not answer is refused, not
run, so an eval cannot ship an order or send an email. If you add a tool to an
agent, its cases start failing until the file answers that tool, which is the
point.

A case is answered strictly: a mock matches on the exact arguments, so a case
that answers a tool with `{}` fails the moment the agent asks for one item by id.
Mark an answer `anyArgs` when the arguments do not change it, and `times` when
one answer covers several calls.
