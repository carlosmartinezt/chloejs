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
| `answer` | required | A zod schema the answer must fit, like `z.boolean()`, `z.enum(["small", "large"])`, or `z.array(z.enum([...]))` for any number of them. |
| `who` | the run's owner | An address, `channel:who`. Below. |
| `within` | `"2h"` | How long to wait: `"30m"`, `"4h"`, `"2d"`. |
| `otherwise` | none | What to carry on with when nobody answers. Without it, the job stops and says nobody answered. |

**Who.** An address is the channel's name and the person's id on it:

| Address | Reaches |
|---|---|
| `telegram:12345` | a Telegram user id |
| `slack:U0123ABCD` | a Slack member id |
| `discord:123456789012345678` | a Discord user id, in a direct message |
| `whatsapp:+447700900123` | a WhatsApp number, if they wrote in the last 24 hours |
| `email:someone@example.com` | a new email conversation, with someone in that channel's `allowFrom` |
| `web:<visitor>` | a visitor, next time the chat box loads |

The run's owner is whoever started it. For a run the clock started, it is
`owner` in settings, or else the first entry in `allowFrom` of the agent's
Telegram, Slack, Discord or WhatsApp channel.

**The answer is read by code, not a model.** "yes" against `z.boolean()` is a
yes, and a choice may be written in any case or as its number in the list, with
commas between several ("cheese, 3"). An answer that does not fit is asked
again in plain words. The question goes with a line saying what fits, like
"(small, large)", so a channel with no buttons still says it.

| Channel | One of a list (8 at most) | Several of a list |
|---|---|---|
| Telegram | a button each | a box each to tick, then Send |
| Slack | a button each | a box each to tick, then Send |
| Discord | a button each | a menu that takes several |
| WhatsApp | a button each, up to three | typed, with commas between |
| the dashboard, the chat box | a button each | a button each to press, then Send |
| email | typed | typed, with commas between |

Pressing one answers and removes the buttons, so nobody answers twice.

While a job waits it does not start again, so the same question is never asked
twice. Answering also works from the dashboard, or with
`POST /api/runs/<id>/answer` and `{"text":"yes"}`; `GET /api/parked` lists the
questions waiting, each with its `options` and `multiple` when it has them.

## From a chat

In a conversation the model can do the same with `chatAsk`: a question and 2
to 8 answers, and whether several may be picked. The question ends its reply,
shown the same way as above, and what they pick is their next message, which the
model reads. Nothing waits in between, so it suits a conversation, and a job
that has to act on the answer uses `work.ask`. Every turn in a conversation has
it, a visitor's on a web page too, and a job's run has nobody to ask, so none
does.

Over HTTP, a chat reply that asks carries `buttons`, each `{ label, sends }`,
and `multiple` when several may be picked; sending a button's `sends` is
answering. Several go as one message with commas between, or as a JSON list
when one of them holds a comma.
