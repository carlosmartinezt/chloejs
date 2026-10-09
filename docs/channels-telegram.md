---
title: Telegram
order: 6.01
under: channels
summary: Putting an agent on Telegram: the bot token, who may write, groups, and every option.
---

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

Besides the [options every channel takes](/docs/channels#options-they-share):

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

