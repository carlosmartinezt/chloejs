---
title: Asking a person
order: 4
summary: A job stops, sends its question to whoever should answer it, and carries on when they do.
---

This is the part worth building the rest for.

`ask` parks the run, writes down where it stopped and what it asked, and sends
the question out to an address, which is `channel:who`. The question arrives
wherever that channel reaches, so usually on a phone, and the next message back
from that person is the answer.

**Nothing reads that message with a model.** An answer is understood against the
shape the ask named, and "yes" against `z.boolean()` is a yes. Anything that
does not fit is asked again in plain words rather than guessed at. The whole
point of stopping to ask was to take the judgement out of the machine, so do not
put a model back in there.

The process can restart while it waits. When the answer arrives the job runs
again from the top, every finished step hands back what it returned, and `ask`
returns the answer instead of parking.

Three rules:

- **An ask names who is being asked.** `who:` is an address, and without one it
  is the run's owner.
- **A run says who it was for.** One column, filled in from the first run.
- **A parked run expires.** A question nobody answers is a job that never
  finishes and a job nothing releases, so `within:` is how long it waits, two
  hours by default, and `otherwise:` is what to carry on with. Without an
  `otherwise` the job stops and says nobody answered. The clock sweeps for these
  on every tick.

While a job is waiting it does not start again. A second run would ask the same
question twice and act on whichever came back first.

## One that does it

The rules around the question are code, and only the question itself is the
person's. A run with nothing to ask about ends without asking.

```ts file=example/jobs/big-refunds.ts#default
```

A yes or no question arrives with two buttons on Telegram and Slack. Pressing one answers
the job and the buttons are taken away, so the same question cannot be answered
twice.
