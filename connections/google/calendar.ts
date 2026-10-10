// The tools over calendarService.ts: reading the events on the calendars an
// agent is bound to, and adding one. The binding is in the agent's config, and
// the model chooses only the dates, and what the event it adds says.
//
//   import * as calendar from "@chloejs/core/tools/calendar";
//   tools: { calendarListEvents: calendar.listEvents({ calendars: ["primary"] }) }
import { tool } from "ai";
import { z } from "zod";

import { addCalendarEvent, listCalendarEvents } from "./calendarService.ts";
import { google } from "./connection.ts";

/** The options for `calendar.listEvents`. */
interface Options {
  /**
   * The ids of the calendars the model can see. `"primary"` is the signed-in
   * account's own calendar. The model cannot change this list. Default: `["primary"]`.
   */
  calendars?: string[];
  /**
   * A few words for those calendars, such as `"the team calendar"`. Used in
   * the tool's description for the model. Default: `"the calendar"`.
   */
  what?: string;
  /** How many days ahead to look when the model does not say. Default: 7. */
  days?: number;
}

/**
 * Makes a tool that lets the model list the events on some Google calendars,
 * soonest first.
 *
 * `calendars` sets which calendars the model can see, and the model cannot
 * change it. The model chooses only the start day, how many days ahead (up to
 * 90), and how many events (up to 100, default 50).
 *
 * Needs the Google connection.
 *
 * ```ts
 * tools: { calendarListEvents: calendar.listEvents({ calendars: ["primary"] }) }
 * ```
 */
export function listEvents({ calendars = ["primary"], what = "the calendar", days = 7 }: Options = {}) {
  const list = tool({
    description: `List the events on ${what}, soonest first. You cannot change which calendars this reads.`,
    inputSchema: z.object({
      from: z.string().optional().describe("The day to start from, like 2026-10-06. Default today."),
      days: z.number().int().min(1).max(90).optional().describe(`How many days to look ahead. Default ${days}.`),
      limit: z.number().int().min(1).max(100).optional().describe("How many at most. Default 50."),
    }),
    execute: async ({ from, days: ahead, limit }) =>
      await listCalendarEvents({ calendars, from: from ? new Date(from) : new Date(), days: ahead ?? days, limit }),
  });
  return Object.assign(list, { needs: google, onlyReads: true });
}

/**
 * Makes a tool that lets the model add one event to a Google calendar. The
 * model writes the title, start, end, and optionally a place and details.
 *
 * The event invites nobody and sends no email, so nobody else hears about it.
 *
 * Options:
 * - `calendar`: the id of the calendar to add to. Default: `"primary"` (the
 *   signed-in account's own). The model cannot change it.
 * - `what`: a few words for that calendar, used in the tool's description.
 *   Default: `"the calendar"`.
 * - `when`: when the model should use the tool, in your own words. Added to
 *   the tool's description. Not set by default.
 *
 * Needs the Google connection.
 */
export function addEvent({ calendar = "primary", what = "the calendar", when = "" }: { calendar?: string; what?: string; when?: string } = {}) {
  const add = tool({
    description:
      `Add one event to ${what}. It invites nobody and sends nothing.${when ? ` ${when}` : ""}`,
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      start: z.string().describe("A time with its offset, like 2026-10-06T15:00:00-04:00, or a day, like 2026-10-06, for all day."),
      end: z.string().describe("The same form as start. For a day, the day after the last one."),
      location: z.string().max(300).optional(),
      details: z.string().max(4000).optional(),
    }),
    execute: async (input) => await addCalendarEvent({ calendar, ...input }),
  });
  return Object.assign(add, { needs: google });
}
