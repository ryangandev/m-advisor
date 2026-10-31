import assert from "node:assert/strict";
import { test } from "node:test";
import type { RankedEntry } from "../src/types";
import { classifyRankChange } from "../src/services/rankMath";
import type { RankRow } from "../src/services/rankTracker";
import {
  buildRankVoiceLine, MAX_SPOKEN_RANK_MOVES, MOCK_RANK_VOICE_PREFIX, rankMoveOf, rankMoveText,
} from "../src/services/rankText";
import type { RankMove, RankVoiceMove } from "../src/services/rankText";
import { buildRankAnnouncementEmbed } from "../src/utils/embeds";

const SOLO = "RANKED_SOLO_5x5";
const entry = (tier: string, rank: string, leaguePoints: number, games = 20, queueType = SOLO): RankedEntry =>
  ({ queueType, tier, rank, leaguePoints, wins: games, losses: 0 });
/** The row a ranked game leaves: the entries before and after, one game apart unless `gap` says otherwise. */
const rowOf = (before: RankedEntry, after: RankedEntry): RankRow => ({
  queueType: before.queueType as RankRow["queueType"],
  state: classifyRankChange(before, after) as RankRow["state"],
});
const moveOf = (before: RankedEntry, after: RankedEntry): RankMove => {
  const move = rankMoveOf(rowOf(before, after));
  assert.ok(move, "a promotion or demotion");
  return move;
};
const voiceMove = (puuid: string, name: string, move: RankMove): RankVoiceMove => ({ ...move, puuid, name });

const promotion = moveOf(entry("PLATINUM", "I", 90), entry("DIAMOND", "IV", 12, 21));
const demotion = moveOf(entry("GOLD", "IV", 5), entry("SILVER", "I", 86, 21));

test("only a promotion or a demotion is a 段位播报 move; every other row is never announced", () => {
  assert.equal(promotion.kind, "promoted");
  assert.equal(demotion.kind, "demoted");
  assert.equal(moveOf(entry("GOLD", "II", 90), entry("GOLD", "I", 12, 21)).kind, "promoted", "a division change counts");
  assert.equal(moveOf(entry("GOLD", "I", 10), entry("GOLD", "II", 91, 21)).kind, "demoted", "a division change counts");
  assert.equal(moveOf(entry("DIAMOND", "I", 90), entry("MASTER", "I", 12, 21)).kind, "promoted", "reaching the apex counts");
  const flex = rankMoveOf(rowOf(entry("GOLD", "II", 90, 20, "RANKED_FLEX_SR"), entry("GOLD", "I", 12, 21, "RANKED_FLEX_SR")));
  assert.equal(flex?.kind, "promoted", "flex counts");

  assert.equal(rankMoveOf(rowOf(entry("GOLD", "II", 40), entry("GOLD", "II", 62, 21))), null, "a plain change");
  // MASTER, GRANDMASTER and CHALLENGER are moved between by cutoffs, never by a game.
  assert.equal(rankMoveOf(rowOf(entry("MASTER", "I", 300), entry("GRANDMASTER", "I", 320, 21))), null, "up the apex");
  assert.equal(rankMoveOf(rowOf(entry("CHALLENGER", "I", 900), entry("MASTER", "I", 880, 21))), null, "down the apex");
  assert.equal(rankMoveOf(rowOf(entry("GOLD", "II", 40), entry("GOLD", "I", 12, 25))), null, "several games in between");
  assert.equal(rankMoveOf({ queueType: SOLO, state: { kind: "placed", after: entry("GOLD", "IV", 12) } }), null, "placements");
  for (const kind of ["pending", "stale", "unavailable"] as const) assert.equal(rankMoveOf({ queueType: SOLO, state: { kind } }), null, kind);
});

test("the 段位播报 line shows tiers as 黄金 II with the current LP, and a demotion has no LP change", () => {
  assert.equal(rankMoveText("m1", promotion), "<@m1> 单双排 晋级：铂金 I → 钻石 IV · 12 LP");
  assert.equal(rankMoveText("m1", demotion), "<@m1> 单双排 掉段：黄金 IV → 白银 I · 86 LP");
  assert.doesNotMatch(rankMoveText("m1", demotion)!, /[+-]\d|±/);
  const apex = moveOf(entry("DIAMOND", "I", 90), entry("MASTER", "I", 12, 21));
  assert.equal(rankMoveText("m2", apex), "<@m2> 单双排 晋级：钻石 I → 大师 · 12 LP", "an apex tier has no division");
  const flex = moveOf(entry("GOLD", "II", 90, 20, "RANKED_FLEX_SR"), entry("GOLD", "I", 12, 21, "RANKED_FLEX_SR"));
  assert.equal(rankMoveText("m3", flex), "<@m3> 灵活组排 晋级：黄金 II → 黄金 I · 12 LP");
});

