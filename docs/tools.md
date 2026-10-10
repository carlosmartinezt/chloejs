---
title: Tools
order: 5.5
summary: What a tool is, the ones chloe ships and what each is bound to, and how to write your own.
---

A tool is something a model may call: a description, an input schema and one
function. An agent hands its tools over in `tools`, keyed by the name the model
sees, and a job's agent step hands over its own.

**What a tool can reach is fixed in your file, not chosen by the model.** Each
tool chloe ships is a function you call with a binding (the folder, the mail
search, the address to send to), and the model fills in only what its input
schema asks for. A search a model can write is a filter, and it widens the
moment a turn goes wrong. A binding it cannot write is a boundary.

## The tools that ship

Import a set as a whole and bind each tool you want:
`import * as fs from "@chloejs/core/tools/fs"`, then
`tools: { fsReadFile: fs.readFile({ root: "/srv/notes", what: "the shared notes" }) }`.

| Set | Tools | Bound to | The model chooses |
|---|---|---|---|
| `fs` | `listFiles`, `readFile`, `searchFiles`, `writeFile`, `editFile` | `root`, one folder, and `what`, its name in words. Writes take `commit: true` to commit each one. | A path inside that folder. |
| `web` | `readPage()`, `search()` | nothing. A search goes to Brave Search when `connections.brave.api_key` is set, and to DuckDuckGo when it is not. See [Connections](/docs/connections#brave-search). | Which public page to read; what to search for. |
| `gmail` | `readEmail`, `replyEmail`, `sendEmail` | A Gmail search, or the From and To of what it sends. See [Connections](/docs/connections#the-google-tools). | How far back and how many; which listed message to answer. |
| `calendar` | `listEvents`, `addEvent` | Which calendars. | The dates, and what an event says. |
| `drive` | `searchFiles`, `readFile` | A Drive search, like one folder. | Words to look for; which listed file to read. |
| `resend` | `sendEmail` | The From and To. | The subject and the body. |
| `email` | `startConversation` | Which email channel. | Who, from the channel's `allowFrom`, and what to say. |

The memory, self and script tools are not imported: `features` on the agent
switches them on. See [Features](/docs/features).

### Sending an email

`gmail.sendEmail` and `resend.sendEmail` take the same options, and the model
writes only the subject and the body.

| Option | Default | What it controls |
|---|---|---|
| `from` | required | The From line, like `"Shop <orders@myshop.com>"`. Through Gmail, it must be the signed-in account or an alias Google verified for it. Through Resend, an address on a domain Resend sends for. |
| `to` | required | Who it goes to. The model cannot change it. |
| `when` | required | When to use it, in your words. Shown to the model. |
| `replyTo` | `from` | Where a reply goes. |
| `tag` | none | Put in front of every subject, `[tag]`, so an inbox can filter it. |
| `markdown` | off | Sends the body as HTML with a plain text copy. Off, plain text as written. |
| `keep` | none | A folder in its memory, like `"outbox"`, that gets a copy of each email sent. |

To mail somebody and read their reply, use the [email channel](/docs/channels-email)
instead.

## Your own tool

Made with the AI SDK's `tool()`, imported from `"ai"`. The work is a plain
function in the agent's `services/`, so a job can call it too, and the tool is
only how a model reaches it:

```ts file=example/tools/orderStatus.ts
```

What chloe reads on a tool:

| Field | What it does |
|---|---|
| `title` | Shown while the tool runs, on a channel that shows progress: "Looking up the order". |
| `needsApproval` | The AI SDK's. In a job's agent step the run waits for a person's yes; in a turn the call is refused. |
| `needs` | The connection it works through, like Google. The dashboard says what that connection is missing, and chloe starts the sign-in when the tool finds nobody signed in. |
| `overview` | A function giving a few lines about what the tool reaches now (the folders, the tables), put at the top of every turn that has the tool. |
| `own` | `true` when the tool works only on the agent's own folder, memory or skills. Unmarked, a tool counts as reading from outside, and after it answers the agent cannot change itself in that reply. |
| `forOwner` | `true` when only the agent's owner may use it, like reading the agent's own runs. It is in a turn only when the owner wrote it, never in a job. |
| `changesAgent` | `true` when the tool changes the agent itself. It is in a turn only when the agent's owner asked, and never in a job. |

`needs`, `overview`, `own`, `forOwner` and `changesAgent` are not AI SDK fields, so add them after:
`Object.assign(tool({ ... }), { needs: crm })`.

A tool's second argument holds `context`. `agentOf(context)` is the agent it
runs for, and in a turn `context.user` is who sent the message, as
`<channel>:<id>` (`telegram:12345`, `web:<visitor>`). The runtime sets both;
the model never does.

## What happens when one fails

A missing tool, bad arguments, or a tool that throws goes back to the model as
text, and the turn carries on. So a run that worked may still hold failures:
read its steps, not only its reply.

A job never imports a tool. It calls the plain function from a step, and a job
that imports a tool fails `npm run test`.
