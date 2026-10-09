---
title: Testing and evals
order: 9
summary: Code is tested, prompts are scored, and which to reach for.
---

| | Checks | Costs |
|---|---|---|
| A test | that a job's code does the thing | nothing: no model is asked |
| An eval | that a prompt led the model to decide well | a model call per case |

## Jobs are tested

A test sits beside its job, named `<job>.test.ts`, with cases from
`@chloejs/core/test`. Test the rules, which is the part that is code:

```ts file=example/jobs/stuck-orders.test.ts
```

`node agents/<id>/jobs/<job>.test.ts` runs one and prints each case. The more
of a job that moves from a model step into code, the more of it a test covers.

## Prompts are scored

```sh
npx chloe evals <agent>
```

An eval file in the agent's `evals/` folder is one job, with a case per
situation: what each tool answers, and what the agent should and should not have
done. Run it before and after you change instructions or a skill, because words
are the easiest thing to make worse without noticing.

Nothing in a case runs for real. A tool the case does not answer is refused, so
an eval cannot send an email or ship an order. Add a tool to the agent and its
cases fail until they answer it.

A tool's answer matches only the exact arguments it lists. Mark one
`"anyArgs": true` when the arguments do not change it, and give `"times"` when
one answer covers several calls.
