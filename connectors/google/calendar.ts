// The tools over calendarService.ts: reading the events on the calendars an
// agent is bound to, and adding one. The binding is in the agent's config, and
// the model chooses only the dates, and what the event it adds says.
import { tool } from "ai";
import { z } from "zod";

import { addCalendarEvent, listCalendarEvents } from "./calendarService.ts";
import { google } from "./connector.ts";

interface Options {
  /** The calendars it may see, by id. `primary` is the account's own. */
  calendars?: string[];
  /** How to describe them in the tool's description, in plain words. */
  what?: string;
  /** Days ahead when the agent does not say. */
  days?: number;
}

/** A tool that lists the events on the calendars the agent is bound to. */
export function calendarListEvents({ calendars = ["primary"], what = "the calendar", days = 7 }: Options = {}) {
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
  return Object.assign(list, { needs: google });
}

/**
 * A tool that adds one event to the calendar it is bound to. It invites
 * nobody, so nothing reaches anybody else.
 */
export function calendarAddEvent({ calendar = "primary", what = "the calendar", when = "" }: { calendar?: string; what?: string; when?: string } = {}) {
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
