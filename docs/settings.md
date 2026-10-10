---
title: Settings and secrets
order: 8
summary: What goes in chloe.config.ts, what goes in .env, and a map of every setting.
---

Two places, and which one a value goes in is the only question:

| What | Where |
|---|---|
| A choice about how chloe behaves, an address, a path, a name | `settings` in `chloe.config.ts`, in source control |
| A password, key or token | `.env` beside it, mode 600, never committed |

```ts
import { defineConfig } from "@chloejs/core";

import shop from "./agents/shop/agent.ts";

export default defineConfig({
  agents: [shop],
  settings: {
    model: { defaultModel: "anthropic/claude-sonnet-5", key: process.env.CHLOE_MODEL_KEY },
    connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } },
    agents: { shop: { telegram: process.env.CHLOE_AGENTS_SHOP_TELEGRAM } },
  },
});
```

```
CHLOE_MODEL_KEY=...
CHLOE_CONNECTIONS_RESEND_API_KEY=re_...
CHLOE_AGENTS_SHOP_TELEGRAM=123456:ABC...
```

**chloe reads nothing from the environment by itself.** A secret reaches it
only where the config names it, as `process.env.` and its name, so reading the
config shows every key there is. A setting the config leaves out is its
default, and so is one handed a variable nothing set. Any other value can be
kept out of the file the same way.

The secrets are `model.key`, `model.keys`, `connections.resend.api_key`,
`connections.brave.api_key`, `connections.google.client`, and everything under `agents`. Their names in `.env` are `CHLOE_` and the path in capitals, and a
message saying a key is missing gives both the name and the config line.

## Every setting

| Section | What it controls | More |
|---|---|---|
| `model` | Which model an agent asks, how a call reaches it, the keys. | [Models](/docs/models) |
| `email.provider` | What carries mail a job sends with `deliverEmail()`: `"resend"` (the default), `"gmail"`, or `"none"` to log it and send nothing. | [Connections](/docs/connections#which-address-mail-comes-from) |
| `connections.google` | The Google account and the app it signs in with. | [Connections](/docs/connections#google) |
| `connections.resend` | The Resend key, and chloe's alert mail. | [Connections](/docs/connections#resend) |
| `connections.brave` | The Brave Search key `web.search` uses. Without one it searches DuckDuckGo. | [Connections](/docs/connections#brave-search) |
| `agents.<id>` | Each agent's channel tokens, under the `id` in its `agent.ts`. | [Channels](/docs/channels) |
| `serve` | Where the port listens: `127.0.0.1:3067`. Change takes a restart. | [The site](/docs/the-page) |
| `owner` | Who a run the clock started belongs to, as `channel:who`. | [Asking a person](/docs/asking-a-person) |
| `node` | Which node `npx chloe install` runs. Empty is whichever is on the path. | |

Every setting with its default is in [the settings reference](/reference/settings),
and your editor shows each one's explanation as you type it.

A line in `.env` can also be set from the dashboard, in the Keys box on the
Settings page: paste `CHLOE_SOMETHING=value` and it replaces that name's line.
It lists the names `.env` sets and never shows a value. Only `CHLOE_` names are
written, less `CHLOE_STATE`, `CHLOE_MEMORY` and `CHLOE_DB`, and an agent sends
its owner there, at `/settings?key=<name>`, rather than ask for a key in a chat.

An edit to the config or `.env` is live without a restart, except `serve`.
Renaming an agent means renaming its entry under `agents`; until then chloe says
which entry names no agent.

## Where things are kept

Not a setting, because it is read before the config: `CHLOE_STATE` (the state
folder, `data/` beside the config), `CHLOE_MEMORY` (the agents' memories,
`data/memory`) and `CHLOE_DB` (the run history), from the environment or
`.env`. A change takes a restart. See [The site](/docs/the-page#state).
