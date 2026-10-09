---
title: WhatsApp
order: 6.03
under: channels
summary: Putting an agent on a WhatsApp number through Meta's own API, delivered through your web server, and every option.
---

Meta posts each message to a public address and has nothing chloe can fetch
from, so your own web server takes the delivery: it passes one path,
`/chloe/v1/<agent>/<name>`, on to chloe's port, and nothing else.

The number has to be registered with Meta, and cannot be one already in the
WhatsApp app.

1. At developers.facebook.com, make an app and add WhatsApp to it. It gives you
   a number to try with, its id, and a token that lasts a day. A permanent token
   comes from a system user with the `whatsapp_business_messaging` permission.
   The app secret is on the app's settings page.
2. Put the three in `.env` as `CHLOE_AGENTS_<ID>_WHATSAPP_PHONE_NUMBER_ID`,
   `CHLOE_AGENTS_<ID>_WHATSAPP_TOKEN` and `CHLOE_AGENTS_<ID>_WHATSAPP_APP_SECRET`,
   and in the config under `agents: { <id>: { whatsapp: { phone_number_id, token, app_secret } } }`,
   as the config on [Channels](/docs/channels) does.
3. Add the channel to the agent. The shop's hands every message to a job:

```ts file=example/channels/whatsapp.ts
```

4. Start chloe. It writes the route to the log, with the word Meta checks it
   with. On the app's WhatsApp page, register your web server's address for
   that route as the webhook, with that word, subscribed to `messages`.
5. Write to the number from your phone. With `allowFrom` set to `[]`, it
   answers with your number, which is what goes in it.

Besides the [options every channel takes](/docs/channels#options-they-share):

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | anybody | Numbers in full international form, like `"+447700900123"`. Unset, anybody may write, so pair that with a `job` or a short `tools` list. |
| `publicUrl` | none | Where your web server reaches the route, so the log prints the whole address. |
| `uploadPolicy` | pictures, PDFs and text, up to 10 MB | As on [Telegram](/docs/channels-telegram). |
| `credentials` | the three in settings | `{ phoneNumberId, token, appSecret, verifyToken }`. `verifyToken` is the word Meta checks the address with, made on start when unsaid. |

Every delivery carries Meta's signature, and chloe checks it against your app
secret, which never leaves your machine. So your web server cannot make up a
message, and a channel with no app secret refuses everything.

Two of WhatsApp's own rules: a message to somebody has to be within 24 hours of
the last one they sent, so a job asking somebody who has not written today is
refused; and there are no groups. A question with three answers or fewer
arrives as buttons.

