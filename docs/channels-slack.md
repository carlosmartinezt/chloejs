---
title: Slack
order: 6.02
under: channels
summary: Putting an agent on Slack, connected out with no public address: the two tokens, the scopes, and every option.
---

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

Besides the [options every channel takes](/docs/channels#options-they-share):

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody | Slack member ids. |
| `inGroups` | `"when-addressed"` | In a Slack channel, answer only a mention or a reply in a thread the bot started. `"always"` answers every message from someone in `allowFrom`. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | As on [Telegram](/docs/channels-telegram). |
| `credentials` | the tokens in settings | `{ botToken, appToken }`. |

A message in a thread is answered in that thread, and each thread is its own
conversation. While the agent works, the message gets an eyes mark. Slack
answers `/something` itself unless the app declares it, so a job runs from a
slash command only once it is added under Slash Commands, named like the job
with `_` for `-`.