test("the voice line says tiers as 黄金二, names the queue and matches the samples", () => {
  const lines = new Set<string>();
  for (let index = 0; index < 60; index++) {
    lines.add(buildRankVoiceLine({ matchId: `NA1_${index}`, mock: false, moves: [voiceMove("p1", "小明", promotion)] }));
  }
  assert.ok(lines.has("军师贺喜！小明单双排升到钻石四了。"), "the sample promotion line");
  for (const line of lines) assert.match(line, /^.*小明.*单双排.*钻石四.*。$/);
  const demotions = new Set<string>();
  for (let index = 0; index < 60; index++) {
    demotions.add(buildRankVoiceLine({ matchId: `NA1_${index}`, mock: false, moves: [voiceMove("p1", "小明", demotion)] }));
  }
  assert.ok(demotions.has("小明单双排掉回白银一，别急，军师陪你重新上马。"), "the sample demotion line");
  for (const line of [...lines, ...demotions]) {
    assert.doesNotMatch(line, /[A-Z]|\d/, "no letters or digits in speech");
    assert.ok(!line.includes(String.fromCharCode(0x2014)), "no em dash");
  }
});

test("the voice line is the same for the same seed, and the seed is the match and the account", () => {
  const moves = [voiceMove("p1", "小明", promotion)];
  for (let index = 0; index < 30; index++) {
    const matchId = `NA1_${index}`;
    const first = buildRankVoiceLine({ matchId, mock: false, moves });
    for (let again = 0; again < 5; again++) assert.equal(buildRankVoiceLine({ matchId, mock: false, moves }), first);
  }
  const lineFor = (matchId: string, puuid: string) => buildRankVoiceLine({ matchId, mock: false, moves: [voiceMove(puuid, "小明", promotion)] });
  const ids = Array.from({ length: 40 }, (_, index) => `NA1_${index}`);
  assert.ok(new Set(ids.map((id) => lineFor(id, "p1"))).size > 1, "the wording varies between matches");
  assert.ok(ids.some((id) => lineFor(id, "p1") !== lineFor(id, "p2")), "the account is part of the seed");
});

test("mock lines start with 模拟段位播报，, real lines do not", () => {
  const moves = [voiceMove("p1", "小明", demotion)];
  assert.ok(buildRankVoiceLine({ matchId: "NA1_1", mock: true, moves }).startsWith(MOCK_RANK_VOICE_PREFIX));
  assert.equal(MOCK_RANK_VOICE_PREFIX, "模拟段位播报，");
  assert.doesNotMatch(buildRankVoiceLine({ matchId: "NA1_1", mock: false, moves }), /模拟/);
});

