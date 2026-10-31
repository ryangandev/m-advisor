import assert from "node:assert/strict";
import { test } from "node:test";
import { COLD_START_LINE, MAX_PREGAME_SPEECH_CHARACTERS, NO_PICK_LINE, OTHER_SIDE_NOTE, buildPregameBrief } from "../src/services/pregameBrief";
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
const id = (n: number) => `1000000000000000${String(n).padStart(2, "0")}`;
/** Discord-looking user IDs: the builder refuses anything else. */
const ID = {
  hot: id(1), cold: id(2), other: id(3), a: id(4), b: id(5), c: id(6), d: id(7), e: id(8),
  new: id(9), bad: id(10), steady: id(11), fall: id(12), main: id(13), one: id(14),
};

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
  return { memberId, storedGameName: name, championId, smite, records };
}

function brief(teammates: readonly PregameTeammate[], overrides: Partial<PregameBriefInput> = {}): PregameBrief {
  return buildPregameBrief({ matchId: "NA1_1000", mock: false, teammates, strangerCount: 2, otherSideHasFriend: false, ...overrides });
}

const embedJson = (value: PregameBrief) => JSON.stringify(buildPregameEmbed(value).toJSON());
const sentences = (speech: string) => speech.split(/[。！？；…]+/u).filter((part) => part.trim().length > 0);

/** Two players who are doing well and badly, the shape most tests start from. */
function pair(): PregameTeammate[] {
  return [
    mate(ID.hot, "Hotman", AHRI, history(ID.hot, ["中等马", "上等马", "上等马", "特等马", "特等马"])),
    mate(ID.cold, "Coldman", LUX, history(ID.cold, ["中等马", "下等马", "下等马", "没有马", "没有马"])),
  ];
}

interface LobbyPlayer { puuid: string; name: string; teamId: number; championId: number; memberId: string | null; bot?: boolean }

/**
 * What the monitor will do in PR D: only bound members on the perspective team reach the builder.
 * This adapter models that filter, so PR D must restate these assertions against the real monitor.
 */
function monitorView(lobby: readonly LobbyPlayer[], teamId: number, recordsOf: (memberId: string) => HorseRecord[]) {
  const ours = lobby.filter((player) => player.teamId === teamId);
  return {
    teammates: ours.filter((player) => player.memberId).map((player) => mate(player.memberId!, player.name, player.championId, recordsOf(player.memberId!))),
    strangerCount: ours.filter((player) => !player.memberId && !player.bot).length,
    otherSideHasFriend: lobby.some((player) => player.teamId !== teamId && player.memberId),
  };
}

const LOBBY: LobbyPlayer[] = [
  { puuid: "puuid-ally-1", name: "AllyOne", teamId: 100, championId: AHRI, memberId: ID.hot },
  { puuid: "puuid-ally-2", name: "AllyTwo", teamId: 100, championId: LUX, memberId: ID.cold },
  { puuid: "puuid-stranger-1", name: "StrangerOne", teamId: 100, championId: ASHE, memberId: null },
  { puuid: "puuid-stranger-2", name: "StrangerTwo", teamId: 100, championId: GAREN, memberId: null },
  { puuid: "puuid-stranger-3", name: "StrangerThree", teamId: 100, championId: ZED, memberId: null },
  { puuid: "puuid-enemy-1", name: "EnemyOne", teamId: 200, championId: ENEMY_JINX, memberId: null },
  { puuid: "puuid-enemy-2", name: "EnemyTwo", teamId: 200, championId: ENEMY_YASUO, memberId: null },
  { puuid: "puuid-enemy-friend", name: "FriendOnTheOtherSide", teamId: 200, championId: 64, memberId: ID.other },
  { puuid: "puuid-enemy-4", name: "EnemyFour", teamId: 200, championId: 412, memberId: null },
  { puuid: "puuid-enemy-5", name: "EnemyFive", teamId: 200, championId: 18, memberId: null },
];

const RECORDS: Record<string, HorseRecord[]> = {
  [ID.hot]: history(ID.hot, ["中等马", "上等马", "特等马", "特等马"]),
  [ID.cold]: history(ID.cold, ["上等马", "下等马", "没有马", "没有马"]),
  [ID.other]: history(ID.other, ["特等马", "特等马", "特等马"]),
};

