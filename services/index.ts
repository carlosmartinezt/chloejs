// What a job can do without asking anybody: running a command, sending mail,
// reading mail, reading and writing files in one folder, running one of an
// agent's own scripts, reading a web page.
//
//   import { run, deliverEmail } from "@chloejs/core/services";
//
// The same work offered to a model instead is "@chloejs/core/tools/<name>",
// and each of those is a wrapper over one of these. Same rule as `index.ts`: adding a
// name here is publishing it.

export { run, type Result } from "./runService.ts";
export { markdownToHtml, markdownToText, deliverEmail, type EmailSender } from "./emailService.ts";
export { readEmailMessages, readOneEmailMessage, sendGmail, type Message as Mail } from "#chloe/connections/google/gmailService";
export { NeedsClient, finish, setupSteps, signInState, start, type SignInState, type Started } from "#chloe/connections/google/googleService";
export { addCalendarEvent, listCalendarEvents, type CalendarEvent } from "#chloe/connections/google/calendarService";
export { readDriveFile, searchDriveFiles, type DriveFile } from "#chloe/connections/google/driveService";
export { editFiles, folderTree, listFiles, readFiles, searchFiles, writeFiles } from "./filesService.ts";
export { listScripts, runScripts } from "./scriptsService.ts";
export { readPage, htmlToText, feedToText, isPrivate, type Page } from "./webService.ts";
