// The one job here that is a prompt from end to end.
//
// The words are in how-it-went.md beside this file. It is a prompt rather than
// code because what to make of a week of runs is not a rule anybody could write
// down, and because it decides for itself whether there is anything to say.
import { defineJob, prompt } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

export default defineJob({
  id: "how-it-went",
  cron: every.sunday.at("18:00"),
  timezone: "America/New_York",
  description: "You know whether anything about the shop has been quietly getting worse.",
  markdown: prompt("jobs/how-it-went.md"),
});