test("nothing about enemies, strangers or the friend on the other side reaches the speech or the card", () => {
  const view = monitorView(LOBBY, 100, (memberId) => RECORDS[memberId]);
  const result = brief(view.teammates, { strangerCount: view.strangerCount, otherSideHasFriend: view.otherSideHasFriend });
  const everything = `${result.speech}\n${JSON.stringify(result)}\n${embedJson(result)}`;
  for (const secret of [
    "puuid-", "Stranger", "EnemyOne", "EnemyTwo", "EnemyFour", "EnemyFive", "FriendOnTheOtherSide", ID.other,
    "金克丝", "亚索", "李青", "锤石", "崔丝塔娜", // the enemy champions
    "艾希", "盖伦", "劫", // the strangers' champions
  ]) assert.ok(!everything.includes(secret), `${secret} must not appear`);
  assert.deepEqual(view.teammates.map((teammate) => teammate.memberId), [ID.hot, ID.cold]);
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
  assert.ok(!json.includes(ID.other) && !result.speech.includes("对面"));
  assert.equal(result.lines.length, 2);
  const without = embedJson(brief(view.teammates, { otherSideHasFriend: false }));
  assert.ok(!without.includes(OTHER_SIDE_NOTE));
});

test("a team with no records at all is a cold start: nobody is rated and the order is generic", () => {
  const result = brief([mate(ID.a, "Alpha", AHRI), mate(ID.b, "Bravo", LUX)]);
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
  const result = brief([mate(ID.new, "Newcomer", ASHE), hot]);
  assert.equal(result.coldStart, false);
  assert.equal(result.pick?.memberId, ID.hot);
  const newcomer = result.lines.find((line) => line.memberId === ID.new)!;
  assert.equal(newcomer.isNew, true);
  assert.equal(newcomer.trend, null);
  assert.ok(!result.speech.includes("Newcomer"));
  const lines = buildPregameEmbed(result).toJSON().description!.split("\n");
  assert.match(lines.find((line) => line.includes(ID.new))!, /新马/);
  assert.doesNotMatch(lines.find((line) => line.includes(ID.hot))!, /新马/);
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
  assert.equal(result.pick?.memberId, ID.hot);
  assert.equal(result.pick?.name, "Hotman");
  const tiers: HorseTier[] = ["上等马", "上等马", "上等马", "上等马", "上等马"];
  const tie = brief([mate(ID.a, "Alpha", AHRI, history(ID.a, tiers)), mate(ID.b, "Bravo", LUX, history(ID.b, tiers))]);
  assert.equal(tie.pick?.memberId, ID.a);
  const reversed = brief([mate(ID.b, "Bravo", LUX, history(ID.b, tiers)), mate(ID.a, "Alpha", AHRI, history(ID.a, tiers))]);
  assert.equal(reversed.pick?.memberId, ID.b);
});

test("a signature champion can outweigh an equal form, and says so by name", () => {
  const steady = mate(ID.steady, "Steady", LUX, history(ID.steady, ["上等马", "上等马", "上等马", "上等马", "上等马"]));
  const tiers: HorseTier[] = ["特等马", "特等马", "特等马", "下等马", "没有马"];
  const elsewhere = mate(ID.main, "Mainer", AHRI, history(ID.main, tiers, { championId: ZED }));
  assert.equal(brief([steady, elsewhere]).pick?.memberId, ID.steady, "7.0 against 6.2 without the bonus");
  const onChampion = mate(ID.main, "Mainer", AHRI, history(ID.main, tiers, { championId: AHRI }));
  const result = brief([steady, onChampion]);
  assert.equal(result.pick?.memberId, ID.main);
  assert.equal(result.pick?.reason, "阿狸是他的拿手英雄");
  assert.ok(result.speech.includes("阿狸是他的拿手英雄"), "the champion is named, so the line makes sense heard alone");
  const twoGames = mate(ID.main, "Mainer", AHRI, [...history(ID.main, tiers.slice(0, 3), { championId: ZED }), ...history(ID.main, ["特等马", "特等马"], { championId: AHRI }).map((record, index) => ({ ...record, matchId: `NA1_x${index}`, playedAt: BASE_TIME + 10_000_000 + index }))]);
  assert.equal(twoGames.records.filter((record) => record.championId === AHRI).length, 2);
  assert.notEqual(brief([twoGames]).pick?.reason, "阿狸是他的拿手英雄", "two games on the champion are too few for a claim");
});

