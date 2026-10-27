import assert from "node:assert/strict";
import { test } from "node:test";
import { COLD_START_LINE, MAX_PREGAME_SPEECH_CHARACTERS, OTHER_SIDE_NOTE, buildPregameBrief } from "../src/services/pregameBrief";
import type { PregameBrief, PregameBriefInput, PregameTeammate } from "../src/services/pregameBrief";
import type { HorseTier } from "../src/services/horseRanking";
import type { HorseRecord } from "../src/store/horseRecordStore";
import { buildPregameEmbed, pregameAllowedMentions, pregameMentionContent } from "../src/utils/pregameEmbed";
import { makeHorseRecord } from "./helpers/horseRecords";

const SCORE: Record<HorseTier, number> = { 特等马: 9, 上等马: 7, 中等马: 5, 下等马: 3, 没有马: 1 };
const AHRI = 103;
const LUX = 99;
const ASHE = 22;
const GAREN = 86;
const ZED = 238;
const ENEMY_JINX = 222;
const ENEMY_YASUO = 157;
const BASE_TIME = 1_800_000_000_000;

/** Oldest first: one record per tier, with the score that tier would have. */
function history(memberId: string, tiers: readonly HorseTier[], overrides: Partial<HorseRecord> = {}): HorseRecord[] {
  return tiers.map((tier, index) => makeHorseRecord({
    discordUserId: memberId,
    matchId: `NA1_${memberId}_${index}`,
    playedAt: BASE_TIME + index * 3_600_000,
    tier,
    score: SCORE[tier],
    ...overrides,
  }));
}

function mate(memberId: string, name: string, championId: number, records: readonly HorseRecord[] = [], smite = false): PregameTeammate {
  return { memberId, name, championId, smite, records };
}

function brief(teammates: readonly PregameTeammate[], overrides: Partial<PregameBriefInput> = {}): PregameBrief {
  return buildPregameBrief({ matchId: "NA1_1000", mock: false, teammates, strangerCount: 2, otherSideHasFriend: false, ...overrides });
}

const embedJson = (value: PregameBrief) => JSON.stringify(buildPregameEmbed(value).toJSON());
const sentences = (speech: string) => speech.split(/[。！？；…]+/u).filter((part) => part.trim().length > 0);

/** Two players who are doing well and badly, the shape most tests start from. */
function pair(): PregameTeammate[] {
  return [
    mate("m-hot", "Hotman", AHRI, history("m-hot", ["中等马", "上等马", "上等马", "特等马", "特等马"])),
    mate("m-cold", "Coldman", LUX, history("m-cold", ["中等马", "下等马", "下等马", "没有马", "没有马"])),
  ];
}

interface LobbyPlayer { puuid: string; name: string; teamId: number; championId: number; memberId: string | null; bot?: boolean }

/** What the monitor will do in PR D: only bound members on the perspective team reach the builder. */
function monitorView(lobby: readonly LobbyPlayer[], teamId: number, recordsOf: (memberId: string) => HorseRecord[]) {
  const ours = lobby.filter((player) => player.teamId === teamId);
  return {
    teammates: ours.filter((player) => player.memberId).map((player) => mate(player.memberId!, player.name, player.championId, recordsOf(player.memberId!))),
    strangerCount: ours.filter((player) => !player.memberId && !player.bot).length,
    otherSideHasFriend: lobby.some((player) => player.teamId !== teamId && player.memberId),
  };
}

const LOBBY: LobbyPlayer[] = [
  { puuid: "puuid-ally-1", name: "AllyOne", teamId: 100, championId: AHRI, memberId: "m-hot" },
  { puuid: "puuid-ally-2", name: "AllyTwo", teamId: 100, championId: LUX, memberId: "m-cold" },
  { puuid: "puuid-stranger-1", name: "StrangerOne", teamId: 100, championId: ASHE, memberId: null },
  { puuid: "puuid-stranger-2", name: "StrangerTwo", teamId: 100, championId: GAREN, memberId: null },
  { puuid: "puuid-stranger-3", name: "StrangerThree", teamId: 100, championId: ZED, memberId: null },
  { puuid: "puuid-enemy-1", name: "EnemyOne", teamId: 200, championId: ENEMY_JINX, memberId: null },
  { puuid: "puuid-enemy-2", name: "EnemyTwo", teamId: 200, championId: ENEMY_YASUO, memberId: null },
  { puuid: "puuid-enemy-friend", name: "FriendOnTheOtherSide", teamId: 200, championId: 64, memberId: "m-other" },
  { puuid: "puuid-enemy-4", name: "EnemyFour", teamId: 200, championId: 412, memberId: null },
  { puuid: "puuid-enemy-5", name: "EnemyFive", teamId: 200, championId: 18, memberId: null },
];

