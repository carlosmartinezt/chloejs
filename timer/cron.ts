// Five fields, each a `*`, a number, a list, a range or a step like `*/15`.
// Sunday is 0. Day of month and day of week are both matched, unlike cron's
// rule that naming both means either: no job here names both.

/**
 * A cron line, read into numbers by `parse`. Each field lists every value it
 * matches, smallest first.
 */
export interface Cron {
  /** The minutes it matches, from 0 to 59. */
  minute: number[];
  /** The hours it matches, from 0 to 23. */
  hour: number[];
  /** The days of the month it matches, from 1 to 31. */
  dayOfMonth: number[];
  /** The months it matches, from 1 (January) to 12. */
  month: number[];
  /** The days of the week it matches, from 0 (Sunday) to 6 (Saturday). */
  dayOfWeek: number[];
}

const RANGES: [keyof Cron, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dayOfMonth", 1, 31],
  ["month", 1, 12],
  ["dayOfWeek", 0, 6],
];

/**
 * Reads a cron line, such as `"30 7 * * 1-5"`, into numbers.
 *
 * The line has five fields: minute, hour, day of month, month, day of week.
 * Each field is `*`, a number, a range (`1-5`), a list (`1,3,5`) or a step
 * (`0-30/10`, or `*` followed by `/15` for every 15th). Sunday is 0, and 7 is
 * not allowed. Names such as `MON` or `JAN` are not read.
 *
 * Throws an error that says what is wrong if the line cannot be read.
 */
export function parse(line: string): Cron {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`A cron line needs five fields, got ${fields.length}: ${JSON.stringify(line)}`);
  }
  const cron = {} as Cron;
  RANGES.forEach(([name, low, high], i) => {
    cron[name] = field(fields[i], low, high, name);
  });
  return cron;
}

function field(text: string, low: number, high: number, name: string): number[] {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [spec, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in ${name}: ${part}`);

    let from = low;
    let to = high;
    if (spec !== "*") {
      const bounds = spec.split("-").map(Number);
      if (bounds.some((n) => !Number.isInteger(n))) throw new Error(`Bad ${name}: ${part}`);
      from = bounds[0];
      to = bounds.length > 1 ? bounds[1] : stepText ? high : bounds[0];
    }
    if (from < low || to > high || from > to) throw new Error(`${name} out of range (${low}-${high}): ${part}`);
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Returns `true` if the cron line matches the minute of `at`, read as a clock
 * time in `timezone` (such as `"America/New_York"`). Default timezone: `"UTC"`.
 * Daylight saving time is handled for you.
 *
 * Every field must match. So a line that sets both a day of the month and a
 * day of the week matches only days that are both (most cron programs match
 * days that are either).
 */
export function due(cron: Cron, at: Date, timezone = "UTC"): boolean {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = inZone(at, timezone);
  return (
    cron.minute.includes(minute) &&
    cron.hour.includes(hour) &&
    cron.dayOfMonth.includes(dayOfMonth) &&
    cron.month.includes(month) &&
    cron.dayOfWeek.includes(dayOfWeek)
  );
}

// Intl is the only thing here that knows when New York changed its clocks. An
// offset worked out by hand is wrong twice a year.
function inZone(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    minute: Number(get("minute")),
    // Some locales write midnight as 24.
    hour: Number(get("hour")) % 24,
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    dayOfWeek: days.indexOf(get("weekday")),
  };
}