test("the 拿手 claim needs two 特等马, half of the games and more 特等马 than 没有马; the 翻车 claim never overlaps it", () => {
  const strong = mate(ID.steady, "Strong", LUX, history(ID.steady, ["上等马", "特等马", "特等马", "上等马", "特等马"]));
  const claim = (tiers: HorseTier[]) => {
    const subject = mate(ID.main, "Subject", AHRI, history(ID.main, tiers, { championId: AHRI }));
    const result = brief([strong, subject]);
    return { signature: result.pick?.memberId === ID.main && result.pick.reason.includes("拿手"), speech: result.speech, instruction: result.instruction, subject: result.lines[1] };
  };
  // 1 top, 2 none: the reviewer's case. No claim, and the member is the bad champion, never praised for it.
  const bad = claim(["特等马", "没有马", "没有马"]);
  assert.equal(bad.signature, false);
  assert.equal(bad.instruction.memberId, ID.main);
  assert.match(bad.instruction.text, /翻过好几次车|跑得不太顺/);
  assert.ok(!bad.speech.includes("拿手"));
  // 2 top, 2 none: exactly half but not more 特等马 than 没有马. No claim.
  const level = claim(["特等马", "没有马", "特等马", "没有马"]);
  assert.equal(level.signature, false);
  assert.equal(level.instruction.memberId, ID.main);
  // 2 top in 5 is under half. No claim, and 1 none is no bad champion either.
  const under = claim(["特等马", "中等马", "特等马", "上等马", "没有马"]);
  assert.equal(under.signature, false);
  assert.notEqual(under.instruction.memberId, ID.main);
  // 3 top, 2 none in 5: a signature champion, so it is not also a bad one.
  const mixed = brief([strong, mate(ID.main, "Subject", AHRI, history(ID.main, ["特等马", "没有马", "特等马", "没有马", "特等马"], { championId: AHRI }))]);
  assert.doesNotMatch(mixed.instruction.text, /翻过好几次车|跑得不太顺/);
  assert.notEqual(mixed.instruction.memberId, ID.main);
});

test("the pick is never the target of a negative instruction", () => {
  // The pick is the member with the failing champion; the next signal, B's cold run, takes the order.
  const failing = mate(ID.a, "Failing", AHRI, history(ID.a, ["特等马", "没有马", "没有马"], { championId: AHRI }));
  const cold = mate(ID.b, "Colder", LUX, history(ID.b, ["中等马", "下等马", "下等马", "没有马", "没有马"], { championId: ASHE }));
  for (let game = 0; game < 20; game += 1) {
    const result = brief([failing, cold], { matchId: `NA1_${3000 + game}` });
    assert.equal(result.pick?.memberId, ID.a, "3.7 against 2.2");
    assert.equal(result.instruction.memberId, ID.b);
    assert.doesNotMatch(result.speech, /翻过好几次车|跑得不太顺/);
    assert.ok(!result.speech.includes("拿手"));
  }
  // With no other signal the order goes to the pick, in praise.
  const calm = mate(ID.b, "Calm", LUX, history(ID.b, ["下等马", "下等马", "下等马"], { championId: LUX }));
  const alone = brief([failing, calm]);
  assert.equal(alone.pick?.memberId, ID.a);
  assert.equal(alone.instruction.memberId, ID.a);
  assert.doesNotMatch(alone.instruction.text, /翻过好几次车|跑得不太顺/);
  // The same holds for a pick on a cold run or a falling form, which is checked by the order of the checks.
  const sole = brief([mate(ID.a, "Solo", AHRI, history(ID.a, ["上等马", "没有马", "没有马"], { championId: AHRI }))]);
  assert.equal(sole.pick?.memberId, ID.a);
  assert.doesNotMatch(sole.instruction.text, /连着没跑出来|状态低迷|翻过好几次车|跑得不太顺/);
});

