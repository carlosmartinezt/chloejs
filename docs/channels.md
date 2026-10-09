---
title: Channels
order: 6
summary: Putting an agent on Telegram, Slack, WhatsApp or email, in a chat box on your website, or opening it to another system over HTTP. What to set for each, and every option.
---

A channel is how people reach an agent, and how a job's question reaches a
person. An agent is on one because its `agent.ts` lists it in `channels`. Each
is imported from `@chloejs/core/channels`.

| Channel | Who may write | What it needs | Opens a port? |
|---|---|---|---|
| [Telegram](#telegram) | Telegram user ids in `allowFrom` | a bot token | no |
| [Slack](#slack) | Slack member ids in `allowFrom` | two app tokens | no |
| [WhatsApp](#whatsapp) | numbers in `allowFrom`, or anybody when unset | a number registered with Meta | a route your web server passes on, or a remote dashboard |
| [Email](#email) | addresses in `allowFrom`, and only once the agent wrote first | the Google sign-in, or a remote dashboard | no |
| [A web page](#a-web-page) | visitors to the sites in `origins` | a token on your site's server | a few routes your web server passes on |
| [HTTP](#http) | holders of a token | a token | no |

A channel's tokens are secrets, so they go in `.env`, and `chloe.config.ts`
hands them over under `agents` and the agent's id:

```ts file=example/chloe.config.ts
```

Saving the config or `.env` starts the channel, with no restart.

## Options they share

Telegram, Slack, WhatsApp and email take these. A web page and HTTP have their
own, in their sections.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody (anybody on WhatsApp; required on email) | Who may reach the agent, as the platform names them. While the list is empty, a private message is answered with the sender's id, which is what goes in it. On Telegram, Slack and WhatsApp, the first entry is who the agent's jobs ask when they name nobody. |
| `name` | the kind, like `"telegram"` | Only needed when an agent has two of one kind. It is the start of every address on the channel: `telegram:12345`. |
| `chatHistory` | `{ messages: 10 }` | How much of a conversation each turn is shown: the last `messages`, none older than `days`. Nothing is deleted. |
| `sendWhileWorking` | off | Sends what the model writes on its way to an answer, not only the answer. Not on email. |
| `tools` | every tool the agent has | The only tools a turn on this channel gets. See [below](#what-a-message-gets-tools-or-a-job). |
| `job` | none | A job every message goes to, instead of a turn. See [below](#what-a-message-gets-tools-or-a-job). |

## Telegram

1. In Telegram, message @BotFather, send `/newbot`, and pick a name. It replies
   with a token.
2. Put it in `.env` as `CHLOE_AGENTS_<ID>_TELEGRAM`, and in the config as
   `agents: { <id>: { telegram: process.env.CHLOE_AGENTS_<ID>_TELEGRAM } }`.
3. Add the channel to the agent:

```ts file=example/channels/telegram.ts
```

4. Message the bot. It answers with your Telegram user id. Put that in
   `allowFrom` and save. An allowed person is answered in any chat, groups
   included.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody | Telegram user ids, as numbers. |
| `inGroups` | `"when-addressed"` | In a group, answer only a command, a mention or a reply to the bot. `"always"` answers every message from someone in `allowFrom`. |
| `stackWithin` | `1` | Seconds to wait for a second message in the same chat, so two sent together are read as one. `0` reads each on its own. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | Which files are handed to the agent: `{ allowedMediaTypes, maxBytes }`. Anything else is named to it, not handed over. |
| `mode` | `"polling"` | `"polling"`: chloe asks Telegram for messages, and nothing is exposed. `"webhook"`: Telegram posts them to `publicUrl` + `/chloe/v1/<agent>/<name>`, which has to get past any login in front of the port. |
| `publicUrl` | none | Where this server is reached from outside, for `"webhook"`. |
| `credentials` | the token in settings | `{ botToken, webhookSecretToken }`, to give them here instead. Without a secret, `"webhook"` makes a new one each start. |

Telegram's command list allows no hyphens, so `/stuck_orders` runs
`stuck-orders`, and can be registered with BotFather.

## Slack

chloe connects out to Slack (Slack calls this Socket Mode), so nothing needs a
public address.

1. At api.slack.com/apps, create an app and turn on Socket Mode. That makes the
   app token, `xapp-...`.
2. Under OAuth & Permissions, add the bot scopes `chat:write`, `im:history`,
   `channels:history`, `groups:history`, `mpim:history`, `users:read`,
   `files:read` and `reactions:write`. Under Event Subscriptions, subscribe to
   `message.im`, `message.channels`, `message.groups` and `message.mpim`. Under
   App Home, allow messages from the Messages tab. Install the app to the
   workspace, which makes the bot token, `xoxb-...`.
3. Put both in `.env` as `CHLOE_AGENTS_<ID>_SLACK_BOT_TOKEN` and
   `CHLOE_AGENTS_<ID>_SLACK_APP_TOKEN`, and in the config as
   `agents: { <id>: { slack: { bot_token: process.env.CHLOE_AGENTS_<ID>_SLACK_BOT_TOKEN, app_token: process.env.CHLOE_AGENTS_<ID>_SLACK_APP_TOKEN } } }`.
4. Add `slackChannel({ allowFrom: [] })` to the agent's `channels`.
5. Send the app a direct message. It answers with your member id, like
   `U0123ABCD`. Put that in `allowFrom`. In a Slack channel, invite the bot
   first with `/invite @name`.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody | Slack member ids. |
| `inGroups` | `"when-addressed"` | In a Slack channel, answer only a mention or a reply in a thread the bot started. `"always"` answers every message from someone in `allowFrom`. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | As for Telegram. |
| `credentials` | the tokens in settings | `{ botToken, appToken }`. |

A message in a thread is answered in that thread, and each thread is its own
conversation. While the agent works, the message gets an eyes mark. Slack
answers `/something` itself unless the app declares it, so a job runs from a
slash command only once it is added under Slash Commands, named like the job
with `_` for `-`.

## WhatsApp

Meta posts each message to a public address and has nothing chloe can fetch
from, so something public has to take the delivery. You choose what:

- **Your own web server**, which passes one path, `/chloe/v1/<agent>/<name>`,
  on to chloe's port. This is what happens with no remote dashboard.
- **A remote dashboard's post box.** With `dashboard.remote.api_key` set, the
  dashboard takes the delivery and holds it, sealed, until chloe collects it
  over a connection it opens itself. Nothing on your machine is open.

The number has to be registered with Meta, and cannot be one already in the
WhatsApp app.

1. At developers.facebook.com, make an app and add WhatsApp to it. It gives you
   a number to try with, its id, and a token that lasts a day. A permanent token
   comes from a system user with the `whatsapp_business_messaging` permission.
   The app secret is on the app's settings page.
2. Put the three in `.env` as `CHLOE_AGENTS_<ID>_WHATSAPP_PHONE_NUMBER_ID`,
   `CHLOE_AGENTS_<ID>_WHATSAPP_TOKEN` and `CHLOE_AGENTS_<ID>_WHATSAPP_APP_SECRET`,
   and in the config under `agents: { <id>: { whatsapp: { phone_number_id, token, app_secret } } }`,
   as the config at the top of this page does.
3. Add the channel to the agent. The shop's hands every message to a job:

```ts file=example/channels/whatsapp.ts
```

4. Start chloe. It writes the address to register to the log, and the dashboard
   shows it on the agent's channel. Paste it into the app's WhatsApp page as
   the webhook, subscribed to `messages`.
5. Write to the number from your phone. With `allowFrom` set to `[]`, it
   answers with your number, which is what goes in it.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | anybody | Numbers in full international form, like `"+447700900123"`. Unset, anybody may write, so pair that with a `job` or a short `tools` list. |
| `postBox` | the remote dashboard, when one is connected | Where messages are collected from. `""` collects from nowhere, which leaves only your own route. |
| `publicUrl` | none | Where your web server reaches the route, so the log prints the whole address. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | As for Telegram. |
| `credentials` | the three in settings | `{ phoneNumberId, token, appSecret, verifyToken }`. `verifyToken` is the word Meta checks the address with, made on start when unsaid. |

Every delivery carries Meta's signature, and chloe checks it against your app
secret, which never leaves your machine. So neither your web server nor a post
box can make up a message, and a channel with no app secret refuses everything.
A post box cannot read a message either: each is sealed to a key chloe made,
and deleted the moment chloe has it.

Two of WhatsApp's own rules: a message to somebody has to be within 24 hours of
the last one they sent, so a job asking somebody who has not written today is
refused; and there are no groups. A question with three answers or fewer
arrives as buttons.

## Email

The agent writes to a person from an address made for that conversation, and
their replies come back to it as messages. It is for conversations. To send one
email with no reply, use a [sending tool](/docs/tools#sending-an-email).

The agent always writes first, and only to somebody in `allowFrom`. A
conversation starts in one of three ways:

- a job asks with `work.ask("...", { who: "email:someone@example.com", ... })`;
- the agent calls the `email.startConversation` tool, from a chat;
- code calls `openEmail(agentId, to, subject, text)`.

### Which address it sends from

There are two mailboxes. Pick one with `mailbox`:

| | `mailbox: "gmail"` | no `mailbox` |
|---|---|---|
| The mail goes through | your Gmail or Google Workspace account | a remote dashboard |
| From | the agent's `label`, then the account in `connections.google.account`: `Shop <you@gmail.com>` | the agent's `label`, then `reply-<id>@` the dashboard's mail domain |
| Replies go to | the account with a tag, `you+k7mp2xqa@gmail.com`, set as Reply-To. Gmail delivers it to the same inbox. | the same address it was sent from |
| How chloe receives | asks Gmail what is new every 15 seconds | collects from the dashboard's post box |
| What chloe reads | only mail to one of its tagged addresses | only mail to its addresses |
| What you set | the Google connection, below | `dashboard.remote.api_key` |

With Google Workspace, the From address is on your own domain.

### Setting it up on Gmail

1. Make the Google app once, with the Gmail API on, as in
   [Connections](/docs/connections#google).
2. In `chloe.config.ts`, say which account sends, and hand over the app's client
   file:
   `connections: { google: { account: "you@gmail.com", client: process.env.CHLOE_CONNECTIONS_GOOGLE_CLIENT } }`.
3. Add the channel: `emailChannel({ mailbox: "gmail", allowFrom: ["someone@example.com"] })`.
4. Sign in. The agent's Connections page in the dashboard lists Google with a
   sign-in button. Approve reading and sending mail: chloe asks for
   `gmail.readonly` and `gmail.send`, and never deletes anything.
5. So the agent can start a conversation from a chat, give it the tool:
   `emailStartConversation: email.startConversation({ when: "..." })`, from
   `@chloejs/core/tools/email`.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | required | The addresses it may write to and hear from. Nobody else is ever sent anything. |
| `mailbox` | none | `"gmail"`, or unset to go through a remote dashboard. |
| `name` | `"email"` | Only when an agent has two. The first half of `email:<address>`. |

### Which replies it takes

A reply is answered only when every one of these holds. Anything else is
dropped, with a line in the log saying why.

- It is to an address this channel made, still open. An address closes after
  30 days with nothing sent or received on it.
- It has one From address, the person the address was made for, and they are
  in `allowFrom`.
- It carries a DKIM signature from that person's own mail domain. The From line
  alone can be written by anybody, so this is the check that counts.

Only what the person wrote this time is read, not the quoted history below it.
Attachments are named to the agent, not handed over.

## HTTP

For another system rather than a person: one POST, one turn, one reply.

1. Add the channel to the agent:

```ts file=example/channels/api.ts
```

2. Make a token, with `npx chloe tokens make <name>` or on the dashboard's
   tokens page. The secret is shown once and not stored.
3. Call the agent:

```sh
curl -X POST http://127.0.0.1:3067/api/agents/shop/chat \
  -H "authorization: Bearer $CHLOE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"how many orders are late?"}'

{"runId":"...","text":"Three are late.","steps":2,"cost":0.0031}
```

```sh
curl -X POST http://127.0.0.1:3067/api/agents/shop/job/restock \
  -H "authorization: Bearer $CHLOE_TOKEN"

{"started":"shop/restock"}
```

Send `thread`, a name of your own, to carry on a conversation; leave it out to
start fresh. Without this channel a token gets a 403 for that agent, and only
somebody signed in on the dashboard can reach it. It takes `chatHistory` and
nothing else. A job that stops to ask somebody waits in `GET /api/parked`,
because HTTP cannot push a question out.

## A web page

A chat box on your own site, talking to the same agent, with the same model and
run record. A visitor is a stranger, so they get only what you name.

1. Add the channel to the agent. It names the sites that may show the box and
   the tools a visitor's turn gets:

```ts file=example/channels/web.ts
```

2. Make a token for that agent alone. It lives on your site's server, never in
   a page, and is printed once:

```sh
npx chloe tokens make "shop site" --agent shop
```

3. Give your site one route that hands its page a pass, and put the box on the
   page. This is a whole site that does both, in plain Node. Who the visitor is
   (here, a signed-in customer's id) comes from your site's own sign-in, never
   from anything the visitor can write, because it decides what the agent's
   tools show them:

```ts file=example/site/server.ts
```

   In any framework it is the same route: `POST /api/agents/<id>/web/pass`
   with the token and `{ "visitor": "...", "facts": {...} }`. `facts` is
   whatever the agent should know about them: their name, their plan.

   To try it on one machine, set both addresses in it to
   `http://127.0.0.1:3067`, add `http://localhost:8080` to `origins`, run
   `npx chloe`, and open http://localhost:8080.

| Option | Default | What it controls |
|---|---|---|
| `origins` | required | The sites that may show the box, like `"https://myshop.com"`. |
| `tools` | none | The only tools a visitor's turn has. No memory, skills or self tools unless named, and naming the memory or self tools is refused. |
| `job` | none | A job every visitor's message goes to, instead of a turn. |
| `greeting` | none | What the box shows before anybody has written. |
| `limits` | 30 messages and $0.50 per visitor, $5 for everybody, per 24 hours | `{ perVisitor: { messages, dollars }, perDay: { dollars } }`. A turn past one is refused politely. |
| `model` | the agent's | The model visitors' turns use. |
| `pictures` | off | Whether a visitor may send pictures. |
| `chatHistory` | `{ messages: 10 }` | As on every channel. |

Besides `limits`, a visitor may send six messages a minute, of up to 4,000
characters each. A visitor never gets a `/command` but `/clear`, a model pick
or a sign-in.

**Reaching chloe.** It stays on loopback. Your own web server gives it an
address, here agent.myshop.com, and passes the box's routes and nothing else.
With Caddy:

```
agent.myshop.com {
    @web path_regexp ^/api/(agents/shop/web/(turn|history|clear)|web/(chat|client)\.js)$
    handle @web {
        reverse_proxy 127.0.0.1:3067 { flush_interval -1 }
    }
    respond 404
}
```

The pass route is not in it: your site's server reaches chloe directly.

**The box.** It sits in a corner, shows a tool's `title` while the agent works,
and writes the answer as it arrives. It keeps the conversation for the next
visit. Set `--chloe-accent`, `--chloe-font` and `--chloe-radius` on the page to
match your site, and `data-title`, `data-note`, `data-position="left"` and
`data-open` on the tag. For a look of your own, build on the client served
beside it:

```js
import { chloeChat } from "https://agent.myshop.com/api/web/client.js";

const chat = chloeChat({
  url: "https://agent.myshop.com",
  agent: "shop",
  pass: () => fetch("/api/chat-pass", { method: "POST" }).then((answer) => answer.json()),
});
const { messages } = await chat.history();
const { text } = await chat.send("Where is my order?", {
  onText: (soFar) => show(soFar),
  onStep: ({ text }) => status(text),
});
```

**What the agent knows about a visitor.** Each message reaches the model with
their id, the site, when they first came, how many messages before, their
country and browser, and your `facts`, never their IP address. With
`features: { memoryPerUser: true }` it keeps a note on each visitor.
`GET /api/agents/<id>/web/visitors` lists them.

**What you see.** Each visitor's conversation is in the agent's chat list,
marked web, and each turn is a run with its cost. A job asks a visitor with
`who: "web:<visitor>"`, and the question waits for the next time the box loads.

A pass is one agent, one site, one visitor, for an hour. Passes are signed with
`web-pass.key` in the state folder: delete it and restart, and every pass stops
working.

## What a message gets: tools or a job

Without either option, a message is a turn with the agent and every tool it
has.

**`tools`** keeps a turn to the tools named, for when the person writing should
not reach the rest. Name each by the tool itself, so a typo is an error in your
editor, or by its name in the agent's `tools`. The agent's memory and skills
come with them; its self tools only when named. On a web page, only what is
named.

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
