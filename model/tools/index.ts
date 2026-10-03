// What a model can be given, to the repo that installs chloe.
//
// Everything here is a tool: a wrapper that lets a model reach work it could
// not have been told the rule for. Each one is a function an agent calls with
// its own folder, its own mailbox, its own From line, so nothing here names an
// agent or a person.
//
//   import { read_mail, read_web } from "@chloejs/core/tools";
//
// The notes tools, the own-file tools and run_script are not
// here: an agent turns them on with `features` in its definition.
//
// The work itself is in services/, published as "@chloejs/core/services", and a job calls it
// from a step rather than coming through here. If a job imports this file,
// something is in the wrong place.
//
// Same rule as `index.ts`: adding a name here is publishing it.


// One folder, as tools, for an agent that needs a different set.
export { edit_in, list_in, read_in, search_in, write_in } from "./files.ts";

// Mail in, mail out, and answering one that came in. Each of these brings the
// Google sign-in with it, so an agent that reads, sends or replies can get
// itself signed in and there is nothing to add here for that.
//
// reply_mail is the narrow one of the three: it answers a message the agent has
// already read, at that message's own address, so it cannot reach anybody who
// has not written in. Prefer it over send_email wherever the mail is a reply.
export { read_mail, reply_mail } from "./gmail.ts";
export { send_email } from "./send_email.ts";


// Reading a public web page.
export { read_web } from "./web.ts";
