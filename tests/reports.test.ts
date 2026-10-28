import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { removeTrackedMember, setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import type { HorseRecord } from "../src/store/horseRecordStore";
import type { HorseTier } from "../src/services/horseRanking";
import {
  MIN_WEEKLY_GAMES,
  REPORT_GRACE_MS,
  buildReportData,
  latestDuePeriod,
  loadReport,
  nextReportDueAt,
  skipFinishedPeriods,
} from "../src/services/reports";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";
import { buildReportEmbed, periodLabel } from "../src/utils/reportEmbed";
import { getReportMark, markReportHandled } from "../src/store/reportStore";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

const utc = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
// Tuesday 2026-10-27 (PDT, UTC-7): the day is 07:00Z to 07:00Z, the week is Monday 10-26 to Monday 11-02.
const DAY = pacificDay(utc("2026-10-27T19:00:00Z"));
const WEEK = pacificWeek(utc("2026-10-27T19:00:00Z"));
const GUILD = "report-guild";

let directory: string;
let saved: string | undefined;

beforeEach(() => {
  closeDatabase();
  saved = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-report-data-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (saved === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = saved;
  rmSync(directory, { recursive: true, force: true });
});

let counter = 0;
function game(user: string, tier: HorseTier, score: number, at: number, extra: Partial<HorseRecord> = {}): HorseRecord {
  counter += 1;
  return makeHorseRecord({ guildId: GUILD, discordUserId: user, puuid: `puuid-${user}`, matchId: `NA1_R${counter}`, tier, score, playedAt: at, ...extra });
}

test("a day becomes due only after the grace period, and the report is always the latest finished day", () => {
  const midnight = utc("2026-10-27T07:00:00Z");
  assert.deepEqual(latestDuePeriod("day", midnight - 1), pacificDay(utc("2026-10-25T20:00:00Z")), "just before midnight the finished day is the one before yesterday");
  assert.deepEqual(latestDuePeriod("day", midnight + REPORT_GRACE_MS - 1), pacificDay(utc("2026-10-25T20:00:00Z")), "a game that ended before midnight still has time to be recorded");
  assert.deepEqual(latestDuePeriod("day", midnight + REPORT_GRACE_MS), pacificDay(utc("2026-10-26T20:00:00Z")));
  assert.deepEqual(latestDuePeriod("day", midnight + 20 * HOUR), pacificDay(utc("2026-10-26T20:00:00Z")));
});

test("a week becomes due after Sunday ends, and an outage of several weeks still names only the latest week", () => {
  const monday = utc("2026-10-26T07:00:00Z");
  assert.deepEqual(latestDuePeriod("week", monday + REPORT_GRACE_MS - 1), pacificWeek(utc("2026-10-14T12:00:00Z")));
  assert.deepEqual(latestDuePeriod("week", monday + REPORT_GRACE_MS), pacificWeek(utc("2026-10-20T12:00:00Z")));
  assert.deepEqual(latestDuePeriod("week", monday + 40 * 24 * HOUR), pacificWeek(utc("2026-11-25T12:00:00Z")));
});

test("the next due time lands just after Pacific midnight and follows daylight saving", () => {
  // Ordinary day: midnight PDT is 07:00Z.
  assert.equal(nextReportDueAt(utc("2026-10-27T19:00:00Z")), utc("2026-10-28T07:30:00Z"));
  // The 25-hour day daylight saving ends: the next midnight is 08:00Z (PST).
  assert.equal(nextReportDueAt(utc("2026-11-01T12:00:00Z")), utc("2026-11-02T08:30:00Z"));
  // The 23-hour day daylight saving starts: the next midnight is 07:00Z (PDT) after an 08:00Z one.
  assert.equal(nextReportDueAt(utc("2026-03-08T20:00:00Z")), utc("2026-03-09T07:30:00Z"));
  // Inside the grace period the day that just ended is still waiting, so the due time is now close ahead.
  assert.equal(nextReportDueAt(utc("2026-10-27T07:11:00Z")), utc("2026-10-27T07:30:00Z"));
  // Exactly at the due time the next one is a day later, never the same instant.
  assert.equal(nextReportDueAt(utc("2026-10-27T07:30:00Z")), utc("2026-10-28T07:30:00Z"));
  for (const instant of [utc("2026-11-01T08:30:00Z"), utc("2026-03-08T09:59:59Z"), utc("2026-12-31T23:59:59Z")]) {
    assert.ok(nextReportDueAt(instant) > instant);
  }
});

test("the daily report counts games, tiers, averages and the best and worst game per day", () => {
  const records = [
    game("a", "特等马", 9, DAY.start + HOUR),
    game("a", "上等马", 7, DAY.start + 2 * HOUR),
    game("b", "没有马", 1.5, DAY.start + 3 * HOUR),
    game("c", "中等马", 5, DAY.start + 4 * HOUR),
    game("c", "下等马", 3, DAY.start + 5 * HOUR),
    game("a", "特等马", 9.9, DAY.start - HOUR), // yesterday evening
    game("b", "特等马", 9.9, DAY.end), // tomorrow, exactly at the end
  ];
  const data = buildReportData({ kind: "day", range: DAY, mock: false, records, memberIds: ["a", "b", "c"] });
  assert.equal(data.totalGames, 5);
  assert.deepEqual(data.tierTotals, { 特等马: 1, 上等马: 1, 中等马: 1, 下等马: 1, 没有马: 1 });
  assert.deepEqual(data.members.map((member) => [member.discordUserId, member.games, member.averageScore]), [["a", 2, 8], ["c", 2, 4], ["b", 1, 1.5]]);
  assert.deepEqual(data.topHorses.map((member) => member.discordUserId), ["a"]);
  assert.deepEqual(data.noneHorses.map((member) => member.discordUserId), ["b"]);
  assert.equal(data.bestGame?.score, 9);
  assert.equal(data.worstGame?.score, 1.5);
  assert.equal(data.members[0].best.score, 9);
  assert.equal(data.members[0].worst.score, 7);
});

test("the weekly leaderboard ranks by average score and leaves out members below the games bar", () => {
  assert.equal(MIN_WEEKLY_GAMES, 3);
  const at = (index: number) => WEEK.start + index * HOUR;
  const records = [
    ...[8, 9, 7].map((score, index) => game("steady", score >= 9 ? "特等马" : "上等马", score, at(index))),
    ...[3, 2, 4, 1].map((score, index) => game("rough", score <= 1.5 ? "没有马" : "下等马", score, at(10 + index))),
    ...[5, 5, 5].map((score, index) => game("middle", "中等马", score, at(20 + index))),
    game("lucky", "特等马", 10, at(30)), // one perfect game must not win the week
    game("unlucky", "没有马", 0, at(31)),
  ];
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: ["steady", "rough", "middle", "lucky", "unlucky"] });
  assert.deepEqual(data.members.map((member) => [member.discordUserId, member.qualified]), [
    ["steady", true], ["middle", true], ["rough", true], ["lucky", false], ["unlucky", false],
  ]);
  assert.equal(data.members[0].averageScore, 8);
  assert.deepEqual(data.topHorses.map((member) => member.discordUserId), ["steady"]);
  assert.deepEqual(data.noneHorses.map((member) => member.discordUserId), ["rough"]);
  assert.equal(data.bestGame?.score, 10, "the best single game still counts everyone");
  assert.equal(data.worstGame?.score, 0);
});