test("军师之选 needs three recorded games: a rookie never beats a veteran", () => {
  const vet = mate(ID.a, "Vet", AHRI, history(ID.a, ["上等马", "上等马", "上等马", "特等马", "上等马", "上等马"], { championId: ZED }));
  const rookie = mate(ID.b, "Rookie", LUX, history(ID.b, ["特等马"], { championId: ASHE }));
  const result = brief([rookie, vet]);
  assert.equal(result.pick?.memberId, ID.a);
  assert.ok(!result.speech.includes("Rookie"));
  const two = mate(ID.b, "Rookie", LUX, history(ID.b, ["特等马", "特等马"], { championId: ASHE }));
  assert.equal(brief([two, vet]).pick?.memberId, ID.a, "two games still do not count");
  const three = mate(ID.b, "Rookie", LUX, history(ID.b, ["特等马", "特等马", "特等马"], { championId: ASHE }));
  assert.equal(brief([three, vet]).pick?.memberId, ID.b, "three games do");
});

test("when nobody has three games the line says so, picks no one and still gives an order", () => {
  const twoEach = [
    mate(ID.a, "Alpha", AHRI, history(ID.a, ["上等马", "中等马"], { championId: ZED })),
    mate(ID.b, "Bravo", LUX, history(ID.b, ["中等马", "下等马"], { championId: ASHE })),
  ];
  const result = brief(twoEach);
  assert.equal(result.coldStart, false);
  assert.equal(result.pick, null);
  assert.ok(result.speech.startsWith(NO_PICK_LINE), result.speech);
  assert.equal(result.instruction.memberId, null);
  assert.equal(sentences(result.speech).length, 2);
  const card = buildPregameEmbed(result).toJSON();
  assert.equal(card.fields![0].value, NO_PICK_LINE);
  assert.ok(card.description!.includes("近2局均"), "the known games still show");
  // A cold run of two games is still a signal, so the order can be aimed even without a pick.
  const cold = brief([mate(ID.a, "Alpha", AHRI, history(ID.a, ["没有马", "没有马"], { championId: ZED })), twoEach[1]]);
  assert.equal(cold.pick, null);
  assert.equal(cold.instruction.memberId, ID.a);
  assert.match(cold.speech, new RegExp(`^${NO_PICK_LINE}Alpha`));
  const mock = buildPregameBrief({ matchId: "MOCK_5", mock: true, strangerCount: 0, otherSideHasFriend: false, teammates: twoEach.map((teammate) => ({ ...teammate, records: teammate.records.map((record) => ({ ...record, mock: true })) })) });
  assert.ok(mock.speech.startsWith(`模拟锦囊，${NO_PICK_LINE}`));
});

test("pick tiers by average: 近况最旺 from 6.5, 状态最稳 from 4.5, otherwise a count, and one teammate says 先押他了", () => {
  const reason = (scores: number[], rivals: number[][] = []) => {
    const teammates = [scores, ...rivals].map((list, index) => mate(id(40 + index), `Player${index}`, ASHE, scored(id(40 + index), list)));
    return brief(teammates).pick?.reason;
  };
  assert.equal(reason([6.5, 6.5, 6.5]), "近况最旺", "even one teammate at 6.5");
  assert.equal(reason([7, 7, 7], [[5, 5, 5]]), "近况最旺");
  assert.equal(reason([6.4, 6.4, 6.4]), "状态最稳", "6.4 is not hot");
  assert.equal(reason([5, 5, 5], [[3, 3, 3]]), "状态最稳");
  assert.equal(reason([4.5, 4.5, 4.5]), "状态最稳");
  assert.equal(reason([4.4, 4.4, 4.4]), "先押他了", "one rated teammate, low form");
  assert.equal(reason([3, 3, 3], [[2, 2, 2]]), "2个里先挑他");
  assert.equal(reason([3, 3, 3], [[2, 2, 2], [1, 1, 1]]), "3个里先挑他");
  // Teammates without three games do not count into "n个里".
  assert.equal(reason([3, 3, 3], [[2, 2]]), "先押他了");
});