const RECORDS: Record<string, HorseRecord[]> = {
  "m-hot": history("m-hot", ["中等马", "上等马", "特等马", "特等马"]),
  "m-cold": history("m-cold", ["上等马", "下等马", "没有马", "没有马"]),
  "m-other": history("m-other", ["特等马", "特等马", "特等马"]),
};

test("nothing about enemies, strangers or the friend on the other side reaches the speech or the card", () => {
  const view = monitorView(LOBBY, 100, (memberId) => RECORDS[memberId]);
  const result = brief(view.teammates, { strangerCount: view.strangerCount, otherSideHasFriend: view.otherSideHasFriend });
  const everything = `${result.speech}\n${JSON.stringify(result)}\n${embedJson(result)}`;
  for (const secret of [
    "puuid-", "Stranger", "EnemyOne", "EnemyTwo", "EnemyFour", "EnemyFive", "FriendOnTheOtherSide", "m-other",
    "金克丝", "亚索", "李青", "锤石", "崔丝塔娜", // the enemy champions
    "艾希", "盖伦", "劫", // the strangers' champions
  ]) assert.ok(!everything.includes(secret), `${secret} must not appear`);
  assert.deepEqual(view.teammates.map((teammate) => teammate.memberId), ["m-hot", "m-cold"]);
  // The members' own accounts never leave the records either.
  assert.ok(!everything.includes("account-a"));
});

test("strangers appear only as a count and an empty lobby says so", () => {
  const view = monitorView(LOBBY, 100, (memberId) => RECORDS[memberId]);
  assert.equal(view.strangerCount, 3);
  const three = buildPregameEmbed(brief(view.teammates, { strangerCount: 3 })).toJSON();
  assert.equal(three.footer?.text, "还有 3 位路人队友 · 对面不评");
  const none = buildPregameEmbed(brief(view.teammates, { strangerCount: 0 })).toJSON();
  assert.equal(none.footer?.text, "没有路人队友 · 对面不评");
  assert.equal(brief(view.teammates, { strangerCount: 3 }).strangerCount, 3);
});

test("an opposite-team friend is acknowledged without a name, a mention or a rating", () => {
  const view = monitorView(LOBBY, 100, (memberId) => RECORDS[memberId]);
  assert.equal(view.otherSideHasFriend, true);
  const result = brief(view.teammates, { otherSideHasFriend: true });
  const json = embedJson(result);
  assert.ok(json.includes(OTHER_SIDE_NOTE));
  assert.ok(!json.includes("m-other") && !result.speech.includes("对面"));
  assert.equal(result.lines.length, 2);
  const without = embedJson(brief(view.teammates, { otherSideHasFriend: false }));
  assert.ok(!without.includes(OTHER_SIDE_NOTE));
});

test("a team with no records at all is a cold start: nobody is rated and the order is generic", () => {
  const result = brief([mate("m-a", "Alpha", AHRI), mate("m-b", "Bravo", LUX)]);
  assert.equal(result.coldStart, true);
  assert.equal(result.pick, null);
  assert.equal(result.instruction.memberId, null);
  assert.ok(result.speech.startsWith(COLD_START_LINE));
  assert.ok(result.lines.every((line) => line.isNew && line.recentAverage === null && line.recentTiers.length === 0));
  const card = buildPregameEmbed(result).toJSON();
  assert.ok(card.description!.includes(COLD_START_LINE));
  assert.equal(card.description!.split("\n").filter((line) => line.includes("新马")).length, 2);
  assert.match(card.fields![0].value, /^暂无/);
  assert.equal(card.fields![0].name, "军师之选");
  assert.equal(card.fields![1].name, "军师指令");
});