test("weekly streaks are the longest run inside the week, in play order", () => {
  const at = (index: number) => WEEK.start + index * HOUR;
  const tiers: HorseTier[] = ["特等马", "特等马", "上等马", "特等马", "特等马", "特等马", "没有马", "没有马"];
  const records = tiers.map((tier, index) => game("run", tier, tier === "特等马" ? 9 : 5, at(index)));
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: ["run"] });
  assert.equal(data.members[0].topStreak, 3);
  assert.equal(data.members[0].noneStreak, 2);
});

test("nobody is crowned or shamed with fewer than two ranked members or when everyone tied", () => {
  const alone = buildReportData({ kind: "day", range: DAY, mock: false, records: [game("a", "特等马", 9, DAY.start + HOUR)], memberIds: ["a"] });
  assert.deepEqual(alone.topHorses, []);
  assert.deepEqual(alone.noneHorses, []);
  const tied = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b"],
    records: [game("a", "中等马", 5, DAY.start + HOUR), game("b", "中等马", 5, DAY.start + 2 * HOUR)],
  });
  assert.deepEqual(tied.topHorses, []);
  const onlyOneWeekly = buildReportData({
    kind: "week", range: WEEK, mock: false, memberIds: ["a", "b"],
    records: [...[8, 8, 8].map((score, index) => game("a", "上等马", score, WEEK.start + index * HOUR)), game("b", "没有马", 0, WEEK.start + 5 * HOUR)],
  });
  assert.deepEqual(onlyOneWeekly.topHorses, [], "one ranked member is not enough to name a champion");
});

