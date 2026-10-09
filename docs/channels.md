---
title: Channels
order: 6
summary: Putting an agent on Telegram, Slack, WhatsApp or email, in a chat box on your website, or opening it to another system over HTTP. What to set for each, and every option.
---

A channel is how people reach an agent, and how a job's question reaches a
person. An agent is on one because its `agent.ts` lists it in `channels`. Each
is imported from `@chloejs/core/channels`, and has a page of its own.

| Channel | Who may write | What it needs | Opens a port? |
|---|---|---|---|
| [Telegram](/docs/channels-telegram) | Telegram user ids in `allowFrom` | a bot token | no |
| [Slack](/docs/channels-slack) | Slack member ids in `allowFrom` | two app tokens | no |
| [WhatsApp](/docs/channels-whatsapp) | numbers in `allowFrom`, or anybody when unset | a number registered with Meta | a route your web server passes on |
| [Email](/docs/channels-email) | addresses in `allowFrom`, and only once the agent wrote first | the Google sign-in, or a mailbox of your own | no |
| [A web page](/docs/channels-web) | visitors to the sites in `origins` | a token on your site's server | a few routes your web server passes on |
| [HTTP](/docs/channels-http) | holders of a token | a token | no |

A channel's tokens are secrets, so they go in `.env`, and `chloe.config.ts`
hands them over under `agents` and the agent's id:

```ts file=example/chloe.config.ts
```

Saving the config or `.env` starts the channel, with no restart.

## Options they share

Telegram, Slack, WhatsApp and email take these. A web page and HTTP have their
own, on their pages.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody (anybody on WhatsApp; required on email) | Who may reach the agent, as the platform names them. While the list is empty, a private message is answered with the sender's id, which is what goes in it. On Telegram, Slack and WhatsApp, the first entry is who the agent's jobs ask when they name nobody. |
| `name` | the kind, like `"telegram"` | Only needed when an agent has two of one kind. It is the start of every address on the channel: `telegram:12345`. |
| `chatHistory` | `{ messages: 10 }` | How much of a conversation each turn is shown: the last `messages`, none older than `days`. Nothing is deleted. |
| `sendWhileWorking` | off | Sends what the model writes on its way to an answer, not only the answer. Not on email. |
| `tools` | every tool the agent has | The only tools a turn on this channel gets. See [below](#what-a-message-gets-tools-or-a-job). |
| `job` | none | A job every message goes to, instead of a turn. See [below](#what-a-message-gets-tools-or-a-job). |

## What a message gets: tools or a job

Without either option, a message is a turn with the agent and every tool it
has.

**`tools`** keeps a turn to the tools named, for when the person writing should
not reach the rest. Name each by the tool itself, so a typo is an error in your
editor, or by its name in the agent's `tools`. The agent's memory and skills
come with them, and for its owner the tools that read its own files and runs;
`selfWriteFile` only when named. On [a web page](/docs/channels-web), only what is named.

**`job`** sends every message to one job instead of a turn, so code goes first:
look up who wrote, read their orders, and decide whether a model is needed at
all. The job reads the message from `work.input`, where `userId` is the
sender's id on that channel, and what it returns is the reply:

```ts file=example/jobs/answer-whatsapp-customer.ts
```

- Name the job on the channel only, not in the agent's `jobs`. It must be code
  with `run` and no cron line. Only a message there starts it.
- One conversation runs it once at a time, and two conversations run it side by
  side.
- A job that asks with `work.ask` asks in that conversation, and the next
  message is the answer.
- A slash is only text there, except `/clear`.
- A run that fails tells the person only that something went wrong. The error
  is in the run.
- `work.state` is shared by every conversation: keep anything per person under
  `work.input.userId`.

An agent that should be a different agent for some people is a second agent,
with its own channel.

## Commands in a chat

A message starting with `/<job id>` runs that job, and the words after it fill
the job's `args`: see [A job is a workflow](/docs/jobs#starting-one-with-something).
Three commands work on every channel: `/clear` starts the conversation fresh,
and `/models` and `/model` pick the model, see [Models](/docs/models). Any other
slash message is an ordinary message.

## Writing one

A channel chloe does not ship is a file in the agent's `channels/` folder,
written with `defineChannel(kind, options, start)` from
`@chloejs/core/channels`. Its options extend `Shared`, so it takes the shared
options above, and `defineChannel` handles them. `start` does only the
platform: it listens, turns each message into an `Incoming`, calls
`receive(agent(), incoming, rulesOf({ ...options, bound }))`, and sends back the
text that returns.

`receive()` decides what happens to a message, the same for every channel, in
this order:

1. Nobody outside `allowFrom` is answered.
2. The answer to a sign-in goes to the connection that asked, and the answer to
   a job waiting on that chat goes to the job.
3. In a group, a message not meant for the agent is left alone.
4. `/<job id>` runs that job, and `/clear`, `/models` and `/model` are answered.
5. Anything else is a turn, or goes to the channel's `job`. A reply that reads
   `/<job id>` starts nothing, because the model may have read a page written
   to ask for it.

Hand `receive()` a `send` to allow `sendWhileWorking`, `calling` to be told as
each tool starts, and `writing` for the words as they are written. A reply can
carry `buttons`. `commands(agent)` is the list to show in the platform's own
command menu.
