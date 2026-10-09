---
title: Connections
order: 6.5
summary: Signing in to Google, sending mail through Resend, which address each kind of mail comes from, a service's MCP server, and an account chloe does not ship.
---

A connection is an outside account that tools work through. A tool says which
one it needs, so an agent that names `gmailReadEmail` gets the Google sign-in
with it. The agent's Connections page in the dashboard, and the lines printed
when chloe starts, say what each connection is still missing.

| Connection | For | What you set |
|---|---|---|
| [Google](#google) | Gmail, Calendar and Drive tools, and the email channel on Gmail | a Google app of your own, the account, and one sign-in |
| [Resend](#resend) | sending mail from your own domain, and chloe's alerts | an API key |
| [An MCP server](#mcp-servers) | a service's own tools, like GitHub's | its address and key, on one agent |

## Google

One sign-in covers Gmail, Calendar and Drive. Reading Gmail is in Google's
strictest tier, so every copy of chloe signs in with a Google app of its own.
You make it once, in about ten minutes:

1. At console.cloud.google.com, make a project. Under APIs and Services, then
   Library, switch on the **Gmail API**, the **Google Calendar API** and the
   **Google Drive API**.
2. In the Google Auth Platform section, give the app a name and your own email
   as the contact, and choose **External**.
3. Under Audience, press **Publish app** so it is In production. Left in
   Testing, Google ends the sign-in every 7 days. Google warns once, when you
   approve, that it has not checked the app: it is yours, so go past it.
4. Under Clients, create an OAuth client of the **Web application** type, and
   add these redirect addresses exactly as written:
   - `https://chloejs.org/connected`, the page that shows you a code to send
     back;
   - `http://127.0.0.1:33067/oauth2/callback`, the fallback.
5. Download the client file. Put its path, or its contents, in `.env` as
   `CHLOE_CONNECTIONS_GOOGLE_CLIENT`, and name the account in the config:

```ts
settings: {
  connections: {
    google: { account: "you@gmail.com", client: process.env.CHLOE_CONNECTIONS_GOOGLE_CLIENT },
  },
}
```

Then sign in, from either place:

- **A chat.** Ask the agent for your mail. chloe sees nobody has signed in and
  sends a link. Approve it, and send back the short code the page you land on
  shows. chloe finishes the sign-in and answers what you asked.
- **The dashboard.** The agent's Connections page has a sign-in button, and a
  box for the code.

The model never sees the link or the code. The sign-in is saved as one file in
the state folder, mode 600.

| Setting | Default | What it controls |
|---|---|---|
| `connections.google.account` | none | The account that signs in. The mail tools read it, and the email channel on Gmail sends from it. |
| `connections.google.client` | none | The client file from step 5: its path or its contents. A secret, so it comes from `.env`. |
| `connections.google.callback` | `https://chloejs.org/connected` | Where Google sends you after you approve. Set it to `https://dashboard.chloejs.org/oauth/google/callback/<workspace>`, register that too, and turn on `dashboard.remote.allow.google`, and the sign-in finishes with no code to send. |

**What the sign-in may do.** Read and send mail, never delete it. Read
calendar events and add them. Read files. If you untick one on Google's
page, chloe says what it cannot reach.

### The Google tools

Each one is bound in `agent.ts`. The binding is what it may see, and the model
chooses only how far back, how many, or what to look for.

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

| Tool | Bound to | Default | The model may |
|---|---|---|---|
| `gmail.readEmail` | `search`, a Gmail query | `in:inbox`, the whole inbox | List that mail, 7 days back unless it asks for more, and read one message it listed. |
| `gmail.replyEmail` | the same `search` | | Answer a message it listed, to whoever sent it, in the same thread. It never picks the address. |
| `gmail.sendEmail` | `from`, `to`, `when` | | Write the subject and body. See [sending an email](/docs/tools#sending-an-email). |
| `calendar.listEvents` | `calendars`, by id | `["primary"]` | List the events from a day it picks, up to 90 days ahead. |
| `calendar.addEvent` | `calendar` | `"primary"` | Add one event. It invites nobody. |
| `drive.searchFiles` | `search`, a Drive query | every file the account can open | Find files in it, by words or newest first. |
| `drive.readFile` | the same `search` | | Read a file the search listed, as text: a Doc, Sheet, Slides or text file. |

The read tools take `what` too: that mail, calendar or folder in plain words,
for the model. A job does the same work without a model through
`@chloejs/core/services`: `readEmailMessages`, `sendGmail`,
`listCalendarEvents`, `addCalendarEvent`, `searchDriveFiles` and
`readDriveFile`.

## Resend

Resend sends mail from an address on a domain you own and have verified with
Resend. Put the key in `.env` as `CHLOE_CONNECTIONS_RESEND_API_KEY`, and in the
config as
`connections: { resend: { api_key: process.env.CHLOE_CONNECTIONS_RESEND_API_KEY } }`.
Then bind `resend.sendEmail()` from `@chloejs/core/tools/resend`.

| Setting | Default | What it controls |
|---|---|---|
| `connections.resend.api_key` | none | The key. Without one, nothing is sent. |
| `connections.resend.alerts` | on | Mail you when somebody signs in from an address this copy has not seen, when one is locked out for guessing, and when a job starts failing or works again. |
| `connections.resend.email_to` | none | Where alerts go, one address or several split by commas. |
| `connections.resend.email_from` | none | The alerts' From line, like `"Chloe <info@example.com>"`. |

## Which address mail comes from

| What sends it | From | Where that is set |
|---|---|---|
| The [email channel](/docs/channels#email) on Gmail | the agent's label and `connections.google.account` | settings |
| The email channel through a remote dashboard | `reply-<id>@` the dashboard's mail domain | nothing to set |
| `gmail.replyEmail` | the signed-in Google account | settings |
| `gmail.sendEmail` | its `from`: the signed-in account or an alias Google verified | `agent.ts` |
| `resend.sendEmail` | its `from`, on a domain verified with Resend | `agent.ts` |
| `deliverEmail()` in a job | the `from` the job gives it, carried by `email.provider`: `"resend"`, `"gmail"`, or `"none"` to log it and send nothing | the job, and settings |
| chloe's own alerts | `connections.resend.email_from`, always through Resend | settings |

## MCP servers

Many services publish tools for models as an MCP server, reached over HTTP.
List one in an agent's `connections`, and only that agent gets its tools.

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

| Option | Default | What it controls |
|---|---|---|
| `name` | required | The first word of every tool it brings: `github` and `list_issues` make `githubListIssues`. |
| `url` | required | The server's address, from the service's docs. |
| `token` | none | Sent as a bearer key. A function works too, to fetch one when it is needed. |
| `headers` | none | For a server that wants something other than a bearer key. |
| `tools` | all of them | Only these, by the server's own names. |
| `does` | none | One line for the Connections page. |

The tools are fetched as the agent loads. A server that does not answer leaves
the agent loading without them, and the Connections page says why. A
connection reaches whatever its key reaches, so keep mail, notes and files on
chloe's own tools, which are bound to what one agent may see.

## A connection of your own

An account chloe does not ship is a folder in the agent's own folder: its
services, its tools, and a `Connection`. Nothing in the runtime changes.

```ts file=connections/connection.ts#Connection
```

`missing()` is what the Connections page and the startup lines show, and an
empty list means ready. A connection on a plain key has no `signIn`. One that
has it gives `start()` for the words and the link, `answers()` to recognise the
reply, and `finish()`, and its service throws `NeedsSignIn` when signing in
would fix what failed. A tool that works through it says so with `needs`:
`Object.assign(tool({ ... }), { needs: crm })`. `Connection`, `SignIn` and
`NeedsSignIn` are exported from `@chloejs/core`.
