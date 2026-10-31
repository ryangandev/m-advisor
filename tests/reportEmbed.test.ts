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

function bottomField(data: ReturnType<typeof buildReportData>) {
  const fields = buildReportEmbed(data, { final: true }).toJSON().fields!;
  return fields.find((field) => field.name.startsWith("🪦") || field.name.includes("垫底"))!;
}

test("a bottom member who still averaged well is 相对垫底, not roasted as 没有马", () => {
  // Both averages are high: bob only has the lower of two good scores, and his worst game was a 上等马.
  const data = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [game("alice", "特等马", 9, DAY.start + HOUR), game("bob", "上等马", 7.8, DAY.start + 2 * HOUR)],
  });
  assert.deepEqual(data.noneHorses.map((member) => member.discordUserId), ["bob"], "the data still names the bottom member");
  const field = bottomField(data);
  assert.ok(!field.name.includes("没有马"), field.name);
  assert.match(field.name, /垫底/);
  assert.match(field.value, /^<@bob>：当日 1 局均分 7\.8，在车队里排最后/);
  assert.doesNotMatch(field.value, /只有|只拿|脸红|知耻|训练模式|罚抄|木桩|败军/, "no harsh roast words");
  assert.ok(!field.value.includes("\u2014"));
  // Deterministic: the same report always reads the same.
  assert.equal(bottomField(data).value, field.value);
});

test("an average of 6.0 or more is relative whatever tier the worst game was", () => {
  const records = [
    ...games("a", "特等马", 9, 3, WEEK.start + HOUR),
    ...games("b", "中等马", 6, 3, WEEK.start + 5 * HOUR),
  ];
  const data = buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b"], records });
  assert.match(bottomField(data).name, /垫底/, "a 6.0 average is only relatively last");
  assert.match(bottomField(data).value, /相对垫底|只是相对|不低/);
});

test("a genuinely bad bottom member keeps the harsh 没有马 closing, in a day and a week", () => {
  for (const kind of ["day", "week"] as const) {
    const data = twoMemberData(kind);
    const field = bottomField(data);
    assert.match(field.name, /^🪦 .*没有马$/);
    assert.match(field.value, /均分只有 1\.0/);
    assert.match(field.value, /军师|兵法|训练模式|罚抄|木桩|脸红|知耻|败军/);
  }
  // Just under the line, with a worst game that is no good, is still harsh.
  const near = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b"],
    records: [game("a", "特等马", 9, DAY.start + HOUR), game("b", "中等马", 5.9, DAY.start + 2 * HOUR)],
  });
  assert.match(bottomField(near).name, /没有马/);
  // A worst game that was a 特等马 or 上等马 is relative even under 6.0 (tiers come from the team ranking, not the score).
  const strongWorst = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b"],
    records: [game("a", "特等马", 9, DAY.start + HOUR), game("b", "上等马", 5.2, DAY.start + 2 * HOUR)],
  });
  assert.match(bottomField(strongWorst).name, /垫底/);
});

