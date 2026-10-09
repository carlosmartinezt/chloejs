---
title: Asking a person
order: 4
summary: A job stops, sends its question to whoever should answer it, and carries on when they do.
---

`work.ask` stops the run, sends a question to a person, and waits. Their next
message back is the answer. chloe can restart while it waits: when the answer
comes, the job runs again from the top, every finished step hands back what it
returned, and `ask` returns the answer.

```ts file=example/jobs/big-refunds.ts#default
```

The rules around the question are code, so a run with nothing to ask about ends
without asking.

| Option | Default | What it controls |
|---|---|---|
| `question` | required | What they are asked. |
| `answer` | required | A zod schema the answer must fit, like `z.boolean()`. |
| `who` | the run's owner | An address, `channel:who`. Below. |
| `within` | `"2h"` | How long to wait: `"30m"`, `"4h"`, `"2d"`. |
| `otherwise` | none | What to carry on with when nobody answers. Without it, the job stops and says nobody answered. |

**Who.** An address is the channel's name and the person's id on it:

| Address | Reaches |
|---|---|
| `telegram:12345` | a Telegram user id |
| `slack:U0123ABCD` | a Slack member id |
| `whatsapp:+447700900123` | a WhatsApp number, if they wrote in the last 24 hours |
| `email:someone@example.com` | a new email conversation, with someone in that channel's `allowFrom` |
| `web:<visitor>` | a visitor, next time the chat box loads |

The run's owner is whoever started it. For a run the clock started, it is
`owner` in settings, or else the first entry in `allowFrom` of the agent's
Telegram, Slack or WhatsApp channel.

**The answer is read by code, not a model.** "yes" against `z.boolean()` is a
yes. An answer that does not fit is asked again in plain words. A yes or no
question arrives with two buttons on Telegram and Slack, and up to three
choices arrive as buttons on WhatsApp. Pressing one answers and removes the
buttons, so nobody answers twice.

While a job waits it does not start again, so the same question is never asked
twice. Answering also works from the dashboard, or with
`POST /api/runs/<id>/answer` and `{"text":"yes"}`.
