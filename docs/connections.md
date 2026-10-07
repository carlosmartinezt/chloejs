---
title: Connections
order: 6.5
summary: Google and Resend ship with chloe, a service's MCP server is one line in an agent, and an account chloe does not ship is a file of your own.
---

A **connection** is an outside account a tool works through, like Google for
mail or Resend for sending. Google and Resend ship with chloe. A tool says which
one it needs, and the rest follows from that: the setup page and the lines
printed at startup say what each connection is still missing, and when a tool
finds nobody signed in, chloe runs the sign-in itself.

So an agent names `gmailReadEmail` and is done. It cannot have mail without the
means to sign in to mail.

## Google

One sign-in covers Gmail, Calendar and Drive. chloe talks to Google with plain
web requests, so there is nothing to install beside it.

Every copy of chloe signs in with a Google app of its own, made once:

1. At console.cloud.google.com, make a project, and switch on the Gmail API,
   the Google Calendar API and the Google Drive API.
2. In the Google Auth Platform section, give the app a name, choose External,
   and under Audience press Publish app so it is **In production**. Left in
   Testing, Google ends the sign-in every 7 days.
3. Make an OAuth client of the Web application type, and add the redirect
   addresses chloe lists for it, exactly as written.
4. Download the client file and hand it over as `connections.google.client`, a key like
   any other: its path or its contents in `.env` as `CHLOE_CONNECTIONS_GOOGLE_CLIENT`, and
   the config naming it, with the account beside it.

```ts
settings: {
  connections: {
    google: { account: "you@example.com", client: process.env.CHLOE_CONNECTIONS_GOOGLE_CLIENT },
  },
}
```

Then ask the agent for your mail. chloe sees that nobody has signed in and
sends a link, exactly as Google needs it; you approve, and send back the short
code the page you land on shows. chloe finishes the sign-in, checks that Google
allowed everything it asked for, and answers what you asked. The model never
sees the link or the code. The sign-in is one file in the state folder, mode
600.

### The Google tools

Each one is bound in the agent's own `agent.ts`. The binding says what the tool
may see, and the model chooses only how far back, how many, or what to look
for. A binding a model cannot write is a boundary; a query it can write is only
a filter.

```ts
import * as calendar from "@chloejs/core/tools/calendar";
import * as drive from "@chloejs/core/tools/drive";
import * as gmail from "@chloejs/core/tools/gmail";

const PLANS = "'1AbC...' in parents"; // one Drive folder, by its id

tools: {
  gmailReadEmail: gmail.readEmail({ search: "in:inbox label:orders", what: "the order mail" }),
  gmailReplyEmail: gmail.replyEmail({ search: "in:inbox label:orders", what: "the order mail" }),
  calendarListEvents: calendar.listEvents({ calendars: ["primary"] }),
  calendarAddEvent: calendar.addEvent({ calendar: "primary" }),
  driveSearchFiles: drive.searchFiles({ search: PLANS, what: "the plans folder" }),
  driveReadFile: drive.readFile({ search: PLANS, what: "the plans folder" }),
}
```

| Tool | Bound to | What the model may do |
|---|---|---|
| `gmailReadEmail` | `search`, a Gmail query. Unsaid it is the whole inbox. | List that mail, and read one message it listed. |
| `gmailReplyEmail` | the same `search` | Answer a message it already listed, at that message's own address. |
| `gmailSendEmail` | `from`, `to` and `when` | Send to the addresses it was given, as the signed-in account. |
| `calendarListEvents` | `calendars`, by id. Unsaid it is `primary`. | List the events from a day it picks, up to 90 days ahead. |
| `calendarAddEvent` | `calendar` | Add one event. It invites nobody, so nothing reaches anybody else. |
| `driveSearchFiles` | `search`, a Drive query. Unsaid it is every file the account can open. | Find files in it, by words or newest first. |
| `driveReadFile` | the same `search` | Read a file the search listed, as text: a Google Doc, Sheet or Slides, or a text file. |

A job reaches the same work without a model, from `@chloejs/core/services`:
`readEmailMessages`, `sendGmail`, `listCalendarEvents`, `addCalendarEvent`,
`searchDriveFiles` and `readDriveFile`.

## Resend

Resend sends mail on a key, from an address on a domain you own:
`connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }` in the config, the key
in `.env`, and `resend.sendEmail()` from `@chloejs/core/tools/resend` in the agent's tools. Without a key nothing is
sent and nothing fails.

## Connections: a service's MCP server

Many services publish their tools for models as an MCP server: a list of tools
reached over HTTP. An agent lists the ones it may use in `connections`, and only
that agent gets their tools.

```ts
import { mcpConnection } from "@chloejs/core/connections";

connections: [
  mcpConnection({
    name: "github",
    url: "https://api.githubcopilot.com/mcp/",
    token: process.env.GITHUB_TOKEN,
    tools: ["list_issues", "get_issue"],
  }),
],
```

The tools are asked for as the agent loads, and each is named like chloe's
own: `github` and `list_issues` make `githubListIssues`. `tools` keeps only the
ones named; without it the agent gets every tool the server has. A server that
does not answer leaves the agent loading without its tools, and the setup page
says why. `token` is sent as a bearer key, and may be a function that fetches
one when it is needed; `headers` is for a service that wants something else.

A connection reaches whatever its key reaches. Use one for a service where that
is what the agent should have. Mail, notes and files stay chloe's own tools,
bound to what one agent may see.

## A connection of your own

An account chloe does not ship is a folder in the agent's own folder: its
services, its tools, and a `Connection` saying what it needs. Nothing in the
runtime has to change.

```ts file=connections/connection.ts#Connection
```

`missing()` is what the setup page and the startup lines show, one line each,
and an empty list means ready. `signIn` is optional: a connection on a plain key
has none. One that has it gives chloe three functions, `start()` for the words
and the link, `answers()` to know the reply when it comes, and `finish()`, and
its service throws `NeedsSignIn` when signing in would fix what failed. chloe
does the rest, on every channel. A tool that works through it says so with
`needs`:

```ts
export function crmFindCustomer() {
  return Object.assign(tool({ description, inputSchema, execute }), { needs: crm });
}
```

`Connection`, `SignIn` and `NeedsSignIn` are exported from `@chloejs/core`.
