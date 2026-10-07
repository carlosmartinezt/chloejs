---
title: The entrances
order: 12
summary: What the package publishes, and why the list is short on purpose.
---

The runtime is a package, and you import it the way you import anything else.
These entrances and no others:

```ts
import { defineJob, note } from "@chloejs/core";
import { run, deliverEmail } from "@chloejs/core/services";             // the work, for a job
import * as gmail from "@chloejs/core/tools/gmail";                  // a tool to bind
import { telegramChannel } from "@chloejs/core/channels";            // a channel to bind
import { mcpConnection } from "@chloejs/core/connections";           // a service's MCP server
import { calls, expectations } from "@chloejs/core/scorers";         // marking a run
import { every } from "@chloejs/core/timer";                         // when a job runs
import { about, is } from "@chloejs/core/test";                      // testing a job
```

A tool of your own is made with the AI SDK's `tool()`, imported from `"ai"`,
and handed over keyed by the name the model calls it by: `{ getOrders: tool({ ... }) }`.

Each set of tools is an entrance of its own: `@chloejs/core/tools/gmail`,
`/calendar`, `/drive`, `/resend`, `/email`, `/web` and `/fs`. Import one as a
whole, `import * as gmail`, and its functions are the verb and the noun:
`gmail.readEmail()`, `resend.sendEmail()`, `web.readPage()`. Importing one set
loads none of the others, and two services can each have a `sendEmail`. The
name the model sees is the key you give it, by convention the two together:
`{ gmailReadEmail: gmail.readEmail({ ... }) }`. A service is named for the
work, `deliverEmail()`, so a job and a model never reach for the same name.

The other entrances are each one index file, `index.ts` for the first and an
`index.ts` in its folder for the rest, and those files are the lists and
nothing else. A tool entrance is the tools' own file.
**Adding a name to one is publishing it, and taking one away is a break**,
so anything not on them is the runtime's own business and may move without
telling anyone. The [reference](/reference) is generated from those files, so it
is exactly what is published and nothing more.

Reaching any of it by path is the thing not to do: it breaks the day a folder
moves. Inside your own agent's folder, a sibling is still `./units.ts`, because
that file belongs to that agent and is nobody else's.

`@chloejs/core/timer` imports nothing else in the runtime, so it can be read on its own.