test("averages that print the same are a tie, so nobody is crowned or shamed on a hidden difference", () => {
  // 6.34 and 6.26 both print 6.3.
  const at = (index: number) => DAY.start + index * HOUR;
  const everyone = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b"],
    records: [game("a", "上等马", 6.34, at(1)), game("b", "上等马", 6.26, at(2))],
  });
  assert.deepEqual(everyone.topHorses, [], "the printed averages are equal, so nobody is the top horse");
  assert.deepEqual(everyone.noneHorses, []);

  const crowd = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b", "c"],
    records: [game("a", "特等马", 8, at(1)), game("b", "中等马", 6.34, at(2)), game("c", "没有马", 6.26, at(3))],
  });
  assert.deepEqual(crowd.topHorses.map((member) => member.discordUserId), ["a"]);
  assert.deepEqual(crowd.noneHorses.map((member) => member.discordUserId).sort(), ["b", "c"], "6.34 and 6.26 both print 6.3");

  const topTie = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b", "c"],
    records: [game("a", "特等马", 8.34, at(1)), game("b", "特等马", 8.26, at(2)), game("c", "没有马", 2, at(3))],
  });
  assert.deepEqual(topTie.topHorses.map((member) => member.discordUserId).sort(), ["a", "b"], "8.34 and 8.26 both print 8.3");
  assert.deepEqual(topTie.noneHorses.map((member) => member.discordUserId), ["c"]);

  const bottomTie = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b", "c"],
    records: [game("a", "特等马", 9, at(1)), game("b", "下等马", 3.04, at(2)), game("c", "没有马", 2.96, at(3))],
  });
  assert.deepEqual(bottomTie.noneHorses.map((member) => member.discordUserId).sort(), ["b", "c"], "3.04 and 2.96 both print 3.0");
});

test("the leaderboard breaks a printed tie by top-tier games, not by the hidden decimals", () => {
  const at = (index: number) => DAY.start + index * HOUR;
  const data = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b"],
    // a's raw average is higher, but both print 6.3 and b has the 特等马 game.
    records: [game("a", "上等马", 6.34, at(1)), game("b", "特等马", 6.26, at(2))],
  });
  assert.deepEqual(data.members.map((member) => member.discordUserId), ["b", "a"]);
});

test("only real records of currently tracked members make a real report", () => {
  const records = [
    game("a", "特等马", 9, DAY.start + HOUR),
    game("a", "没有马", 0, DAY.start + 2 * HOUR, { mock: true }),
    game("stranger", "特等马", 10, DAY.start + 3 * HOUR),
  ];
  const real = buildReportData({ kind: "day", range: DAY, mock: false, records, memberIds: ["a"] });
  assert.equal(real.totalGames, 1);
  assert.deepEqual(real.members.map((member) => member.discordUserId), ["a"]);
  const mock = buildReportData({ kind: "day", range: DAY, mock: true, records, memberIds: ["a"] });
  assert.equal(mock.totalGames, 1);
  assert.equal(mock.bestGame?.score, 0);
});

test("loading a report reads the database, keeps modes apart and drops members who were unbound", () => {
  setMemberAccounts(GUILD, "a", [{ puuid: "puuid-a", gameName: "A", tagLine: "NA1" }]);
  setMemberAccounts(GUILD, "b", [{ puuid: "puuid-b", gameName: "B", tagLine: "NA1" }]);
  recordTracked([
    game("a", "特等马", 9, DAY.start + HOUR),
    game("b", "没有马", 1, DAY.start + 2 * HOUR),
    game("a", "没有马", 0.5, DAY.start + 3 * HOUR, { mock: true }),
    game("a", "特等马", 9, DAY.end + HOUR),
  ]);
  const real = loadReport(GUILD, "day", DAY, false);
  assert.equal(real.totalGames, 2);
  assert.equal(loadReport(GUILD, "day", DAY, true).totalGames, 1);
  assert.equal(loadReport("another-guild", "day", DAY, false).totalGames, 0);
  removeTrackedMember(GUILD, "b");
  assert.deepEqual(loadReport(GUILD, "day", DAY, false).members.map((member) => member.discordUserId), ["a"], "history outlives /unbind but a report shows only current members");
});

test("the embed shows the leaderboard, the named horses and safe mentions", () => {
  const at = (index: number) => WEEK.start + index * HOUR;
  const records = [
    ...[9, 9.5, 8.5].map((score, index) => game("111", "特等马", score, at(index))),
    ...[0.5, 1, 2].map((score, index) => game("222", "没有马", score, at(10 + index))),
  ];
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: ["111", "222"] });
  const json = buildReportEmbed(data, { final: true }).toJSON();
  assert.equal(json.title, "每周马报 · 2026-10-26 至 2026-11-01");
  assert.equal(json.footer?.text, "Riot 实时数据 • 太平洋时间结算 • 策马军师");
  assert.equal(json.description, "共 **6** 局 · **2** 位出战");
  const field = (name: string) => json.fields!.find((entry) => entry.name.includes(name))?.value ?? "";
  assert.equal(field("排行榜"), [
    "🥇 <@111> · 3 局 3 胜 · 均分 **9.0** · 👑3 🐎0 🐴0 🫏0 🪦0",
    "🥈 <@222> · 3 局 3 胜 · 均分 **1.2** · 👑0 🐎0 🐴0 🫏0 🪦3",
  ].join("\n"));
  assert.match(field("当周特等马"), /^<@111>：当周 3 局均分 9\.0/);
  assert.match(field("当周没有马"), /^<@222>：当周 3 局均分只有 1\.2/);
  assert.match(field("单局之最"), /最佳：<@111>.*9\.5 分\n🪦 最差：<@222>.*0\.5 分/);
  assert.match(field("军师总评"), /共鉴定 6 局：👑3 🐎0 🐴0 🫏0 🪦3/);
  // Same input, same words; a different week may read differently.
  assert.deepEqual(buildReportEmbed(data, { final: true }).toJSON(), json);
  for (const text of [json.title, json.description, ...json.fields!.map((entry) => entry.value)]) {
    assert.ok(!text!.includes("—"), "copy never uses an em dash");
    assert.ok(!text!.includes("@everyone") && !text!.includes("@here"));
  }
});

