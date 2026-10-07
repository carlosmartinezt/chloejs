---
title: Channels
order: 6
summary: Putting an agent on Telegram, Slack or WhatsApp, in a chat box on your website, opening one to another system over HTTP, and writing a way in that chloe does not ship.
---

A channel is how an agent is reached, and how a job's question gets to a person.
An agent is on one because its own `agent.ts` says so.

## Telegram

1. In Telegram, message @BotFather, send `/newbot`, and pick a name and a
   username. It replies with a token. One bot per agent, unless each is given
   its own `name`.
2. Put it in `.env` as `CHLOE_AGENTS_<ID>_TELEGRAM`, and hand it over in
   `chloe.config.ts`'s settings as
   `agents: { <id>: { telegram: process.env.CHLOE_AGENTS_<ID>_TELEGRAM } }`.
   chloe reads no key the config does not name. Or pass
   `credentials: { botToken }` in the file below.
3. Write the agent's own `channels/telegram.ts` and list it in `agent.ts` as
   `channels: [telegram]`:

```ts file=example/channels/telegram.ts
```

4. Send the bot a private message. Saving the config or `.env` starts the
   bot, no restart needed. With nobody allowed yet it
   answers with your Telegram user id. Put that in `allowFrom`. An allowed person
   is answered in any chat, groups included, and nobody else is.

| Option | What it does |
|---|---|
| `allowFrom` | Telegram user ids that may reach the agent. The first is who its jobs ask when they name nobody. |
| `inGroups` | `"when-addressed"`, the default: in a group, only a command, a mention or a reply to the bot is answered. `"always"`: every message from someone in `allowFrom` is. |
| `chatHistory` | How much of a chat's conversation a turn is shown: `{ messages, days }`. |
| `sendWhileWorking` | Off unless `true`. Sends what the model writes on its way to an answer (a "let me check" line, or a draft it goes on to improve) as it writes it, not only the answer it ends on. |
| `name` | `"telegram"` unless the agent has two bots. What the log shows a run came in on, and the start of every address on this bot. |
| `mode` | `"polling"`, the default: chloe fetches messages and nothing of yours is exposed. `"webhook"`: Telegram posts them to `publicUrl` + `/chloe/v1/<agent>/<name>`, which then has to be exempt from whatever login is in front of the port, and checks its secret on every call. |
| `credentials` | The bot token, instead of the one in the settings. |

Do not add another path past a login without a secret and an allowlist of its
own.

## Slack

chloe opens a connection out to Slack (Slack calls this Socket Mode), so, like
Telegram's polling, nothing of yours is exposed and nothing needs a public
address.

1. At api.slack.com/apps, create an app and turn on Socket Mode. It makes the
   app token, `xapp-...`.
2. Under OAuth & Permissions, add the bot scopes `chat:write`, `im:history`,
   `channels:history`, `groups:history`, `mpim:history`, `users:read`,
   `files:read` and `reactions:write`. Under Event Subscriptions, subscribe the
   bot to `message.im`, `message.channels`, `message.groups` and
   `message.mpim`. Under App Home, allow messages from the Messages tab.
   Install the app to the workspace, which makes the bot token, `xoxb-...`.
3. Put both in `.env` as `CHLOE_AGENTS_<ID>_SLACK_BOT_TOKEN` and
   `CHLOE_AGENTS_<ID>_SLACK_APP_TOKEN`, and hand them over in the config as
   `agents: { <id>: { slack: { bot_token: process.env.CHLOE_AGENTS_<ID>_SLACK_BOT_TOKEN, app_token: process.env.CHLOE_AGENTS_<ID>_SLACK_APP_TOKEN } } }`.
   Or pass `credentials: { botToken, appToken }`.
4. In `agent.ts`, import `slackChannel` from `@chloejs/core/channels/slack` and list
   `slackChannel({ allowFrom: [] })` in `channels`, beside any other.
5. Send the app a direct message. With nobody allowed yet it
   answers with your member id, like `U0123ABCD`. Put that in `allowFrom`. In a
   channel, invite the bot first (`/invite @name`).

It takes the same `allowFrom`, `inGroups`, `chatHistory`, `sendWhileWorking`
and `name` as Telegram, with member ids in `allowFrom`. In a channel, "when
addressed" means a mention, or a reply in a thread the bot started. A message in
a thread is answered in that thread, and each thread is its own conversation.
While it works, the message gets an eyes mark, because Slack shows no
"typing..." for a bot.

Slack answers `/something` itself unless the app declares it, so a job runs
from a slash command only once it is added under Slash Commands in the app's
settings, named like the job with `_` for `-`. A plain message a skill hands
to a job needs nothing.