test("the hot-streak order is jungle-only talk only for Smite, and spoken lines name who they are about", () => {
  const hotTiers: HorseTier[] = ["中等马", "特等马", "特等马", "特等马"];
  const calmTiers: HorseTier[] = ["上等马", "中等马", "上等马", "中等马", "上等马"];
  let jungleSeen = false;
  for (let game = 0; game < 40; game += 1) {
    const matchId = `NA1_${4000 + game}`;
    const top = brief([mate(ID.a, "Laner", ZED, history(ID.a, hotTiers, { championId: ASHE }), false)], { matchId });
    assert.ok(!top.speech.includes("大胆去抓"), top.speech);
    jungleSeen ||= brief([mate(ID.a, "Jungler", ZED, history(ID.a, hotTiers, { championId: ASHE }), true)], { matchId }).speech.includes("大胆去抓");
    // The order to a calm pick starts with the name or carries it, so it is understood on its own.
    const calm = brief([mate(ID.b, "Calmone", ZED, history(ID.b, calmTiers, { championId: ASHE }))], { matchId });
    const second = sentences(calm.speech)[1];
    assert.ok(second.includes("Calmone"), calm.speech);
    assert.ok(!second.includes("你") || second.includes("Calmone"), calm.speech);
  }
  assert.ok(jungleSeen, "the jungle phrase is still available to a Smite player");
});

