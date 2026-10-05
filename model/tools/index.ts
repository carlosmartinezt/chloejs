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
// to, answering one of those messages, and sending one. Each is marked
// `needs: "google"`, and the loader adds the sign-in beside it, so there is nothing
// to add for that.
//
// gmailReplyEmail is the narrow one: it answers a message the agent has
// already read, at that message's own address, so it cannot reach anybody who
// has not written in. Prefer it over sending wherever the mail is a reply.
export { gmailReadEmail, gmailReplyEmail, gmailSendEmail } from "./gmail.ts";

// Sending one email through Resend, on a key.
export { resendSendEmail } from "./resend.ts";

// Starting an email conversation, for an agent on the email channel.
export { emailStartConversation } from "./email.ts";

// Reading a public web page.
export { webReadPage } from "./web.ts";
