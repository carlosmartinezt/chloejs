// The calendar, as the signed-in account: the events on the calendars an agent
// is bound to, and adding one. The calendars come from the binding, never from
// the caller, and an event added here invites nobody.
import { googleApi, marked } from "./googleService.ts";

/** Where the calendars are. */
const CALENDARS = "https://www.googleapis.com/calendar/v3/calendars";

/** A start or an end, as Google writes it: a time, or a day for all day. */
interface When {
  dateTime?: string;
  date?: string;
}

/** One event, as Google hands it back. */
interface GoogleEvent {
  id?: string;
  summary?: string;
  start?: When;
  end?: When;
  location?: string;
  description?: string;
  attendees?: unknown[];
  htmlLink?: string;
}

/** One event in the list `listCalendarEvents` returns. */
export interface CalendarEvent {
  /** The event's id in Google Calendar. */
  id: string;
  /** The id of the calendar it is on, such as `"primary"`. */
  calendar: string;
  /**
   * The event's title, or `(no title)`. Wrapped in
   * `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers, because someone else may have
   * written it.
   */
  title: string;
  /**
   * When it starts: a time with its offset, such as
   * `2026-10-06T15:00:00-04:00`, or a day, such as `2026-10-06`, for an event
   * that lasts all day.
   */
  start: string;
  /**
   * When it ends, in the same form as `start`. For an event that lasts all
   * day, this is the day after its last day.
   */
  end: string;
  /** Where it is, if set. Wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers. */
  location?: string;
  /** The event's description, if set. Wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers. */
  details?: string;
  /** How many people are invited, the account itself included. Not set when nobody is invited. */
  people?: number;
  /** A link that opens the event in Google Calendar. */
  link?: string;
}

/**
 * Lists the events on one or more Google calendars, soonest first.
 *
 * - `calendars`: the ids of the calendars to read. `"primary"` is the account's own calendar. Default: `["primary"]`.
 * - `from`: when to start looking. Default: now.
 * - `days`: how many days to look ahead from `from`. Default: 7.
 * - `limit`: the most events to return, across all the calendars. Default: 50.
 *
 * Returns `{ from, to, events }`: the start and end of the time it looked at,
 * as text such as `2026-10-06T19:00:00.000Z`, and the events. An event that
 * repeats is listed once for each time it happens.
 *
 * Throws `NeedsSignIn` when someone has to sign in to Google. Throws an
 * `Error` for any other problem with Google, such as a calendar id that does
 * not exist.
 */
export async function listCalendarEvents({
  calendars = ["primary"],
  from = new Date(),
  days = 7,
  limit = 50,
}: {
  calendars?: string[];
  from?: Date;
  days?: number;
  limit?: number;
}): Promise<{ from: string; to: string; events: CalendarEvent[] }> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const found = await Promise.all(
    calendars.map(async (calendar) => {
      const data = await googleApi<{ items?: GoogleEvent[] }>(`${CALENDARS}/${encodeURIComponent(calendar)}/events`, {
        query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: "startTime", maxResults: limit },
      });
      return (data.items ?? []).map(
        (one): CalendarEvent => ({
          id: one.id ?? "",
          calendar,
          title: marked(one.summary ?? "(no title)"),
          start: one.start?.dateTime ?? one.start?.date ?? "",
          end: one.end?.dateTime ?? one.end?.date ?? "",
          location: one.location ? marked(one.location) : undefined,
          details: one.description ? marked(one.description) : undefined,
          people: one.attendees?.length || undefined,
          link: one.htmlLink,
        }),
      );
    }),
  );
  const events = found.flat().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()).slice(0, limit);
  return { from: from.toISOString(), to: to.toISOString(), events };
}

/** A time with its offset, `2026-10-06T15:00:00-04:00`, or a day, `2026-10-06`. */
function when(value: string, what: string): When {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return { dateTime: value };
  throw new Error(`${what} is a time with its offset, like 2026-10-06T15:00:00-04:00, or a day, like 2026-10-06.`);
}

/**
 * Adds one event to a Google calendar. Nobody is invited, so no email is sent
 * to anyone.
 *
 * - `calendar`: the calendar's id. Default: `"primary"`, the account's own calendar.
 * - `title`: the event's title. Required.
 * - `start`: when it starts. Required. Either a time with its offset, such as `"2026-10-06T15:00:00-04:00"`, or a day, such as `"2026-10-06"`, for an event that lasts all day.
 * - `end`: when it ends, in the same form. Required. For an event that lasts all day, give the day after its last day.
 * - `location`: where it is.
 * - `details`: the event's description.
 *
 * Returns `{ added: true, id, link }`: the new event's id, and a link that
 * opens it in Google Calendar.
 *
 * Throws if `start` or `end` is not in one of those two forms, and nothing is
 * added. Throws `NeedsSignIn` when someone has to sign in to Google, and an
 * `Error` for any other problem with Google.
 */
export async function addCalendarEvent({
  calendar = "primary",
  title,
  start,
  end,
  location,
  details,
}: {
  calendar?: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  details?: string;
}): Promise<{ added: true; id: string; link: string }> {
  const data = await googleApi<GoogleEvent>(`${CALENDARS}/${encodeURIComponent(calendar)}/events`, {
    method: "POST",
    query: { sendUpdates: "none" },
    body: { summary: title, start: when(start, "start"), end: when(end, "end"), location, description: details },
  });
  return { added: true, id: data.id ?? "", link: data.htmlLink ?? "" };
}
