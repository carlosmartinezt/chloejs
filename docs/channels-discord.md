---
title: Discord
order: 6.025
under: channels
summary: Putting an agent on Discord, connected out with no public address: the bot, its token, the one switch it needs, and every option.
---

chloe connects out to Discord, so nothing needs a public address.

1. At discord.com/developers/applications, create an application. On its Bot
   page, reset the token and copy it, and turn on **Message Content Intent**.
   Without it Discord refuses the connection, and the log says so.
2. Under OAuth2, URL Generator, tick the scope `bot` and the permissions Send
   Messages, Read Message History and Attach Files. Open the address it makes
   to add the bot to a server.
3. Put the token in `.env` as `CHLOE_AGENTS_<ID>_DISCORD`, and in the config as
   `agents: { <id>: { discord: process.env.CHLOE_AGENTS_<ID>_DISCORD } }`.
4. Add `discord: discordChannel({ allowFrom: [] })` to the agent's `channels`,
   or switch Discord on from the dashboard's Channels page.
5. Send the bot a direct message. It answers with your user id, like
   `123456789012345678`. Put that in `allowFrom`, as a string.

Besides the [options every channel takes](/docs/channels#options-they-share):

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | nobody | Discord user ids, as strings. With Developer Mode on in Discord's settings, right-click a person and Copy User ID. |
| `inGroups` | `"when-addressed"` | In a server, answer only a `/command`, a mention of the bot, or a reply to it. `"always"` answers every message from someone in `allowFrom` in every channel the bot can read. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | As on [Telegram](/docs/channels-telegram). |
| `credentials` | the token in settings | `{ botToken }`. |

In a server the agent answers as a reply to the message. A Discord thread is a
channel of its own, so each thread is its own conversation. While the agent
works, the chat shows it typing. Nothing the agent writes pings anybody, even
`@everyone`. A job runs from `/<job id>` typed as a message: the bot registers
no slash commands, so Discord's own `/` menu does not list them. A job's
question to `discord:<user id>` arrives in a direct message, with buttons when
the answers can be listed.

A message sent while the connection is down for a moment arrives when it comes
back. One sent while chloe is stopped does not.