test("a partial cold start rates the known and leaves the new horse unrated and unnamed in speech", () => {
  const [hot] = pair();
  const result = brief([mate("m-new", "Newcomer", ASHE), hot]);
  assert.equal(result.coldStart, false);
  assert.equal(result.pick?.memberId, "m-hot");
  const newcomer = result.lines.find((line) => line.memberId === "m-new")!;
  assert.equal(newcomer.isNew, true);
  assert.equal(newcomer.trend, null);
  assert.ok(!result.speech.includes("Newcomer"));
  const lines = buildPregameEmbed(result).toJSON().description!.split("\n");
  assert.match(lines.find((line) => line.includes("m-new"))!, /新马/);
  assert.doesNotMatch(lines.find((line) => line.includes("m-hot"))!, /新马/);
});

test("the same game always gets the same brief, and different games vary", () => {
  const first = brief(pair());
  const second = brief(pair());
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(buildPregameEmbed(first).toJSON()), JSON.stringify(buildPregameEmbed(second).toJSON()));
  const speeches = new Set<string>();
  for (let game = 0; game < 30; game += 1) speeches.add(brief(pair(), { matchId: `NA1_${2000 + game}` }).speech);
  assert.ok(speeches.size >= 3, "the copy varies between games");
  // Records may arrive in any order.
  const shuffled = pair().map((teammate) => ({ ...teammate, records: [...teammate.records].reverse() }));
  assert.deepEqual(brief(shuffled), first);
});

test("the pick is the teammate in the best form, and bind order breaks ties", () => {
  const result = brief(pair());
  assert.equal(result.pick?.memberId, "m-hot");
  assert.equal(result.pick?.name, "Hotman");
  const tiers: HorseTier[] = ["上等马", "上等马", "上等马", "上等马", "上等马"];
  const tie = brief([mate("m-a", "Alpha", AHRI, history("m-a", tiers)), mate("m-b", "Bravo", LUX, history("m-b", tiers))]);
  assert.equal(tie.pick?.memberId, "m-a");
  const reversed = brief([mate("m-b", "Bravo", LUX, history("m-b", tiers)), mate("m-a", "Alpha", AHRI, history("m-a", tiers))]);
  assert.equal(reversed.pick?.memberId, "m-b");
});

test("being a regular 特等马 on this champion can outweigh an equal form", () => {
  const steady = mate("m-steady", "Steady", LUX, history("m-steady", ["上等马", "上等马", "上等马", "上等马", "上等马"]));
  const tiers: HorseTier[] = ["特等马", "特等马", "下等马", "上等马", "上等马"];
  const elsewhere = mate("m-main", "Mainer", AHRI, history("m-main", tiers, { championId: ZED }));
  assert.equal(brief([steady, elsewhere]).pick?.memberId, "m-steady", "equal form, bind order decides");
  const onChampion = mate("m-main", "Mainer", AHRI, history("m-main", tiers, { championId: AHRI }));
  const result = brief([steady, onChampion]);
  assert.equal(result.pick?.memberId, "m-main");
  assert.equal(result.pick?.reason, "这英雄是看家马");
  const twoGames = mate("m-main", "Mainer", AHRI, [...history("m-main", tiers.slice(0, 3), { championId: ZED }), ...history("m-main", ["特等马", "特等马"], { championId: AHRI, matchId: "NA1_x" }).map((record, index) => ({ ...record, matchId: `NA1_x${index}`, playedAt: BASE_TIME + 10_000_000 + index }))]);
  assert.equal(twoGames.records.filter((record) => record.championId === AHRI).length, 2);
  assert.notEqual(brief([twoGames]).pick?.reason, "这英雄是看家马", "two games on the champion are too few for a bonus");
});