test("tied bottom members are softened only when all of them are relative", () => {
  const records = [
    ...games("a", "特等马", 9, 3, WEEK.start + HOUR),
    ...games("b", "上等马", 7, 3, WEEK.start + 5 * HOUR),
    ...games("c", "上等马", 7, 3, WEEK.start + 9 * HOUR),
  ];
  const soft = bottomField(buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b", "c"], records }));
  assert.match(soft.value, /^<@b>、<@c> 并列相对垫底：当周各自均分都是 7\.0/);
  const harsh = bottomField(buildReportData({
    kind: "week", range: WEEK, mock: false, memberIds: ["a", "b", "c"],
    records: [...games("a", "特等马", 9, 3, WEEK.start + HOUR), ...games("b", "没有马", 1, 3, WEEK.start + 5 * HOUR), ...games("c", "没有马", 1, 3, WEEK.start + 9 * HOUR)],
  }));
  assert.match(harsh.value, /^<@b>、<@c> 并列：当周各自均分都只有 1\.0/);
});

test("a relative bottom with a low printed average never claims a good score, whatever the seed", () => {
  const SCORE_PRAISE = /分数不低|水准都不低|其实打得不差/;
  for (let day = 0; day < 12; day++) {
    const range = pacificDay(DAY.start + day * 24 * HOUR);
    // bob's worst game was a 上等马 but his average is 4.0.
    const low = buildReportData({
      kind: "day", range, mock: false, memberIds: ["alice", "bob"],
      records: [game("alice", "特等马", 9, range.start + HOUR), game("bob", "上等马", 4, range.start + 2 * HOUR)],
    });
    const field = bottomField(low);
    assert.match(field.name, /^🐢 .*垫底（相对）$/, "a neutral icon, not a tier icon");
    assert.doesNotMatch(field.value, SCORE_PRAISE, field.value);
    assert.match(field.value, /队内排名不差|相对垫底|只是相对|不扣分/);
    const tie = buildReportData({
      kind: "week", range: pacificWeek(range.start), mock: false, memberIds: ["a", "b", "c"],
      records: [...games("a", "特等马", 9, 3, range.start + HOUR), ...games("b", "上等马", 4, 3, range.start + 5 * HOUR), ...games("c", "上等马", 4, 3, range.start + 9 * HOUR)],
    });
    assert.doesNotMatch(bottomField(tie).value, SCORE_PRAISE, bottomField(tie).value);
    // A good printed average may still say so.
    const good = buildReportData({
      kind: "day", range, mock: false, memberIds: ["alice", "bob"],
      records: [game("alice", "特等马", 9, range.start + HOUR), game("bob", "上等马", 7.8, range.start + 2 * HOUR)],
    });
    assert.doesNotMatch(bottomField(good).value, /队内排名不差/);
  }
});

test("a member with exactly one game gets 那一把是, and several games keep the lowest-game wording", () => {
  const soft = bottomField(buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [game("alice", "特等马", 9, DAY.start + HOUR), game("bob", "上等马", 7.8, DAY.start + 2 * HOUR)],
  }));
  assert.match(soft.value, /，那一把是.* \d+\/\d+\/\d+，7\.8 分/);
  assert.doesNotMatch(soft.value, /最低的是/);
  const harsh = bottomField(twoMemberData("day"));
  assert.match(harsh.value, /，那一把是.* \d+\/\d+\/\d+，只拿 1\.0 分/);
  assert.doesNotMatch(harsh.value, /最难看的是/);

  const several = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [game("alice", "特等马", 9, DAY.start + HOUR), game("bob", "没有马", 1, DAY.start + 2 * HOUR), game("bob", "没有马", 2, DAY.start + 3 * HOUR)],
  });
  assert.match(bottomField(several).value, /最难看的是/);
  const softSeveral = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [game("alice", "特等马", 9, DAY.start + HOUR), game("bob", "上等马", 7.8, DAY.start + 2 * HOUR), game("bob", "上等马", 7.6, DAY.start + 3 * HOUR)],
  });
  assert.match(bottomField(softSeveral).value, /最低的是/);
});

test("members with equal printed averages share the same medal, then the next place skips", () => {
  const data = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["a", "b", "c", "d"],
    // a and b both print 8.3; c is third, d is fourth.
    records: [game("a", "特等马", 8.34, DAY.start + HOUR), game("b", "特等马", 8.26, DAY.start + 2 * HOUR), game("c", "中等马", 5, DAY.start + 3 * HOUR), game("d", "没有马", 1, DAY.start + 4 * HOUR)],
  });
  const board = buildReportEmbed(data, { final: true }).toJSON().fields![0].value.split("\n");
  assert.equal(board.length, 4);
  assert.ok(board[0].startsWith("🥇 ") && board[1].startsWith("🥇 "), board.join("\n"));
  assert.ok(board[2].startsWith("🥉 "), "the next place is 3rd after two share 1st");
  assert.ok(board[3].startsWith("4. "));
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

