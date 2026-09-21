// Five fields, each a `*`, a number, a list, a range or a step like `*/15`.
// Sunday is 0. Day of month and day of week are both matched, unlike cron's
// rule that naming both means either: no job here names both.

/** A cron line as the five sets of numbers it means. */
export interface Cron {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

const RANGES: [keyof Cron, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dayOfMonth", 1, 31],
  ["month", 1, 12],
  ["dayOfWeek", 0, 6],
];

/** A cron line as numbers, or a throw saying what it could not read. */
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

/** Whether a cron line is due at that moment, in that timezone. */
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