test("a non-snowflake or duplicate member ID is refused, so a caller bug fails loudly", () => {
  const ok = mate(ID.a, "Alpha", AHRI);
  for (const bad of ["puuid-enemy-xyz", "m-hot", "123", "", "1".repeat(21), `${ID.a}x`, " 100000000000000001"]) {
    assert.throws(() => brief([{ ...ok, memberId: bad }]), /Discord user ID/, `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => brief([ok, mate(ID.b, "Bravo", LUX), ok]), /only once/);
  assert.throws(() => brief([ok, { ...mate(ID.a, "Same id", LUX) }]), /only once/);
  assert.doesNotThrow(() => brief([ok, mate(ID.b, "Bravo", LUX)]));
});

test("the instruction targets the member whose champion keeps ending as 没有马", () => {
  const bad = mate(ID.bad, "Badchamp", ZED, history(ID.bad, ["上等马", "没有马", "上等马", "没有马", "中等马"], { championId: ZED }));
  const hotOne = mate(ID.hot, "Hotman", AHRI, history(ID.hot, ["上等马", "特等马", "特等马", "特等马", "特等马"]));
  const coldOne = mate(ID.cold, "Coldman", LUX, history(ID.cold, ["中等马", "下等马", "没有马", "没有马", "没有马"]));
  const result = brief([hotOne, coldOne, bad]);
  assert.equal(result.instruction.memberId, ID.bad, "a champion that keeps failing outranks a cold run");
  assert.ok(result.instruction.text.includes(`<@${ID.bad}>`));
  assert.ok(result.instruction.text.includes("劫"));
  assert.ok(result.speech.includes("Badchamp"));
  assert.ok(result.speech.includes("劫"));
  const card = buildPregameEmbed(result).toJSON();
  assert.ok(card.fields![1].value.includes(`<@${ID.bad}>`));
});

test("without a failing champion the instruction aims at the coldest run, then a falling form, then the pick", () => {
  const cold = brief(pair());
  assert.equal(cold.instruction.memberId, ID.cold);
  assert.ok(cold.speech.includes("Coldman"));

  const falling = mate(ID.fall, "Faller", LUX, history(ID.fall, ["特等马", "特等马", "上等马", "上等马", "上等马", "中等马", "下等马", "中等马"]));
  const steady = mate(ID.steady, "Steady", AHRI, history(ID.steady, ["中等马", "中等马", "中等马", "中等马", "中等马"]));
  const down = brief([steady, falling]);
  assert.equal(down.lines[1].trend, "down");
  assert.equal(down.instruction.memberId, ID.fall);

  const fine = brief([mate(ID.a, "Alpha", AHRI, history(ID.a, ["上等马", "中等马", "上等马", "中等马", "上等马"])), steady]);
  assert.equal(fine.instruction.memberId, ID.a, "an order to the pick when nothing is wrong");
  assert.equal(fine.instruction.memberId, fine.pick?.memberId);
});

test("signals: streaks, trend arrows, champion record and position show on the card", () => {
  const pairs = pair();
  const hotRecords = history(ID.hot, ["下等马", "中等马", "中等马", "下等马", "没有马", "上等马", "上等马", "特等马", "特等马", "特等马"]);
  const result = brief([mate(ID.hot, "Hotman", AHRI, hotRecords, true), pairs[1]]);
  const [hot, cold] = result.lines;
  assert.equal(hot.hotStreak, 3);
  assert.equal(hot.trend, "up");
  assert.equal(hot.position, "JUNGLE", "Smite means jungle");
  assert.equal(cold.coldStreak, 2);
  assert.equal(cold.trend, null, "five games leave nothing to compare against");
  const lines = buildPregameEmbed(result).toJSON().description!.split("\n");
  assert.ok(lines[0].startsWith(`<@${ID.hot}> · 阿狸 · 👑 👑 👑 🐎 🐎 · 近5局均 8.2 ↑（前5局 3.4）`), lines[0]);
  assert.ok(lines[0].includes("↑"));
  assert.ok(lines[0].includes("🔥 连3局特等马"));
  assert.ok(lines[0].includes("打野"));
  assert.ok(lines[0].includes("本英雄 10 局：👑3 🪦1"), lines[0]);
  assert.ok(lines[1].includes("🥶 连2局没有马"));
  assert.ok(!lines[1].includes("↑") && !lines[1].includes("↓"));

  const single = brief([mate(ID.one, "Solo", AHRI, [...history(ID.one, ["上等马", "上等马", "上等马", "上等马"], { championId: ZED }), ...history(ID.one, ["特等马"], { championId: AHRI, matchId: "NA1_other" })])]);
  assert.equal(single.lines[0].championRecord, null, "one game on the champion is not a record");
  assert.ok(!buildPregameEmbed(single).toJSON().description!.includes("本英雄"));
});

/** Oldest first, each game with the given score. */
function scored(memberId: string, scores: readonly number[]): HorseRecord[] {
  return history(memberId, scores.map(() => "中等马" as HorseTier)).map((record, index) => ({ ...record, score: scores[index] }));
}

test("the trend needs three games on both sides and a full point of difference", () => {
  const trendOf = (scores: number[]) => brief([mate(ID.a, "Alpha", AHRI, scored(ID.a, scores))]).lines[0];
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
  const old = history(ID.a, Array.from({ length: 30 }, () => "没有马" as HorseTier));
  const fresh = history(ID.a, ["上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马", "上等马"]).map((record, index) => ({ ...record, matchId: `NA1_fresh_${index}`, playedAt: BASE_TIME + 200_000_000 + index }));
  const result = brief([mate(ID.a, "Alpha", AHRI, [...old, ...fresh])]);
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
  const coldMock = buildPregameBrief({ matchId: "MOCK_2", mock: true, teammates: [mate(ID.a, "Alpha", AHRI)], strangerCount: 0, otherSideHasFriend: false });
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
          mate(ID.a, names[0], ZED, records(ID.a, ["没有马", "没有马", "没有马", "上等马", "特等马"], { championId: ZED })),
          mate(ID.b, names[1], AHRI, records(ID.b, ["特等马", "特等马", "特等马", "特等马", "特等马"])),
          mate(ID.c, names[2], LUX, records(ID.c, ["中等马", "下等马", "没有马", "没有马", "没有马"])),
        ],
      }));
      worst.push(buildPregameBrief({ matchId, mock, strangerCount: 0, otherSideHasFriend: false, teammates: [mate(ID.a, names[0], AHRI), mate(ID.b, names[1], LUX)] }));
      worst.push(buildPregameBrief({ matchId, mock, strangerCount: 0, otherSideHasFriend: false, teammates: [mate(ID.a, names[0], AHRI, records(ID.a, ["上等马", "中等马", "上等马", "中等马", "上等马"]))] }));
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
  const sneaky = mate(ID.a, "@everyone <@123> `x`", AHRI, history(ID.a, ["特等马", "特等马", "特等马"]));
  const result = brief([sneaky]);
  assert.doesNotMatch(result.speech, /[@<>`]/);
  assert.equal(result.lines[0].name.includes("@"), false);
  assert.deepEqual(pregameAllowedMentions([ID.a, ID.b, ID.a]), { parse: [], roles: [], users: [ID.a, ID.b], repliedUser: false });
  assert.deepEqual(pregameAllowedMentions(["everyone", "1", ID.a, "<@&1>"]).users, [ID.a], "non-snowflakes are dropped");
  assert.deepEqual(pregameAllowedMentions([]), { parse: [], roles: [], users: [], repliedUser: false });
  assert.equal(pregameMentionContent([ID.a, ID.b, ID.a]), `<@${ID.a}> <@${ID.b}>`);
  assert.equal(pregameMentionContent(["@everyone", ID.a, "12"]), `<@${ID.a}>`);
  assert.equal(pregameMentionContent([]), "");
});

