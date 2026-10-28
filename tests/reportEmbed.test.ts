import assert from "node:assert/strict";
import { test } from "node:test";
import type { HorseRecord } from "../src/store/horseRecordStore";
import type { HorseTier } from "../src/services/horseRanking";
import { buildReportData } from "../src/services/reports";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";
import { buildReportEmbed } from "../src/utils/reportEmbed";
import { makeHorseRecord } from "./helpers/horseRecords";

const HOUR = 3_600_000;
const DAY = pacificDay(Date.parse("2026-10-27T19:00:00Z"));
const WEEK = pacificWeek(Date.parse("2026-10-27T19:00:00Z"));

let counter = 0;
function game(user: string, tier: HorseTier, score: number, at: number): HorseRecord {
  counter += 1;
  return makeHorseRecord({ guildId: "wording-guild", discordUserId: user, puuid: `puuid-${user}`, matchId: `NA1_W${counter}`, tier, score, playedAt: at });
}

/** Games of one member in a row, one hour apart from `from`. */
function games(user: string, tier: HorseTier, score: number, count: number, from: number): HorseRecord[] {
  return Array.from({ length: count }, (_, index) => game(user, tier, score, from + index * HOUR));
}

/** Every text the embed shows, for checking wording. */
function allText(embed: ReturnType<typeof buildReportEmbed>): string {
  const json = embed.toJSON();
  return [json.title, json.description, ...json.fields!.flatMap((field) => [field.name, field.value])].join("\n");
}

function twoMemberData(kind: "day" | "week", range = kind === "day" ? DAY : WEEK) {
  const count = kind === "day" ? 1 : 3;
  const records = [...games("alice", "特等马", 9, count, range.start + HOUR), ...games("bob", "没有马", 1, count, range.start + 6 * HOUR)];
  return buildReportData({ kind, range, mock: false, records, memberIds: ["alice", "bob"] });
}

test("a finished period is never worded as today or this week, and the one in progress is", () => {
  for (const kind of ["day", "week"] as const) {
    const finalText = allText(buildReportEmbed(twoMemberData(kind), { final: true }));
    const currentText = allText(buildReportEmbed(twoMemberData(kind), { final: false }));
    const now = kind === "day" ? "今日" : "本周";
    const then = kind === "day" ? "当日" : "当周";
    assert.match(finalText, new RegExp(then), kind);
    assert.doesNotMatch(finalText, /今日|本周|今天|明天|明日|下周|上周/, `${kind}: ${finalText}`);
    assert.match(currentText, new RegExp(now), kind);
    assert.doesNotMatch(currentText, new RegExp(`${then}|明天|明日|下周`), kind);
  }
});

test("a finished period's lone-player and below-the-bar notes use the finished wording too", () => {
  const alone = buildReportData({ kind: "day", range: DAY, mock: false, memberIds: ["a"], records: games("a", "特等马", 9, 1, DAY.start + HOUR) });
  assert.match(allText(buildReportEmbed(alone, { final: true })), /当日只有 1 位参评/);
  assert.match(allText(buildReportEmbed(alone, { final: false })), /今日只有 1 位参评/);
  const records = [...games("a", "特等马", 9, 3, WEEK.start + HOUR), ...games("b", "没有马", 1, 3, WEEK.start + 9 * HOUR), ...games("c", "中等马", 5, 1, WEEK.start + 20 * HOUR)];
  const week = buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b", "c"], records });
  assert.match(allText(buildReportEmbed(week, { final: true })), /当周不满 3 局的不参与评选/);
  assert.match(allText(buildReportEmbed(week, { final: false })), /本周不满 3 局的不参与评选/);
});

