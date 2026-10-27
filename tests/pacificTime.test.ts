import assert from "node:assert/strict";
import { test } from "node:test";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";

const utc = (iso: string) => Date.parse(iso);
const hours = (range: { start: number; end: number }) => (range.end - range.start) / 3_600_000;

test("an ordinary Pacific day runs from 00:00 PDT to the next 00:00 PDT", () => {
  assert.deepEqual(pacificDay(utc("2026-10-27T19:30:00Z")), { start: utc("2026-10-27T07:00:00Z"), end: utc("2026-10-28T07:00:00Z") });
});

test("the Pacific date, not the UTC date, picks the day", () => {
  // 03:00 UTC on the 28th is still the evening of the 27th in Pacific time.
  assert.equal(pacificDay(utc("2026-10-28T03:00:00Z")).start, utc("2026-10-27T07:00:00Z"));
  assert.equal(pacificDay(utc("2026-01-15T07:59:59.999Z")).start, utc("2026-01-14T08:00:00Z"));
  assert.equal(pacificDay(utc("2026-01-15T08:00:00Z")).start, utc("2026-01-15T08:00:00Z"));
});

test("a day includes its first millisecond and excludes its end", () => {
  const day = pacificDay(utc("2026-10-27T19:30:00Z"));
  assert.deepEqual(pacificDay(day.start), day);
  assert.deepEqual(pacificDay(day.end - 1), day);
  assert.equal(pacificDay(day.end).start, day.end);
});

test("the day daylight saving ends has 25 hours", () => {
  const day = pacificDay(utc("2026-11-01T12:00:00Z"));
  assert.deepEqual(day, { start: utc("2026-11-01T07:00:00Z"), end: utc("2026-11-02T08:00:00Z") });
  assert.equal(hours(day), 25);
  // The repeated hour at 01:00 belongs to the same day both times.
  assert.deepEqual(pacificDay(utc("2026-11-01T08:30:00Z")), day);
  assert.deepEqual(pacificDay(utc("2026-11-01T09:30:00Z")), day);
});

test("the day daylight saving starts has 23 hours", () => {
  const day = pacificDay(utc("2026-03-08T20:00:00Z"));
  assert.deepEqual(day, { start: utc("2026-03-08T08:00:00Z"), end: utc("2026-03-09T07:00:00Z") });
  assert.equal(hours(day), 23);
});

test("a week runs from Monday 00:00 to the next Monday 00:00", () => {
  // Tuesday 2026-10-27 belongs to the week of Monday 10-26.
  assert.deepEqual(pacificWeek(utc("2026-10-27T19:30:00Z")), { start: utc("2026-10-26T07:00:00Z"), end: utc("2026-11-02T08:00:00Z") });
});

test("Sunday night is the end of the old week and Monday morning starts the new one", () => {
  const week = pacificWeek(utc("2026-10-27T19:30:00Z"));
  assert.deepEqual(pacificWeek(week.end - 1), week);
  assert.deepEqual(pacificWeek(week.start), week);
  const next = pacificWeek(week.end);
  assert.equal(next.start, week.end);
  assert.equal(next.end, utc("2026-11-09T08:00:00Z"));
});

test("the week that daylight saving ends has 169 hours", () => {
  const week = pacificWeek(utc("2026-11-01T12:00:00Z"));
  assert.equal(hours(week), 169);
  assert.equal(week.start, utc("2026-10-26T07:00:00Z"));
  assert.equal(week.end, utc("2026-11-02T08:00:00Z"));
});

test("the week that daylight saving starts has 167 hours", () => {
  const week = pacificWeek(utc("2026-03-08T20:00:00Z"));
  assert.equal(hours(week), 167);
  assert.equal(week.start, utc("2026-03-02T08:00:00Z"));
  assert.equal(week.end, utc("2026-03-09T07:00:00Z"));
});

test("a week crossing a year boundary and a leap day still starts on a Monday", () => {
  assert.deepEqual(pacificWeek(utc("2027-01-01T20:00:00Z")), { start: utc("2026-12-28T08:00:00Z"), end: utc("2027-01-04T08:00:00Z") });
  assert.deepEqual(pacificWeek(utc("2028-02-29T20:00:00Z")), { start: utc("2028-02-28T08:00:00Z"), end: utc("2028-03-06T08:00:00Z") });
});

test("a non-finite instant is rejected", () => {
  assert.throws(() => pacificDay(Number.NaN), RangeError);
  assert.throws(() => pacificWeek(Number.POSITIVE_INFINITY), RangeError);
});
