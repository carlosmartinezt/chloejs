---
title: The entrances
order: 12
summary: What the package publishes, and where to import each thing from.
---

These entrances and no others:

```ts
import { defineAgent, defineJob, defineConfig } from "@chloejs/core";
import { deliverEmail, readEmailMessages } from "@chloejs/core/services"; // the work, for a job
import * as gmail from "@chloejs/core/tools/gmail";                     // a tool to bind
import { telegramChannel } from "@chloejs/core/channels";               // a channel to bind
import { mcpConnection } from "@chloejs/core/connections";              // a service's MCP server
import { calls, expectations } from "@chloejs/core/scorers";            // marking a run
import { every } from "@chloejs/core/timer";                            // when a job runs
import { about, is } from "@chloejs/core/test";                         // testing a job
```

Each set of tools is its own entrance: `@chloejs/core/tools/gmail`, `/calendar`,
`/drive`, `/resend`, `/email`, `/web` and `/fs`. Import one whole,
`import * as gmail`, and each function is a verb and a noun: `gmail.readEmail()`.
The name the model sees is the key you give it, by convention the two together:
`{ gmailReadEmail: gmail.readEmail({ ... }) }`. A job does the same work
through `@chloejs/core/services`, whose functions are named for the work, like
`deliverEmail()`, so a job and a model never reach for the same name.

A tool of your own is made with the AI SDK's `tool()`, from `"ai"`.

Never import a file inside the package by its path: it breaks the day a folder
moves. What is not on these lists may change without notice. The
[reference](/reference) is generated from them, so it is exactly what is
published.
