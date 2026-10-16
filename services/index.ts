// What a job can do without asking anybody: running a command, sending mail,
// reading mail, reading and writing files in one folder, running one of an
// agent's own scripts, listing its own runs, reading a web page, searching the web.
//
//   import { run, deliverEmail } from "@chloejs/core/services";
//
// The same work offered to a model instead is "@chloejs/core/tools/<name>",
// and each of those is a wrapper over one of these. Same rule as `index.ts`: adding a
// name here is publishing it.

export { run, type Result } from "./runService.ts";
export { markdownToHtml, markdownToText, deliverEmail, type EmailSender } from "./emailService.ts";
export { readEmailMessages, readOneEmailMessage, sendGmail, type Message as Mail } from "#chloe/plugins/google/gmailService";
export { NeedsClient, finish, setupSteps, signInState, start, type SignInState, type Started } from "#chloe/plugins/google/googleService";
export { addCalendarEvent, listCalendarEvents, type CalendarEvent } from "#chloe/plugins/google/calendarService";
export { readDriveFile, searchDriveFiles, type DriveFile } from "#chloe/plugins/google/driveService";
export { deleteFiles, editFiles, folderTree, listFiles, moveFiles, readAsText, readFiles, searchFiles, writeFiles } from "./filesService.ts";
export { listScripts, runScripts } from "./scriptsService.ts";
export { ownRun, ownRuns } from "./selfService.ts";
export { readPage, htmlToText, feedToText, isPrivate, type Page } from "#chloe/plugins/web/webService";
export { searchWeb, type Found } from "#chloe/plugins/web/searchService";
export { canReach, deliver, owner, split, type Send } from "./messageService.ts";
