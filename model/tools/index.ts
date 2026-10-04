// What a model can be given, to the repo that installs chloe.
//
// Everything here is a tool: a wrapper that lets a model reach work it could
// not have been told the rule for. Each one is a function an agent calls with
// its own folder, its own mailbox, its own From line, so nothing here names an
// agent or a person.
//
//   import { readMail, readWeb } from "@chloejs/core/tools";
//
// The notes tools, the own-file tools and runScript are not
// here: an agent turns them on with `features` in its definition.
//
// The work itself is in services/, published as "@chloejs/core/services", and a job calls it
// from a step rather than coming through here. If a job imports this file,
// something is in the wrong place.
//
// Same rule as `index.ts`: adding a name here is publishing it.


// One folder, as tools, for an agent that needs a different set.
export { editIn, listIn, readIn, searchIn, writeIn } from "./files.ts";

// Mail in, mail out, and answering one that came in. Each of these brings the
// Google sign-in with it, so an agent that reads, sends or replies can get
// itself signed in and there is nothing to add here for that.
//
// replyMail is the narrow one of the three: it answers a message the agent has
// already read, at that message's own address, so it cannot reach anybody who
// has not written in. Prefer it over sendEmail wherever the mail is a reply.
export { readMail, replyMail } from "./gmail.ts";
export { sendEmail } from "./sendEmail.ts";

// Starting an email conversation, for an agent on the email channel.
export { startEmail } from "./startEmail.ts";


// Reading a public web page.
export { readWeb } from "./web.ts";
