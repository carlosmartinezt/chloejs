// What a model can be given, to the repo that installs chloe.
//
// Everything here is a tool: a wrapper that lets a model reach work it could
// not have been told the rule for. Each one is a function an agent calls with
// its own folder, its own mailbox, its own From line, so nothing here names an
// agent or a person.
//
//   import { readMail, readWeb } from "@chloejs/core/tools";
//
// The notes tools, write_skill and run_script are not here: an agent turns
// them on with `features` in its definition.
//
// The work itself is in do/, published from "@chloejs/core", and a job calls it
// from a step rather than coming through here. If a job imports this file,
// something is in the wrong place.
//
// Same rule as `index.ts`: adding a name here is publishing it.


// One folder, as tools, for an agent that needs a different set.
export { listIn, readIn, searchIn, writeIn } from "./files.ts";

// Mail in, mail out.
export { readMail } from "./gmail.ts";
export { sendEmail } from "./send_email.ts";

// Reading a public web page.
export { readWeb } from "./web.ts";