test("the card stays inside Discord's limits and nothing in it uses an em dash", () => {
  const long = "乙".repeat(32);
  const cards = [
    brief(pair()),
    brief([mate(ID.a, long, AHRI), mate(ID.b, long, LUX), mate(ID.c, long, ZED), mate(ID.d, long, ASHE), mate(ID.e, long, GAREN)]),
    brief(Array.from({ length: 5 }, (_, index) => mate(id(20 + index), long, AHRI, history(id(20 + index), Array.from({ length: 12 }, (__, game) => (game % 2 ? "特等马" : "没有马") as HorseTier))))),
  ];
  for (const result of cards) {
    const card = buildPregameEmbed(result).toJSON();
    assert.ok((card.description ?? "").length <= 4096);
    for (const field of card.fields ?? []) assert.ok(field.value.length <= 1024 && field.name.length <= 256);
    assert.ok((card.footer?.text.length ?? 0) <= 2048);
    const dash = String.fromCharCode(0x2014);
    assert.ok(!JSON.stringify(card).includes(dash) && !result.speech.includes(dash));
  }
});

test("without Smite the position is never jungle, only the most common other position on that champion", () => {
  const jungleOnly = history(ID.a, Array(8).fill("中等马"), { position: "JUNGLE", championId: AHRI });
  const noSmite = brief([mate(ID.a, "Alpha", AHRI, jungleOnly, false)]);
  assert.equal(noSmite.lines[0].position, null, "only jungle history and no Smite leaves no position");
  assert.ok(!buildPregameEmbed(noSmite).toJSON().description!.includes("打野"));

  const withSmite = brief([mate(ID.a, "Alpha", AHRI, jungleOnly, true)]);
  assert.equal(withSmite.lines[0].position, "JUNGLE", "Smite still means jungle");
  assert.ok(buildPregameEmbed(withSmite).toJSON().description!.includes("打野"));

  const mixed = [
    ...history(ID.b, Array(6).fill("中等马"), { position: "JUNGLE", championId: AHRI }).map((record, index) => ({ ...record, matchId: `NA1_jg_${index}` })),
    ...history(ID.b, Array(2).fill("中等马"), { position: "TOP", championId: AHRI }).map((record, index) => ({ ...record, matchId: `NA1_top_${index}` })),
  ];
  const fallback = brief([mate(ID.b, "Bravo", AHRI, mixed, false)]);
  assert.equal(fallback.lines[0].position, "TOP", "the most common non-jungle position wins over a more common jungle one");
  assert.equal(brief([mate(ID.b, "Bravo", AHRI, mixed, true)]).lines[0].position, "JUNGLE");
});

test("the trend label names the real size of the earlier window", () => {
  const trendLine = (games: number) => {
    const tiers: HorseTier[] = [...Array(games - 5).fill("下等马"), ...Array(5).fill("特等马")];
    const result = brief([mate(ID.a, "Alpha", AHRI, history(ID.a, tiers))]);
    return { line: result.lines[0], text: buildPregameEmbed(result).toJSON().description! };
  };
  const eight = trendLine(8);
  assert.equal(eight.line.previousGames, 3);
  assert.ok(eight.text.includes("（前3局 3.0）"), eight.text);
  assert.ok(!eight.text.includes("前5局"), eight.text);
  assert.ok(trendLine(9).text.includes("（前4局 3.0）"));
  assert.ok(trendLine(10).text.includes("（前5局 3.0）"));
  const seven = trendLine(7);
  assert.equal(seven.line.previousGames, 0, "two earlier games are not enough to compare");
  assert.ok(!seven.text.includes("（前"), seven.text);
});
