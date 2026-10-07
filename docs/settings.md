---
title: Settings and credentials
order: 8
summary: Two different things, kept apart, and two places where each one belongs.
---

**A setting is a choice about how the runtime behaves**, so it goes in
`chloe.config.ts` beside the agents, where TypeScript checks it and source
control keeps it. Every default and its one line of explanation lives on the
`Settings` interface the code reads, so a setting cannot drift from the code,
your editor tells you what each one is as you write it, and a value that is not a
valid choice is refused at startup rather than quietly ignored. The
generated list of every one of them is [here](/reference/settings).

```ts
import { defineConfig } from "@chloejs/core";

import tempo from "./agents/tempo/agent.ts";

export default defineConfig({
  agents: [tempo],
  settings: {
    model: { defaultModel: "anthropic/claude-sonnet-5" },
    email: { provider: "resend" },
    dashboard: { remote: { allow: { memory: true } } },
  },
});
```

What it leaves out is the default, so there is nothing to write down twice.

**A secret goes in `.env`** beside that file, which is not in source control and
is mode 600: every password, key and token, and nothing else.

```
CHLOE_MODEL_KEY=...
CHLOE_CONNECTIONS_RESEND_API_KEY=re_...
CHLOE_AGENTS_TEMPO_TELEGRAM=123456:ABC...
```

**The config names each key**, so reading it shows every key there is and where
each comes from. chloe reads no setting from the environment by itself: it
reads the ones the config hands it.

```ts
settings: {
  model: { key: process.env.CHLOE_MODEL_KEY },
  connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } },
  agents: { tempo: { telegram: process.env.CHLOE_AGENTS_TEMPO_TELEGRAM } },
}
```

The keys are `model.key`, `connections.resend.api_key`, `connections.google.client`, `dashboard.remote.api_key`
and everything under `agents`. `npx chloe setup` writes the model's key in
`.env` and its `process.env` line in the config, and a message that says a key
is missing says both halves. A key handed over as `process.env.SOMETHING` that
nothing set counts as not said, so it is the default.

What belongs to one agent, like its bot's token, is under `agents` and that
agent's id, the one in its `agent.ts`. Renaming an agent means renaming its
entry, and until you do the server says which entry names no agent.

**Nothing else comes from the environment.** A setting is what the config says,
or its default. To keep any other value out of the file, hand it over the same
way, as `process.env` and a name. Two places, and the second beats the first:

```
the types         the default, and the documentation
chloe.config.ts   settings: { ... }, in source control
```

The server reads both again when either changes, so an edit is live without a
restart. Where the agents keep things is not a setting: `CHLOE_STATE`,
`CHLOE_MEMORY` and `CHLOE_DB` are read from the environment before the config
is, and are fixed while it runs.
