// What a model can be given, to the repo that installs chloe.
//
// Everything here is a tool: a wrapper that lets a model reach work it could
// not have been told the rule for. Each one is a function an agent calls with
// its own folder, its own mailbox, its own From line, so nothing here names an
// agent or a person.
//
//   import { memory, selfImprovement, runScripts, readMail } from "chloejs/tools";
//
// The work itself is in do/, published from "chloejs", and a job calls it
// from a step rather than coming through here. If a job imports this file,
// something is in the wrong place.
//
// Same rule as `index.ts`: adding a name here is publishing it.

// What most agents are given: notes it keeps, skills it rewrites, scripts it runs.
export { memory } from "./memory.ts";
export { selfImprovement, writeSkill } from "./write_skill.ts";
export { runScripts, runScript } from "./run_script.ts";

// One folder, as tools, for an agent that needs a different set.
export { listIn, readIn, searchIn, writeIn } from "./files.ts";

// Mail in, mail out.
export { readMail } from "./gmail.ts";
export { sendEmail } from "./send_email.ts";

// Reading a public web page.
export { readWeb } from "./web.ts";