test("the instruction targets the member whose champion keeps ending as 没有马", () => {
  const bad = mate("m-bad", "Badchamp", ZED, history("m-bad", ["上等马", "没有马", "上等马", "没有马", "中等马"], { championId: ZED }));
  const hotOne = mate("m-hot", "Hotman", AHRI, history("m-hot", ["上等马", "特等马", "特等马", "特等马", "特等马"]));
  const coldOne = mate("m-cold", "Coldman", LUX, history("m-cold", ["中等马", "下等马", "没有马", "没有马", "没有马"]));
  const result = brief([hotOne, coldOne, bad]);
  assert.equal(result.instruction.memberId, "m-bad", "a champion that keeps failing outranks a cold run");
  assert.ok(result.instruction.text.includes("<@m-bad>"));
  assert.ok(result.instruction.text.includes("劫"));
  assert.ok(result.speech.includes("Badchamp"));
  assert.ok(result.speech.includes("劫"));
  const card = buildPregameEmbed(result).toJSON();
  assert.ok(card.fields![1].value.includes("<@m-bad>"));
});

test("without a failing champion the instruction aims at the coldest run, then a falling form, then the pick", () => {
  const cold = brief(pair());
  assert.equal(cold.instruction.memberId, "m-cold");
  assert.ok(cold.speech.includes("Coldman"));

  const falling = mate("m-fall", "Faller", LUX, history("m-fall", ["特等马", "特等马", "上等马", "上等马", "上等马", "中等马", "下等马", "中等马"]));
  const steady = mate("m-steady", "Steady", AHRI, history("m-steady", ["中等马", "中等马", "中等马", "中等马", "中等马"]));
  const down = brief([steady, falling]);
  assert.equal(down.lines[1].trend, "down");
  assert.equal(down.instruction.memberId, "m-fall");

  const fine = brief([mate("m-a", "Alpha", AHRI, history("m-a", ["上等马", "中等马", "上等马", "中等马", "上等马"])), steady]);
  assert.equal(fine.instruction.memberId, "m-a", "an order to the pick when nothing is wrong");
  assert.equal(fine.instruction.memberId, fine.pick?.memberId);
});

test("signals: streaks, trend arrows, champion record and position show on the card", () => {
  const pairs = pair();
  const hotRecords = history("m-hot", ["下等马", "中等马", "中等马", "下等马", "没有马", "上等马", "上等马", "特等马", "特等马", "特等马"]);
  const result = brief([mate("m-hot", "Hotman", AHRI, hotRecords, true), pairs[1]]);
  const [hot, cold] = result.lines;
  assert.equal(hot.hotStreak, 3);
  assert.equal(hot.trend, "up");
  assert.equal(hot.position, "JUNGLE", "Smite means jungle");
  assert.equal(cold.coldStreak, 2);
  assert.equal(cold.trend, null, "five games leave nothing to compare against");
  const lines = buildPregameEmbed(result).toJSON().description!.split("\n");
  assert.ok(lines[0].startsWith("<@m-hot> · 阿狸 · 👑👑👑🐎🐎 · 近5局均 8.2 ↑（前5局 3.4）"), lines[0]);
  assert.ok(lines[0].includes("↑"));
  assert.ok(lines[0].includes("🔥 连3局特等马"));
  assert.ok(lines[0].includes("打野"));
  assert.ok(lines[0].includes("这英雄 10 局"));
  assert.ok(lines[1].includes("🥶 连2局没有马"));
  assert.ok(!lines[1].includes("↑") && !lines[1].includes("↓"));

  const single = brief([mate("m-one", "Solo", AHRI, [...history("m-one", ["上等马", "上等马", "上等马", "上等马"], { championId: ZED }), ...history("m-one", ["特等马"], { championId: AHRI, matchId: "NA1_other" })])]);
  assert.equal(single.lines[0].championRecord, null, "one game on the champion is not a record");
  assert.ok(!buildPregameEmbed(single).toJSON().description!.includes("这英雄"));
});

/** Oldest first, each game with the given score. */
function scored(memberId: string, scores: readonly number[]): HorseRecord[] {
  return history(memberId, scores.map(() => "中等马" as HorseTier)).map((record, index) => ({ ...record, score: scores[index] }));
}

