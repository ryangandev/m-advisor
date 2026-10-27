/** The server group lives on the NA League servers, so days and weeks are counted in Pacific time. */
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

/** A half-open range of Unix milliseconds: `start` is included and `end` is not. */
export interface TimeRange {
  start: number;
  end: number;
}

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

interface Wall {
  year: number;
  month: number;
  day: number;
}

function wallClock(instant: number): Wall & { offset: number } {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // Milliseconds are dropped by the formatter, so compare against the instant truncated to whole seconds.
  return { year: parts.year, month: parts.month, day: parts.day, offset: asUtc - Math.floor(instant / 1000) * 1000 };
}

/** The instant at which Pacific wall clocks read 00:00 on the given date; a day past the month's end rolls over. */
function pacificMidnight({ year, month, day }: Wall): number {
  const naive = Date.UTC(year, month - 1, day);
  // Daylight saving changes happen at 02:00, so midnight always exists exactly once; two passes settle the offset.
  let instant = naive - wallClock(naive).offset;
  instant = naive - wallClock(instant).offset;
  return instant;
}

function addDays(wall: Wall, days: number): Wall {
  const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The Pacific calendar day containing the instant: 24 hours, or 23 or 25 when daylight saving changes. */
export function pacificDay(instant: number): TimeRange {
  if (!Number.isFinite(instant)) throw new RangeError("The instant must be a finite number of milliseconds.");
  const wall = wallClock(instant);
  return { start: pacificMidnight(wall), end: pacificMidnight(addDays(wall, 1)) };
}

/** The Pacific week containing the instant, from Monday 00:00 to the next Monday 00:00. */
export function pacificWeek(instant: number): TimeRange {
  if (!Number.isFinite(instant)) throw new RangeError("The instant must be a finite number of milliseconds.");
  const wall = wallClock(instant);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const monday = addDays(wall, -((weekday + 6) % 7));
  return { start: pacificMidnight(monday), end: pacificMidnight(addDays(monday, 7)) };
}
