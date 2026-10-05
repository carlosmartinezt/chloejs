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

/** One event, as a list hands it back. */
export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  /** A time with its offset, or a date for an event that lasts all day. */
  start: string;
  end: string;
  location?: string;
  details?: string;
  /** How many people are on it, the account included. */
  people?: number;
  link?: string;
}

/**
 * The events on these calendars from `from` for `days`, soonest first. What
 * somebody else wrote in an event is marked as theirs, because a model reads it.
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
 * Add one event to a calendar, with nobody invited, so nothing is sent to
 * anybody. Returns where it can be opened.
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