test("the trend needs three games on both sides and a full point of difference", () => {
  const trendOf = (scores: number[]) => brief([mate("m-a", "Alpha", AHRI, scored("m-a", scores))]).lines[0];
  assert.equal(trendOf([5, 5, 5, 5, 5, 5, 5, 5, 5, 6]).trend, "flat");
  assert.equal(trendOf([5, 5, 5, 5, 5, 6, 6, 6, 6, 6]).trend, "up", "exactly +1.0 counts");
  assert.equal(trendOf([6, 6, 6, 6, 6, 5, 5, 5, 5, 5]).trend, "down", "exactly -1.0 counts");
  assert.equal(trendOf([6, 6, 6, 6, 6, 5.1, 5.1, 5.1, 5.1, 5.1]).trend, "flat");
  const sparse = trendOf([1, 1, 9, 9, 9, 9, 9]);
  assert.equal(sparse.trend, null, "two games before the last five are too few");
  const measured = trendOf([5, 5, 5, 5, 5, 7, 7, 5, 5, 5]);
  assert.equal(measured.previousAverage, 5);
  assert.equal(measured.recentAverage, 5.8);
});

test("only the latest ten games set the form", () => {
  const old = history("m-a", Array.from({ length: 30 }, () => "没有马" as HorseTier));
  const fresh = history("m-a", ["上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马"]).map((record, index) => ({ ...record, matchId: `NA1_fresh_${index}`, playedAt: BASE_TIME + 200_000_000 + index }));
  const result = brief([mate("m-a", "Alpha", AHRI, [...old, ...fresh])]);
  assert.equal(result.lines[0].coldStreak, 0);
  assert.equal(result.lines[0].recentAverage, 7);
});

test("mock briefs carry the label in the speech, the title and the footer, real ones carry none", () => {
  const mock = buildPregameBrief({ matchId: "MOCK_1", mock: true, teammates: pair().map((teammate) => ({ ...teammate, records: teammate.records.map((record) => ({ ...record, mock: true })) })), strangerCount: 1, otherSideHasFriend: false });
  assert.ok(mock.speech.startsWith("模拟锦囊，"));
  const card = buildPregameEmbed(mock).toJSON();
  assert.equal(card.title, "模拟数据 · 军师赛前锦囊");
  assert.ok(card.footer!.text.includes("模拟数据"));
  const real = brief(pair());
  const realCard = buildPregameEmbed(real).toJSON();
  assert.equal(realCard.title, "军师赛前锦囊");
  assert.ok(!real.speech.includes("模拟") && !realCard.footer!.text.includes("模拟"));
  const coldMock = buildPregameBrief({ matchId: "MOCK_2", mock: true, teammates: [mate("m-a", "Alpha", AHRI)], strangerCount: 0, otherSideHasFriend: false });
  assert.ok(coldMock.speech.startsWith("模拟锦囊，" + COLD_START_LINE));
});