## WhatsApp

WhatsApp is the one channel chloe cannot call out to. Meta posts each message to
an address once and has nothing to fetch one with, so a machine with nothing open
can never be that address. chloe keeps a **post box** instead: a service that
takes the delivery and holds it, sealed, until the runtime asks. The runtime
collects over a connection it opens itself, the way Telegram is polled, so
nothing of yours is exposed and no name points at your machine.

The number it answers as is one registered with Meta, and it cannot be a number
that is already in the WhatsApp app.

1. At developers.facebook.com, make an app and add WhatsApp to it. It gives you
   a number to try with, its id, and a token. That token lasts a day: a
   permanent one comes from a system user with the
   `whatsapp_business_messaging` permission. The app secret is on the app's
   settings page.
2. Put all three in `.env` as `CHLOE_AGENTS_<ID>_WHATSAPP_PHONE_NUMBER_ID`,
   `CHLOE_AGENTS_<ID>_WHATSAPP_TOKEN` and
   `CHLOE_AGENTS_<ID>_WHATSAPP_APP_SECRET`, and hand them over in the config
   under `agents: { <id>: { whatsapp: { phone_number_id, token, app_secret } } }`,
   each as `process.env.` and its name, the way
   [this site's own config](/docs/start) does.
3. Write the agent's own `channels/whatsapp.ts` and list it in `agent.ts` as
   `channels: [whatsapp]`:

```ts file=example/channels/whatsapp.ts
```

4. Start chloe. It asks for a post box once and writes that address to the log.
   Paste it into the app's WhatsApp page as the webhook, subscribed to
   `messages`. The page shows the same address on the agent's channel row.
5. Write to the number from your phone. With nobody allowed yet it answers with
   your own number. Put that in `allowFrom`.

| Option | What it does |
|---|---|
| `allowFrom` | Numbers that may reach the agent, in full international form. The first is who its jobs ask when they name nobody. |
| `postBox` | Where a box is asked for. `dashboard.remote.url` in settings unless this says otherwise, and asking needs no account. `""` collects from nowhere, which leaves only the route below. |
| `chatHistory` | How much of a conversation a turn is shown: `{ messages, days }`. |
| `sendWhileWorking` | Off unless `true`. Sends what the model writes on its way to an answer as it writes it. |
| `uploadPolicy` | Which files are taken, and how big. Anything else is named to the agent but not handed over. |
| `name` | `"whatsapp"` unless the agent is on two numbers. What the log shows a run came in on, and the start of every address on this number. |
| `credentials` | The three, instead of the ones in the settings. |
| `publicUrl` | Only for an address of your own, below. |

**Nothing has to be trusted with your messages.** Meta's signature travels with
each delivery and is checked here against your app secret, which never leaves
your machine, so a post box cannot make up a message chloe will believe. Each
body is sealed to a key the runtime made, so a post box cannot read one either.
It keeps nothing: a message is deleted the moment the runtime has it, and swept
after ten minutes whatever happens.

**Two of WhatsApp's own rules worth knowing.** A reply has to be within 24 hours
of the last message that person sent, so a job that stops to ask somebody who has
not written today is refused by WhatsApp and told why. And there are no groups:
the API carries one-to-one messages and nothing else, so there is no `inGroups`
here. A question with three answers or fewer arrives as buttons, which is the one
thing this channel does better than the others.

**An address of your own, if you would rather.** With `postBox: ""` the channel
answers `publicUrl` + `/chloe/v1/<agent>/<name>` on the one port, and you point
Meta straight at it. It checks the app secret on every message and answers Meta's
one verification call, and a channel with no app secret refuses everything rather
than trusting the address. It is yours to choose and it is never the only way:
nothing in chloe needs a port open.

## HTTP

For a system rather than a person: one POST, one turn, one reply.

1. Write the agent's own `channels/api.ts` and list it in `agent.ts` as
   `channels: [api]`:

```ts file=example/channels/api.ts
```

2. Restart, then make a token with `npx chloe tokens make <name>`, or at
   `/tokens` on the runtime site. The secret is shown once and is not stored.

3. The agent answers two routes for anything holding that token:

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

`thread` is optional and is the caller's own name for a conversation: send the
same one again and the agent remembers what was said. Leave it out and the turn
starts fresh. A token's threads are kept apart from the ones a person started,
so two callers naming the same one do not land in each other's.

**This channel listens to nothing.** The server answers those two routes either
way; what binding it does is give a token permission to reach that agent. An
agent without it is not on the API, and a token asking for it gets a 403 saying
so. Somebody signed in on the box can still talk to it from the site, because
that is the account and the account can do everything.

**Why a channel and not a flag.** A channel is the list an agent's definition
already keeps to say how it can be reached, and being reachable by another
system belongs in that list beside telegram. Reading the definition tells you
every way in, in one place.

It does not carry a job's question out to anybody, because HTTP cannot push. A
job that stops to ask waits in `GET /api/parked` as it always did.

## A web page

For the people who visit your site: a chat box on its pages, talking to the
same agent that runs your jobs, with the same instructions, the same model and
the same run record. Nothing reaches it unless your site's own server lets it
in.

1. Write the agent's own `channels/web.ts` and list it in `agent.ts`. It names
   the sites that may show the box and the tools a visitor's turn gets:

```ts file=example/channels/web.ts
```

2. Make a token for that agent alone. It reaches that agent and nothing else,
   and it lives on your site's server, never in a page. It is printed once:

```sh
npx chloe tokens make "shop site" --agent shop
```

   The tokens page on the dashboard makes the same kind ("Only shop"). A token
   made either way works at once, with chloe running or not.

3. Give your site one route that hands its page a pass, and put the box on the
   page, pointed at that route. This is the whole of a site that does both, in
   plain Node: a signed-in customer is their customer id, from the shop's own
   sign-in and nowhere else, anybody else gets a random id in a cookie, and it
   asks the agent for a pass with the token and hands the answer on. Who the
   visitor is decides what the agent's tools show them, so it never comes from
   anything the visitor could write.

```ts file=example/site/server.ts
```

   `facts` are whatever the agent should know about them: their name when your
   site signs people in, their plan, anything. In any other framework it is the
   same one route: `POST /api/agents/<id>/web/pass` with the token, and
   `{ "visitor": "...", "facts": {...} }`, answered with the pass, when it runs
   out and the agent's greeting.

   To try it on one machine, set both addresses in it to
   `http://127.0.0.1:3067`, add `http://localhost:8080` to the channel's
   `origins`, start chloe with `npx chloe`, and open http://localhost:8080.

A button appears in the corner. A visitor types, sees "Looking up the order"
while the agent works (a tool's `title`), then the answer arriving word by
word. They come back tomorrow and the conversation is still there. The box draws
itself in a shadow root, so the site's styles cannot break it, and follows
`--chloe-accent`, `--chloe-font` and `--chloe-radius` if the page sets them.
`data-title`, `data-note`, `data-position="left"` and `data-open` change the
rest.

**Reaching the runtime.** It listens on loopback, and stays there. Two ways in,
and the box is the same either way:

- **Your own proxy**, whatever already serves the site, gives the agent an
  address of its own, here agent.myshop.com, and passes the web routes and
  nothing else. Any name will do, and so will a path on the site's own address,
  like myshop.com/chat-agent/, with the proxy taking it off. With Caddy:

```
agent.myshop.com {
    @web path_regexp ^/api/(agents/shop/web/(turn|history|clear)|web/(chat|client)\.js)$
    handle @web {
        reverse_proxy 127.0.0.1:3067 { flush_interval -1 }
    }
    respond 404
}
```

  `flush_interval -1` passes the answer through as it is written. The pass
  route is not in it: your site's server reaches the runtime directly. The
  page, the API and the memories stay out of reach. The page on myshop.com may
  call agent.myshop.com because myshop.com is in the channel's `origins`.

- **Through the dashboard**, for a machine nobody can reach from outside. Load
  the box from `https://dashboard.chloejs.org/w/<workspace>/api/web/chat.js`, and have
  your site's server ask for passes at the same address with its token. It
  answers the web routes of agents with a web channel and nothing else, and
  keeps none of what passes through.

**Who they are.** Each message reaches the model with what is known about the
visitor, in `<web_context>`: their id, the site, when they first came, how many
messages before this one, their country and browser, and your site's facts.
The runtime keeps their address too, for you, and never shows it to the model.
`GET /api/agents/<id>/web/visitors` lists them all.

With `features: { memoryPerUser: true }`, the agent keeps a note on each
visitor, `users/web-<id>.md` in its memory, written with `memoryWriteUserNotes`
and shown at the top of that visitor's next turns. Which file is the runtime's
choice, from the pass, never the model's. The same feature keeps a note per
person on every other channel too.

**A visitor is a stranger**, so a web turn gets almost nothing:

- Only the tools the channel names, and its note on them. Naming the agent's memory or
  self tools stops the agent loading, saying why.
- No `/command` but `/clear`, no `/model`, and never a sign-in: a slash is only
  text, and a tool that needs somebody to sign in fails rather than sending a
  visitor a link.
- What visitors may spend, over the last 24 hours, read off the run record: 30
  messages and $0.50 per visitor, and $5 for everybody, unless `limits` says
  otherwise. A turn past one is refused politely. Six messages a minute per
  visitor, and 4,000 characters each.

Whatever a visitor writes is untrusted, like a web page a tool read. The short
list of tools is what keeps that survivable, not the instructions.

**A pass is only what it says**: one agent, one site, one visitor, for an hour,
and the box asks your route again when it runs out. Passes are signed with
`web-pass.key` in the state folder; delete it and restart, and every pass there
is stops working.

**Your own look.** The box is built on a client with no look of its own, served
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

A turn answers as Server-Sent Events, one response that sends lines as they
happen: `text` as words are written, `step` as a tool starts, `said` for words
written on the way, then `done` with the answer whole. On a model reached with
a key the words come as they are written; on a subscription the answer comes
whole at the end.

**What you see.** Each visitor's conversation is in the agent's chat list,
named for who and which site and marked web, and each turn is a run with its
steps and its cost. The channel's line on the agent's page says how many
visitors, messages and dollars the last day came to. A job asks a visitor with
`web:<visitor>`, and the question waits in their conversation for the next time
the box loads it.

## Running a job from a chat

A message beginning with `/<job id>` runs that job of that agent, and nothing
asks a model what was meant:

```
/reading-companion "The fox jumped over the lazy dog." -- The Fox
```

The job is handed the message with the command taken off, plus where it came
from. What that envelope holds and how a job declares what it takes is in
[jobs](/docs/jobs). Telegram's own command list allows no hyphens, so
`/reading_companion` reaches `reading-companion` too and can be registered with
BotFather.

Three commands are the agent's own on every channel: `/clear` starts the
conversation fresh, and `/models` and `/model` pick which model answers, see
[models](/docs/models). Any other slash message that is not one of that
agent's jobs is an ordinary message and goes to the model as usual, so `/start`
and `/help` still behave.

## Writing one

A channel is a file in the agent's own `channels/` folder, exporting a `Channel`
as its default: a `name` and a `start`. One chloe ships is bound there, and one
it does not is written right there, without editing anything in the runtime.
`channels` in `agent.ts` is a list, and two channels of one agent cannot share
a name.

A channel only reads its platform and sends to it. What happens to a message is
the same for every channel and is not the channel's to decide: it turns the
message into an `Incoming` (who sent it, where, the text, whether it is a
private chat, whether it mentions the agent) and calls `receive()` from
`@chloejs/core/channels/shared`, which returns the text to send back. In order,
`receive()`:

1. Answers nobody outside `allowFrom`, and while that is empty tells a private
   sender their id.
2. Hands an answer to a job waiting on that chat to the job.
3. Leaves a group message alone unless it is for the agent, or `inGroups` is
   `"always"`.
4. Runs `/<job id>`, with `_` for `-`, and answers `/clear`, `/models` and
   `/model` itself.
5. Otherwise asks the agent, showing it the chat's recent conversation, and
   sends its reply. A reply that reads `/<job id>` starts nothing: the agent
   may have read a page or a mail written to ask for it. A job starts on its
   schedule or from a command a person sent. A skill is how the agent handles
   a plain message itself.

A channel that can send more than one reply hands `receive()` a `send`, which
is what `sendWhileWorking` uses; the API cannot, so it always gets the answer
alone. One that shows what the agent is doing hands it `calling`, told as each
tool starts, and `writing`, handed the words as they are written. A channel
for strangers says `strangers: true` in its rules, and `receive()` then takes
a message as a turn, `/clear` or an answer to a job that asked them, and
nothing else.

`commands(agent)` from the same file is the list a channel offers in its own
menu, the way Telegram shows one when you type `/`: the jobs, then `/models`.
A reply can carry `buttons`, each with a label and what pressing it sends, and
a channel that can show them does; Telegram makes them an inline keyboard.

How much of a conversation is shown is the channel's `chatHistory`: the last
`messages` (10 when unsaid) and none older than `days` (no limit when unsaid),
like `telegramChannel({ chatHistory: { messages: 20, days: 30 } })` or
`apiChannel({ chatHistory: { messages: 4 } })`. It is a channel's setting and
not an agent's, because only a conversation has a history: a job is shown what
its code hands it. A job's reply in a chat is kept in that chat's conversation too.

**A channel says its own name, and nothing else may say it for it.** A job's
question goes out to an address, `channel:who`, and the runtime looks the channel
half up in a registry that each running channel fills for its own agent. So an
agent's question goes out through its own bot, and the runtime reaches somebody
without knowing how.
