// When a job runs, written the way it is said, and turned into a cron line.
//
//   every(15).minutes              "*/15 * * * *"
//   every(4).hours                 "0 */4 * * *"
//   every.hour.at(30)              "30 * * * *"   (at(0) is on the hour)
//   every.day.at("07:00")          "0 7 * * *"
//   every.day.at("10:45", "22:45") "45 10,22 * * *"
//   every.weekday.at("9:30")       "30 9 * * 1-5"
//   every.monday.at("9:00")        "0 9 * * 1"
//   every.month.on(1).at("09:00")  "0 9 1 * *"
//
// What comes out is an ordinary cron line, so the loader, the clock and the
// page read it like any other. Anything a cron line cannot say, or would say
// differently from how it reads here, is refused with the reason rather than
// rounded: every(7).minutes would run at :56 and again at :00, so it is not
// "every 7 minutes", and it is not written.
//
// describe() is the other direction, for the page: a line this file could have
// written comes back as words, and anything else is left as the cron line.

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Times of day, "HH:MM" on a 24 hour clock. Several must share the minute, because one cron line has only one. */
interface OnDays {
  at(...times: string[]): string;
}

/**
 * `every(15).minutes` and `every(4).hours`, as a cron line. A count that does
 * not divide the hour or the day evenly is refused with the reason.
 */
export function every(count: number): { readonly minutes: string; readonly hours: string } {
  return {
    get minutes() {
      evenly(count, 60, "minutes");
      return `*/${count} * * * *`;
    },
    get hours() {
      evenly(count, 24, "hours");
      return `0 */${count} * * *`;
    },
  };
}

every.minute = "* * * * *";
every.hour = {
  /** Minutes past the hour: every.hour.at(0) is on the hour. */
  at(minute: number): string {
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error(`every.hour.at(${minute}): the minute past the hour is a whole number from 0 to 59.`);
    }
    return `${minute} * * * *`;
  },
};
every.day = onDays("*", "every.day");
every.weekday = onDays("1-5", "every.weekday");
every.weekend = onDays("0,6", "every.weekend");
every.sunday = onDays("0", "every.sunday");
every.monday = onDays("1", "every.monday");
every.tuesday = onDays("2", "every.tuesday");
every.wednesday = onDays("3", "every.wednesday");
every.thursday = onDays("4", "every.thursday");
every.friday = onDays("5", "every.friday");
every.saturday = onDays("6", "every.saturday");
every.month = {
  on(day: number): OnDays {
    // 29 and later are left out on purpose: a job on the 31st would skip
    // every short month without saying so.
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new Error(`every.month.on(${day}): the day is 1 to 28, so it happens in every month.`);
    }
    return onDays("*", "every.month", String(day));
  },
};

function onDays(days: string, where: string, dayOfMonth = "*"): OnDays {
  return {
    at(...list) {
      const { minute, hours } = times(list, where);
      return `${minute} ${hours.join(",")} ${dayOfMonth} * ${days}`;
    },
  };
}

function times(list: string[], where: string): { minute: number; hours: number[] } {
  if (list.length === 0) throw new Error(`${where}.at() needs a time, like "07:00".`);
  const read = list.map((time) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    const hour = Number(match?.[1]);
    const minute = Number(match?.[2]);
    if (!match || hour > 23 || minute > 59) {
      throw new Error(`${JSON.stringify(time)} is not a time. Write it on a 24 hour clock, like "07:00" or "22:45".`);
    }
    return { hour, minute };
  });
  if (new Set(read.map((one) => one.minute)).size > 1) {
    throw new Error(`${list.join(", ")} do not share a minute, and one cron line has only one. Make them two jobs.`);
  }
  return { minute: read[0].minute, hours: [...new Set(read.map((one) => one.hour))].sort((a, b) => a - b) };
}

/** Only a count that divides the hour or the day, so the gap is the same every time. */
function evenly(count: number, of: number, unit: string): void {
  if (Number.isInteger(count) && count > 1 && count < of && of % count === 0) return;
  const fits = Array.from({ length: of - 2 }, (_, i) => i + 2).filter((n) => of % n === 0);
  const one = unit === "minutes" ? "every.minute" : "every.hour.at(0)";
  throw new Error(
    count === 1
      ? `every(1).${unit} is ${one}.`
      : `every(${count}).${unit} does not divide ${unit === "minutes" ? "an hour" : "a day"} evenly, ` +
        `so the gaps would not all be the same. It can be ${fits.join(", ")}.`,
  );
}

/** A cron line in words, when it is one this file could have written. */
export function describe(cron: string, timezone = "UTC"): string | undefined {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  if (month !== "*") return undefined;
  const zone = timezone === "UTC" ? "UTC" : timezone.split("/").pop()!.replace(/_/g, " ");

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    if (cron.trim() === "* * * * *") return "every minute";
    const minutes = /^\*\/(\d+)$/.exec(minute);
    if (minutes && hour === "*" && minutes[1] !== "1") return `every ${minutes[1]} minutes`;
    const hours = /^\*\/(\d+)$/.exec(hour);
    if (hours && minute === "0" && hours[1] !== "1") return `every ${hours[1]} hours`;
    if (/^\d+$/.test(minute) && hour === "*") return minute === "0" ? "every hour" : `every hour at :${pad(minute)}`;
  }

  if (!/^\d+$/.test(minute) || !/^\d+(,\d+)*$/.test(hour)) return undefined;
  const at = hour
    .split(",")
    .map((h) => `${pad(h)}:${pad(minute)}`)
    .join(" and ");

  const days =
    dayOfWeek === "*" ? "every day" :
    dayOfWeek === "1-5" ? "weekdays" :
    dayOfWeek === "0,6" ? "weekends" :
    /^[0-6]$/.test(dayOfWeek) ? `${DAYS[Number(dayOfWeek)]}s` :
    undefined;
  if (!days) return undefined;
  if (dayOfMonth === "*") return `${days} at ${at} ${zone}`;
  if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) return `on the ${nth(Number(dayOfMonth))} of every month at ${at} ${zone}`;
  return undefined;
}

const pad = (n: string) => n.padStart(2, "0");

function nth(n: number): string {
  const end = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${end}`;
}