test("the closing remarks never promise a tomorrow or a next week", () => {
  // Every phrase the daily and weekly remarks can pick, over many different periods.
  const seen = new Set<string>();
  for (let offset = 0; offset < 80; offset += 1) {
    for (const kind of ["day", "week"] as const) {
      const range = { start: DAY.start + offset * 24 * HOUR, end: DAY.end + offset * 24 * HOUR };
      for (const final of [true, false]) {
        for (const field of buildReportEmbed(twoMemberData(kind, range), { final }).toJSON().fields!) seen.add(field.value);
      }
    }
  }
  assert.ok(seen.size > 10);
  for (const text of seen) assert.doesNotMatch(text, /明天|明日|下周|上周/);
});

test("a tie for the best or worst average names every co-holder and drops the single-winner line", () => {
  const records = [
    ...games("a", "特等马", 8, 3, WEEK.start + HOUR), ...games("b", "特等马", 8, 3, WEEK.start + 5 * HOUR),
    ...games("c", "中等马", 5, 3, WEEK.start + 9 * HOUR),
    ...games("d", "没有马", 1, 3, WEEK.start + 13 * HOUR), ...games("e", "没有马", 1, 3, WEEK.start + 17 * HOUR),
  ];
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: ["a", "b", "c", "d", "e"] });
  assert.deepEqual(data.topHorses.map((member) => member.discordUserId).sort(), ["a", "b"]);
  assert.deepEqual(data.noneHorses.map((member) => member.discordUserId).sort(), ["d", "e"]);
  const json = buildReportEmbed(data, { final: true }).toJSON();
  const top = json.fields!.find((field) => field.name.startsWith("👑"))!.value;
  const none = json.fields!.find((field) => field.name.startsWith("🪦"))!.value;
  assert.match(top, /^<@a>、<@b> 并列：当周各自均分都是 8\.0。/);
  assert.match(none, /^<@d>、<@e> 并列：当周各自均分都只有 1\.0。/);
  assert.doesNotMatch(top, /它说了算/);
  assert.ok(!top.includes("<@c>") && !none.includes("<@c>"), "the middle of the field is neither best nor worst");
});

test("busiest and longest-streak lines name everyone who shares the top value, or are left out", () => {
  const records = [...games("a", "特等马", 9, 3, WEEK.start + HOUR), ...games("b", "特等马", 8, 3, WEEK.start + 5 * HOUR), ...games("c", "中等马", 5, 2, WEEK.start + 9 * HOUR)];
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, records, memberIds: ["a", "b", "c"] });
  const summary = buildReportEmbed(data, { final: true }).toJSON().fields!.find((field) => field.name === "军师总评")!.value;
  assert.match(summary, /出勤最多：<@a>、<@b>（3 局）/);
  assert.match(summary, /最长连续特等马：<@a>、<@b> 3 局/);
  assert.doesNotMatch(summary, /最长连续没有马/);
  // When the whole field played the same number of games there is no busiest member to name.
  const even = buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b"], records: records.slice(0, 6) });
  const evenSummary = buildReportEmbed(even, { final: true }).toJSON().fields!.find((field) => field.name === "军师总评")!.value;
  assert.doesNotMatch(evenSummary, /出勤最多/);
});

test("a single game in the period is listed once, not as both the best and the worst", () => {
  const lone = buildReportData({ kind: "day", range: DAY, mock: false, memberIds: ["a"], records: [game("a", "上等马", 7.2, DAY.start + HOUR)] });
  const field = buildReportEmbed(lone, { final: true }).toJSON().fields!.find((entry) => entry.name === "单局之最")!;
  assert.equal(field.value.split("\n").length, 1);
  assert.ok(!field.value.includes("最佳") && !field.value.includes("最差"), field.value);
  assert.match(field.value, /^唯一一局：<@a>/);

  const two = buildReportData({ kind: "day", range: DAY, mock: false, memberIds: ["a"], records: [game("a", "上等马", 7.2, DAY.start + HOUR), game("a", "下等马", 3, DAY.start + 2 * HOUR)] });
  const both = buildReportEmbed(two, { final: true }).toJSON().fields!.find((entry) => entry.name === "单局之最")!;
  assert.equal(both.value.split("\n").length, 2);
});