test("a mock report is visibly labeled and an unfinished period says so", () => {
  const data = buildReportData({ kind: "day", range: DAY, mock: true, memberIds: ["a", "b"], records: [
    game("a", "特等马", 9, DAY.start + HOUR, { mock: true }), game("b", "没有马", 1, DAY.start + 2 * HOUR, { mock: true }),
  ] });
  const json = buildReportEmbed(data, { final: false }).toJSON();
  assert.equal(json.title, "模拟数据 · 每日马报 · 2026-10-27 周二（进行中）");
  assert.equal(json.footer?.text, "模拟数据 / Mock data • 太平洋时间结算 • 策马军师");
  assert.equal(json.color, 0x95A5A6);
});

test("an empty period explains itself, and a lone player gets a plain note instead of fake champions", () => {
  const empty = buildReportEmbed(buildReportData({ kind: "week", range: WEEK, mock: false, records: [], memberIds: ["a"] }), { final: true }).toJSON();
  assert.match(empty.description!, /这一周还没有任何对局入档/);
  assert.equal(empty.fields, undefined);
  const alone = buildReportEmbed(buildReportData({ kind: "day", range: DAY, mock: false, memberIds: ["a"], records: [game("a", "特等马", 9, DAY.start + HOUR)] }), { final: true }).toJSON();
  const note = alone.fields!.find((entry) => entry.name.includes("特等马 / 没有马"))?.value;
  assert.match(note!, /当日只有 1 位参评，至少要两位/);
  assert.ok(!alone.fields!.some((entry) => entry.name === "🪦 当日没有马"));
});

test("a full ten-member week stays inside Discord's field limits", () => {
  const members = Array.from({ length: 10 }, (_, index) => "10000000000000000" + String(index).padStart(2, "0"));
  const records = members.flatMap((user, index) => Array.from({ length: 4 }, (_, n) =>
    game(user, "中等马", 1 + index * 0.9 + n * 0.01, WEEK.start + (index * 4 + n) * HOUR)));
  const json = buildReportEmbed(buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: members }), { final: true }).toJSON();
  for (const entry of json.fields!) assert.ok(entry.value.length <= 1024, `${entry.name} is ${entry.value.length} long`);
  assert.ok(json.description!.length <= 4096);
  const total = (json.title?.length ?? 0) + (json.description?.length ?? 0) + (json.footer?.text.length ?? 0)
    + json.fields!.reduce((sum, entry) => sum + entry.name.length + entry.value.length, 0);
  assert.ok(total <= 6000, "the whole embed stays under Discord's 6000 character cap");
});

test("period labels use Pacific dates, even when UTC is already the next day", () => {
  assert.equal(periodLabel({ kind: "day", range: pacificDay(utc("2026-10-28T03:00:00Z")) }), "2026-10-27 周二");
  assert.equal(periodLabel({ kind: "week", range: pacificWeek(utc("2026-11-02T09:00:00Z")) }), "2026-11-02 至 2026-11-08");
});

test("switching reports on skips the finished periods in both data modes and never moves a mark back", () => {
  const now = utc("2026-10-28T19:00:00Z");
  skipFinishedPeriods(GUILD, ["day"], now);
  for (const mock of [false, true]) {
    assert.equal(getReportMark(GUILD, mock, "day"), pacificDay(utc("2026-10-27T19:00:00Z")).start);
    assert.equal(getReportMark(GUILD, mock, "week"), undefined, "only the requested kind is touched");
  }
  skipFinishedPeriods(GUILD, ["week"], now);
  assert.equal(getReportMark(GUILD, false, "week"), pacificWeek(utc("2026-10-21T19:00:00Z")).start);
  markReportHandled(GUILD, false, "day", pacificDay(utc("2026-11-20T19:00:00Z")).start, 1);
  skipFinishedPeriods(GUILD, ["day"], now);
  assert.equal(getReportMark(GUILD, false, "day"), pacificDay(utc("2026-11-20T19:00:00Z")).start);
});