test("the speech is at most two sentences and 75 characters, even with 32-character names", () => {
  const long = (letter: string) => `${letter}`.repeat(32);
  const worst: PregameBrief[] = [];
  for (const mock of [false, true]) {
    const records = (memberId: string, tiers: HorseTier[], extra: Partial<HorseRecord> = {}) => history(memberId, tiers, { mock, ...extra });
    const names = [long("甲"), long("B"), "a.b!c?d。e；f…g"];
    for (const matchId of ["NA1_1", "NA1_2", "NA1_3", "NA1_4", "NA1_5", "MOCK_9"]) {
      worst.push(buildPregameBrief({
        matchId, mock, strangerCount: 4, otherSideHasFriend: true,
        teammates: [
          mate("m-a", names[0], ZED, records("m-a", ["没有马", "没有马", "没有马", "上等马", "特等马"], { championId: ZED })),
          mate("m-b", names[1], AHRI, records("m-b", ["特等马", "特等马", "特等马", "特等马", "特等马"])),
          mate("m-c", names[2], LUX, records("m-c", ["中等马", "下等马", "没有马", "没有马", "没有马"])),
        ],
      }));
      worst.push(buildPregameBrief({ matchId, mock, strangerCount: 0, otherSideHasFriend: false, teammates: [mate("m-a", names[0], AHRI), mate("m-b", names[1], LUX)] }));
      worst.push(buildPregameBrief({ matchId, mock, strangerCount: 0, otherSideHasFriend: false, teammates: [mate("m-a", names[0], AHRI, records("m-a", ["上等马", "中等马", "上等马", "中等马", "上等马"]))] }));
    }
  }
  for (const result of worst) {
    assert.ok(result.speech.length <= MAX_PREGAME_SPEECH_CHARACTERS, `${result.speech.length}: ${result.speech}`);
    assert.ok(sentences(result.speech).length <= 2, result.speech);
    assert.ok(sentences(result.speech).length >= 1);
    assert.doesNotMatch(result.speech, /[@<>`*_~|\\\n]/u, "speech has no markup or mention text");
    assert.doesNotMatch(result.speech, /undefined|null|NaN/);
  }
  assert.equal(MAX_PREGAME_SPEECH_CHARACTERS, 75);
});

test("a roomy game keeps the full names and the form phrase", () => {
  const result = brief(pair());
  assert.match(result.speech, /Hotman/);
  assert.ok(result.speech.includes(`，${result.pick!.reason}。`));
  assert.equal(sentences(result.speech).length, 2);
  assert.ok(result.speech.length <= 75);
});

test("mixed mock and real records are refused", () => {
  const [hot, cold] = pair();
  const mockRecords = hot.records.map((record) => ({ ...record, mock: true }));
  assert.throws(() => brief([{ ...hot, records: mockRecords }, cold]), /mock and real/i);
  assert.throws(() => buildPregameBrief({ matchId: "MOCK_1", mock: true, teammates: [hot], strangerCount: 0, otherSideHasFriend: false }), /mock and real/i);
  assert.throws(() => brief([{ ...hot, records: [...hot.records, ...mockRecords.slice(0, 1)] }]), /mock and real/i);
});

test("a teammate may only carry their own records, and bad input is refused", () => {
  const [hot, cold] = pair();
  assert.throws(() => brief([{ ...hot, records: cold.records }]), /own horse records/);
  assert.throws(() => brief([]), /at least one/);
  assert.throws(() => brief(pair(), { strangerCount: -1 }), /strangerCount/);
  assert.throws(() => brief(pair(), { matchId: " " }), /match ID/);
});

test("names cannot turn into mentions and the allowed mentions name exactly the given members", () => {
  const sneaky = mate("m-a", "@everyone <@123> `x`", AHRI, history("m-a", ["特等马", "特等马", "特等马"]));
  const result = brief([sneaky]);
  assert.doesNotMatch(result.speech, /[@<>`]/);
  assert.equal(result.lines[0].name.includes("@"), false);
  assert.deepEqual(pregameAllowedMentions(["1", "2", "1"]), { parse: [], roles: [], users: ["1", "2"], repliedUser: false });
  assert.deepEqual(pregameAllowedMentions([]), { parse: [], roles: [], users: [], repliedUser: false });
  assert.equal(pregameMentionContent(["1", "2", "1"]), "<@1> <@2>");
  assert.equal(pregameMentionContent([]), "");
});

test("the card stays inside Discord's limits and nothing in it uses an em dash", () => {
  const long = "乙".repeat(32);
  const cards = [
    brief(pair()),
    brief([mate("m-a", long, AHRI), mate("m-b", long, LUX), mate("m-c", long, ZED), mate("m-d", long, ASHE), mate("m-e", long, GAREN)]),
    brief(Array.from({ length: 5 }, (_, index) => mate(`m-${index}`, long, AHRI, history(`m-${index}`, Array.from({ length: 12 }, (__, game) => (game % 2 ? "特等马" : "没有马") as HorseTier))))),
  ];
  for (const result of cards) {
    const card = buildPregameEmbed(result).toJSON();
    assert.ok((card.description ?? "").length <= 4096);
    for (const field of card.fields ?? []) assert.ok(field.value.length <= 1024 && field.name.length <= 256);
    assert.ok((card.footer?.text.length ?? 0) <= 2048);
    assert.ok(!JSON.stringify(card).includes("—") && !result.speech.includes("—"));
  }
});