function topField(data: ReturnType<typeof buildReportData>): string {
  return buildReportEmbed(data, { final: true }).toJSON().fields!.find((field) => field.name.startsWith("👑"))!.value;
}

test("a one-game 特等马 is talked about as that one game, not as the brightest of several", () => {
  const data = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [game("alice", "特等马", 9, DAY.start + HOUR), game("bob", "下等马", 3, DAY.start + 2 * HOUR)],
  });
  const text = topField(data);
  assert.match(text, /^<@alice>：当日 1 局均分 9\.0，那一把是.+ \d+\/\d+\/\d+，拿下 9\.0 分/);
  assert.doesNotMatch(text, /最亮眼/);
  assert.equal(topField(data), text, "deterministic");
  const many = buildReportData({
    kind: "day", range: DAY, mock: false, memberIds: ["alice", "bob"],
    records: [...games("alice", "特等马", 9, 2, DAY.start + HOUR), game("bob", "下等马", 3, DAY.start + 6 * HOUR)],
  });
  assert.match(topField(many), /^<@alice>：当日 2 局均分 9\.0，最亮眼的是.+那把/);
});

test("双雄 is only said of exactly two tied members", () => {
  const closings = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const [a, b, c] = [`a${index}`, "b", "c"];
    const trio = buildReportData({
      kind: "week", range: WEEK, mock: false, memberIds: [a, b, c, "z"],
      records: [...games(a, "特等马", 8, 3, WEEK.start + HOUR), ...games(b, "特等马", 8, 3, WEEK.start + 5 * HOUR), ...games(c, "特等马", 8, 3, WEEK.start + 9 * HOUR), ...games("z", "没有马", 1, 3, WEEK.start + 13 * HOUR)],
    });
    assert.equal(trio.topHorses.length, 3);
    assert.doesNotMatch(topField(trio), /双雄/, `trio ${index}`);
    const duo = buildReportData({
      kind: "week", range: WEEK, mock: false, memberIds: [a, b, "z"],
      records: [...games(a, "特等马", 8, 3, WEEK.start + HOUR), ...games(b, "特等马", 8, 3, WEEK.start + 5 * HOUR), ...games("z", "没有马", 1, 3, WEEK.start + 13 * HOUR)],
    });
    assert.equal(duo.topHorses.length, 2);
    closings.add(topField(duo).includes("双雄") ? "双雄" : "plain");
  }
  assert.deepEqual([...closings].sort(), ["plain", "双雄"], "a pair can still draw either closing");
});

test("a week or day where nobody reached the game bar says so plainly instead of counting zero", () => {
  const week = buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b"], records: [...games("a", "特等马", 9, 2, WEEK.start + HOUR), ...games("b", "没有马", 1, 1, WEEK.start + 9 * HOUR)] });
  assert.equal(week.members.filter((member) => member.qualified).length, 0);
  const weekText = allText(buildReportEmbed(week, { final: true }));
  assert.match(weekText, /当周还没有人满 3 局，这次不评。/);
  assert.doesNotMatch(weekText, /0 位参评/);
  assert.match(allText(buildReportEmbed(week, { final: false })), /本周还没有人满 3 局，这次不评。/);
  // Exactly one qualified member keeps the existing sentence.
  const one = buildReportData({ kind: "week", range: WEEK, mock: false, memberIds: ["a", "b"], records: [...games("a", "特等马", 9, 3, WEEK.start + HOUR), ...games("b", "没有马", 1, 1, WEEK.start + 9 * HOUR)] });
  assert.match(allText(buildReportEmbed(one, { final: true })), /当周满 3 局的只有 1 位参评，至少要两位才分得出高下，这次不评。/);
});
