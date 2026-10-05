// What a model can be given, to the repo that installs chloe.
//
// Everything here is a tool: a wrapper that lets a model reach work it could
// not have been told the rule for. Each one is a function an agent calls with
// its own folder, its own mailbox, its own From line, and it returns one tool,
// which the agent names in its `tools`. Nothing here names an agent or a person.
//
//   import { gmailReadEmail, webReadPage } from "@chloejs/core/tools";
//   tools: { gmailReadEmail: gmailReadEmail({ search: "in:inbox" }), webReadPage: webReadPage() }
//
// The memory tools, the self tools and scriptRun are not here: an agent
// turns them on with `features` in its definition.
//
// The work itself is in services/, published as "@chloejs/core/services", and a job calls it
// from a step rather than coming through here. If a job imports this file,
// something is in the wrong place.
//
// Same rule as `index.ts`: adding a name here is publishing it.


// One folder, as tools, for an agent that needs a different set.
export { fsEditFile, fsListFiles, fsReadFile, fsSearchFiles, fsWriteFile } from "./fs.ts";

// Gmail, as the person signed in to Google: reading the mail an agent is bound
// to, answering one of those messages, and sending one. Each needs the google
// connection, and the runtime runs its sign-in when one is needed, so there is
// nothing to add for that.
//
// gmailReplyEmail is the narrow one: it answers a message the agent has
// already read, at that message's own address, so it cannot reach anybody who
// has not written in. Prefer it over sending wherever the mail is a reply.
export { gmailReadEmail, gmailReplyEmail, gmailSendEmail } from "#chloe/connections/google/gmail";

// The calendar, as the person signed in to Google: the events on the calendars
// an agent is bound to, and adding one that invites nobody.
export { calendarAddEvent, calendarListEvents } from "#chloe/connections/google/calendar";

// Drive, as the person signed in to Google: finding files in the part an agent
// is bound to, and reading one as text, a Google Doc included.
export { driveReadFile, driveSearchFiles } from "#chloe/connections/google/drive";

// Sending one email through Resend, on a key.
export { resendSendEmail } from "#chloe/connections/resend/resend";

// Starting an email conversation, for an agent on the email channel.
export { emailStartConversation } from "./email.ts";

// A service's MCP server, for an agent's `connections`: the tools it publishes,
// named like these.
export { mcpConnection, type McpOptions } from "#chloe/connections/mcp";

// Reading a public web page.
export { webReadPage } from "./web.ts";