test("several members make at most two sentences, and a name is sanitized", () => {
  const moves = [voiceMove("p1", "小明", promotion), voiceMove("p2", "小红", demotion), voiceMove("p3", "小刚", promotion)];
  const line = buildRankVoiceLine({ matchId: "NA1_9", mock: false, moves });
  assert.equal(MAX_SPOKEN_RANK_MOVES, 2);
  assert.equal(line.split("。").filter(Boolean).length, 2);
  assert.match(line, /小明/);
  assert.match(line, /小红/);
  assert.doesNotMatch(line, /小刚/);
  assert.doesNotMatch(buildRankVoiceLine({ matchId: "NA1_9", mock: false, moves: [voiceMove("p1", "<@123>`x`", promotion)] }), /[<@>`]/);
  assert.equal(buildRankVoiceLine({ matchId: "NA1_9", mock: false, moves: [] }), "");
});

test("two members whose names collide after trimming still sound different", () => {
  const moves = [voiceMove("p1", "SummonerAlpha", promotion), voiceMove("p2", "SummonerBeta", promotion)];
  const line = buildRankVoiceLine({ matchId: "NA1_5", mock: false, moves });
  const [first, second] = line.split("。").filter(Boolean);
  assert.match(first, /Alpha/, "the front halves would both be Summon");
  assert.match(second, /Beta/);
  assert.ok(Array.from(line).length <= 65, "the line stays short");
});

test("two long Latin names share a speech budget, so a line stays short", () => {
  const flexUp = moveOf(entry("GOLD", "II", 90, 20, "RANKED_FLEX_SR"), entry("GOLD", "I", 12, 21, "RANKED_FLEX_SR"));
  const flexDown = moveOf(entry("PLATINUM", "IV", 5, 20, "RANKED_FLEX_SR"), entry("GOLD", "I", 86, 21, "RANKED_FLEX_SR"));
  const longest = (moves: RankVoiceMove[]) => Math.max(...Array.from({ length: 60 }, (_, index) =>
    Array.from(buildRankVoiceLine({ matchId: `NA1_${index}`, mock: true, moves })).length));
  const names = ["Abcdefghijklmnop", "Qrstuvwxyzabcdef"];
  for (const moves of [
    [voiceMove("p1", names[0], flexUp), voiceMove("p2", names[1], flexDown)],
    [voiceMove("p1", names[0], flexDown), voiceMove("p2", names[1], flexUp)],
    [voiceMove("p1", names[0], flexUp), voiceMove("p2", names[1], flexUp)],
    [voiceMove("p1", names[0], flexDown), voiceMove("p2", names[1], flexDown)],
  ]) {
    // About 4.3 characters a second: at most 65 characters, with the mock prefix, is about 15 seconds.
    assert.ok(longest(moves) <= 65, `${longest(moves)} characters`);
  }
  const line = buildRankVoiceLine({ matchId: "NA1_1", mock: false, moves: [voiceMove("p1", names[0], flexUp), voiceMove("p2", names[1], flexDown)] });
  assert.ok(!line.includes(names[0]) && !line.includes(names[1]), "the long names are trimmed");
  assert.match(line, /Abcdef/);
  assert.match(line, /Qrstuv/);
  // A short name is never trimmed.
  assert.match(buildRankVoiceLine({ matchId: "NA1_1", mock: false, moves: [voiceMove("p1", "Faker", flexUp)] }), /Faker/);
});

test("a demotion comforts with 胜败乃兵家常事, not the reversed idiom", () => {
  const lines = Array.from({ length: 60 }, (_, index) =>
    buildRankVoiceLine({ matchId: `NA1_${index}`, mock: false, moves: [voiceMove("p1", "小明", demotion)] }));
  assert.ok(lines.some((line) => line.includes("胜败乃兵家常事")));
  assert.ok(lines.every((line) => !line.includes("胜负兵家常事")));
});

test("two members with the same report name are spoken by their champions, never as one", () => {
  const withChampion = (puuid: string, name: string, champion: string): RankVoiceMove => ({ ...voiceMove(puuid, name, promotion), champion });
  const line = buildRankVoiceLine({
    matchId: "NA1_7", mock: false, moves: [withChampion("p1", "Ryan", "亚索"), withChampion("p2", "Ryan", "锐雯")],
  });
  assert.match(line, /亚索/);
  assert.match(line, /锐雯/);
  assert.doesNotMatch(line, /Ryan/, "the shared name is not spoken at all");
  // Names that already differ are spoken as before, whatever the champions are.
  const distinctNames = buildRankVoiceLine({
    matchId: "NA1_7", mock: false, moves: [withChampion("p1", "Ryan", "亚索"), withChampion("p2", "Kate", "锐雯")],
  });
  assert.equal(distinctNames, buildRankVoiceLine({
    matchId: "NA1_7", mock: false, moves: [voiceMove("p1", "Ryan", promotion), voiceMove("p2", "Kate", promotion)],
  }));
  assert.match(distinctNames, /Ryan/);
  assert.match(distinctNames, /Kate/);
});

test("the 段位播报 embed is titled 段位播报, and 模拟数据 · 段位播报 in mock mode", () => {
  const real = buildRankAnnouncementEmbed(["<@m1> 单双排 晋级：铂金 I → 钻石 IV · 12 LP"], false).toJSON();
  const mock = buildRankAnnouncementEmbed(["<@m1> 单双排 晋级：铂金 I → 钻石 IV · 12 LP"], true).toJSON();
  assert.equal(real.title, "段位播报");
  assert.equal(mock.title, "模拟数据 · 段位播报");
  assert.equal(real.description, "<@m1> 单双排 晋级：铂金 I → 钻石 IV · 12 LP");
  assert.match(mock.footer!.text, /模拟数据/);
  assert.doesNotMatch(real.footer!.text, /模拟/);
});
