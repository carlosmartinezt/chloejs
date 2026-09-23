// What a job can do without asking anybody: running a command, sending mail,
// reading mail, reading and writing files in one folder, running one of an
// agent's own scripts, reading a web page.
//
//   import { run, sendEmail } from "@chloejs/core/services";
//
// The same work offered to a model instead is "@chloejs/core/tools", and each
// of those is a wrapper over one of these. Same rule as `index.ts`: adding a
// name here is publishing it.

export { run, type Result } from "./runService.ts";
export { markdownToHtml, markdownToText, sendEmail, type EmailSender } from "./emailService.ts";
export { readEmailMessages, readOneEmailMessage, type Message as Mail } from "./gmailService.ts";
export { listFiles, readFiles, searchFiles, writeFiles } from "./filesService.ts";
export { listScripts, runScripts } from "./scriptsService.ts";
export { readPage, htmlToText, isPrivate, type Page } from "./webService.ts";
