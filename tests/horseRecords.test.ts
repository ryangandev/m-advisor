import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildMatchAnnouncement, formatScore } from "../src/services/announcementText";
import { buildHorseRecords } from "../src/services/horseRecords";
import type { MatchEvent } from "../src/services/matchEvents";
import { setMemberAccounts } from "../src/store/bindingStore";
import { DEFAULT_BENCHMARKS, rankTeam } from "../src/services/horseRanking";
import { closeDatabase } from "../src/store/database";
import { listHorseRecords, recordHorseRecords } from "../src/store/horseRecordStore";
import { buildMockMatch, buildMockProfile } from "../src/fixtures/riotFixtures";
import { parseMatchDetail } from "../src/utils/riotMatchApi";
import { testMatch } from "./helpers/matches";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-horse-records-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

const recordedAt = 1_800_000_500_000;

test("each tracked member who played gets one record placed by their team's ranking", () => {
  const detail = testMatch("NA1_PAIR", ["tracked", "friend"], "win");
  const records = buildHorseRecords({
    guildId: "guild-one",
    detail,
    tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }, { discordUserId: "u-friend", puuid: "friend" }, { discordUserId: "u-absent", puuid: "not-in-match" }],
    mock: false,
    recordedAt,
  });
  const ranking = rankTeam(detail, "tracked");
  assert.deepEqual(records.map((record) => record.discordUserId), ["u-tracked", "u-friend"]);
  for (const record of records) {
    const index = ranking.horses.findIndex((horse) => horse.participant.puuid === record.puuid);
    const horse = ranking.horses[index];
    assert.equal(record.tier, horse.tier);
    assert.equal(record.teamRank, index + 1);
    assert.equal(record.teamSize, 5);
    assert.equal(record.score, horse.score);
    assert.equal(record.composite, horse.composite);
    assert.deepEqual(record.dimensions, horse.dimensions);
    assert.deepEqual(record.features, horse.features);
    assert.equal(record.scoreAbove, index === 0 ? null : ranking.horses[index - 1].score);
    assert.equal(record.scoreBelow, index === 4 ? null : ranking.horses[index + 1].score);
    assert.equal(record.position, horse.participant.position);
    assert.equal(record.matchId, "NA1_PAIR");
    assert.equal(record.queueId, 420);
    assert.equal(record.durationSeconds, 1800);
    assert.equal(record.playedAt, detail.info.gameEndTimestamp);
    assert.equal(record.recordedAt, recordedAt);
    assert.equal(record.mock, false);
    assert.equal(record.benchmarkVersion, DEFAULT_BENCHMARKS.version);
    assert.equal(record.benchmarkCollectedAt, DEFAULT_BENCHMARKS.sample.collectedAt);
  }
  assert.deepEqual(records.map((record) => [record.tier, record.scoreAbove === null]), [["上等马", false], ["下等马", false]]);
});

test("teammates and enemies are never stored, not even their ids or names", () => {
  const detail = testMatch("NA1_PRIVACY", ["tracked"], "win");
  const records = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt });
  assert.equal(records.length, 1);
  const text = JSON.stringify(records);
  for (const other of detail.info.participants.filter((player) => player.puuid !== "tracked")) {
    assert.ok(!text.includes(other.puuid), `${other.puuid} leaked`);
    assert.ok(!text.includes(other.riotIdGameName) || other.riotIdGameName === "Tracked", `${other.riotIdGameName} leaked`);
  }
  // Only anonymous numbers describe the neighbours.
  assert.equal(typeof records[0].scoreAbove, "number");
  assert.equal(typeof records[0].scoreBelow, "number");
});

test("a tracked member on the other team is recorded from their own team's ranking", () => {
  const detail = testMatch("NA1_FOES", ["tracked"], "win");
  const records = buildHorseRecords({
    guildId: "guild-one",
    detail,
    tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }, { discordUserId: "u-foe", puuid: "MOCK-ENEMY-4" }],
    mock: true,
    recordedAt,
  });
  const foeRanking = rankTeam(detail, "MOCK-ENEMY-4");
  const foe = records.find((record) => record.discordUserId === "u-foe")!;
  assert.equal(foe.tier, foeRanking.horses.find((horse) => horse.participant.puuid === "MOCK-ENEMY-4")!.tier);
  assert.equal(foe.won, false);
  assert.equal(records.find((record) => record.discordUserId === "u-tracked")!.won, true);
  assert.equal(records.length, 2, "the other enemies are not tracked, so they get no record");
});

test("a member with two accounts in one match is recorded once, through their first account", () => {
  const detail = testMatch("NA1_ALTS", ["tracked", "friend"], "loss");
  const records = buildHorseRecords({
    guildId: "guild-one",
    detail,
    tracked: [{ discordUserId: "u-one", puuid: "friend" }, { discordUserId: "u-one", puuid: "tracked" }],
    mock: false,
    recordedAt,
  });
  assert.deepEqual(records.map((record) => [record.discordUserId, record.puuid]), [["u-one", "friend"]]);
});

test("games the announcement does not judge leave no record", () => {
  const tracked = [{ discordUserId: "u-tracked", puuid: "tracked" }];
  const remake = testMatch("NA1_REMAKE", ["tracked"], "win");
  remake.info.earlySurrender = true;
  const aborted = testMatch("NA1_ABORTED", ["tracked"], "win");
  aborted.info.aborted = true;
  const short = testMatch("NA1_SHORT", ["tracked"], "win");
  short.info.gameDuration = 9 * 60 + 59;
  for (const detail of [remake, aborted, short]) {
    assert.deepEqual(buildHorseRecords({ guildId: "guild-one", detail, tracked, mock: false, recordedAt }), [], detail.metadata.matchId);
  }
  const tenMinutes = testMatch("NA1_TEN", ["tracked"], "win");
  tenMinutes.info.gameDuration = 10 * 60;
  assert.equal(buildHorseRecords({ guildId: "guild-one", detail: tenMinutes, tracked, mock: false, recordedAt }).length, 1);
});

test("a missing end time falls back to the recording time", () => {
  const detail = testMatch("NA1_NOEND", ["tracked"], "win");
  detail.info.gameEndTimestamp = null;
  const [record] = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt });
  assert.equal(record.playedAt, recordedAt);
});

test("rankings the caller already computed are used for their team", () => {
  const detail = testMatch("NA1_GIVEN", ["tracked"], "win");
  const ranking = rankTeam(detail, "tracked");
  const given = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt, rankings: [ranking] });
  const computed = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt });
  assert.deepEqual(given, computed);
  // A ranking of a different match is ignored rather than trusted.
  const other = testMatch("NA1_OTHER", ["tracked"], "loss");
  const ignored = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt, rankings: [rankTeam(other, "tracked")] });
  assert.deepEqual(ignored, computed);
});

test("built records are saved once however often the monitor records the match", () => {
  const detail = testMatch("MOCK_NA1_SAVE", ["tracked", "friend"], "win");
  const input = {
    guildId: "guild-one",
    detail,
    tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }, { discordUserId: "u-friend", puuid: "friend" }],
    mock: true,
    recordedAt,
  };
  setMemberAccounts("guild-one", "u-tracked", [{ puuid: "tracked", gameName: "Tracked", tagLine: "NA1" }]);
  setMemberAccounts("guild-one", "u-friend", [{ puuid: "friend", gameName: "Friend", tagLine: "NA1" }]);
  assert.equal(recordHorseRecords(buildHorseRecords(input)), 2);
  assert.equal(recordHorseRecords(buildHorseRecords({ ...input, recordedAt: recordedAt + 90_000 })), 0);
  const stored = listHorseRecords("guild-one", { mock: true });
  assert.equal(stored.length, 2);
  assert.ok(stored.every((record) => record.recordedAt === recordedAt));
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }), []);
});

test("a record keeps its team and the game version when the match has one", () => {
  const detail = testMatch("NA1_VERSION", ["tracked"], "win");
  detail.info.gameVersion = "16.19.123.4567";
  const tracked = [{ discordUserId: "u-tracked", puuid: "tracked" }, { discordUserId: "u-foe", puuid: "MOCK-ENEMY-4" }];
  const records = buildHorseRecords({ guildId: "guild-one", detail, tracked, mock: false, recordedAt });
  assert.deepEqual(records.map((record) => [record.discordUserId, record.teamId, record.gameVersion]), [
    ["u-tracked", 100, "16.19.123.4567"], ["u-foe", 200, "16.19.123.4567"],
  ]);
  delete detail.info.gameVersion;
  assert.ok(buildHorseRecords({ guildId: "guild-one", detail, tracked, mock: false, recordedAt }).every((record) => record.gameVersion === null));
});

test("without an announcement no record carries commentary", () => {
  const detail = testMatch("NA1_QUIET", ["tracked"], "win");
  const records = buildHorseRecords({ guildId: "guild-one", detail, tracked: [{ discordUserId: "u-tracked", puuid: "tracked" }], mock: false, recordedAt });
  assert.deepEqual(records.map((record) => [record.commentary, record.commentaryTone, record.momentKind]), [[null, null, null]]);
});

test("the praised and roasted members keep the line the 军师 spoke and the moment it cited", () => {
  const detail = testMatch("NA1_SAID", ["tracked"], "win");
  const ranking = rankTeam(detail, "tracked");
  const best = ranking.horses[0].participant.puuid;
  const worst = ranking.horses[4].participant.puuid;
  const middle = ranking.horses[2].participant.puuid;
  const foe = "MOCK-ENEMY-4";
  const events: MatchEvent[] = [
    { puuid: best, timestamp: 24 * 60_000, kind: "multiKill", kills: 3 },
    { puuid: worst, timestamp: 17 * 60_000, kind: "objectiveDeath", monster: "DRAGON" },
    { puuid: middle, timestamp: 9 * 60_000, kind: "multiKill", kills: 4 },
  ];
  const announcement = buildMatchAnnouncement(detail, "tracked", false, { events });
  const tracked = [best, worst, middle, foe].map((puuid) => ({ discordUserId: `u-${puuid}`, puuid }));
  const records = buildHorseRecords({
    guildId: "guild-one", detail, tracked, mock: false, recordedAt,
    announcement: { announcement, perspectivePuuid: "tracked", events },
  });
  const byMember = new Map(records.map((record) => [record.puuid, record]));

  const praised = byMember.get(best)!;
  assert.deepEqual([praised.commentaryTone, praised.commentary, praised.momentKind], ["praise", announcement.report.praise, "multiKill"]);
  assert.match(praised.commentary!, /24分钟一波三杀/);
  const roasted = byMember.get(worst)!;
  assert.deepEqual([roasted.commentaryTone, roasted.commentary, roasted.momentKind], ["roast", announcement.report.roast, "objectiveDeath"]);
  assert.match(roasted.commentary!, /17分钟小龙前你先倒下了/);
  // A 4-kill moment for a middling horse was never cited, and an enemy of the perspective was neither praised nor roasted.
  assert.deepEqual([byMember.get(middle)!.commentary, byMember.get(middle)!.momentKind], [null, null]);
  assert.deepEqual([byMember.get(foe)!.commentary, byMember.get(foe)!.commentaryTone, byMember.get(foe)!.momentKind], [null, null, null]);
});

test("commentary that quoted a statistic keeps no moment kind", () => {
  const detail = testMatch("NA1_STAT", ["tracked"], "win");
  const best = rankTeam(detail, "tracked").horses[0].participant.puuid;
  const announcement = buildMatchAnnouncement(detail, "tracked", false);
  const [record] = buildHorseRecords({
    guildId: "guild-one", detail, tracked: [{ discordUserId: "u-best", puuid: best }], mock: false, recordedAt,
    announcement: { announcement, perspectivePuuid: "tracked", events: null },
  });
  assert.equal(record.commentary, announcement.report.praise);
  assert.equal(record.momentKind, null);
});

test("scores print with the same rounding in speech and in the 马厩", () => {
  assert.equal(formatScore(0.15), "0.2");
  assert.equal(formatScore(9.95), "10.0");
  assert.equal(formatScore(5), "5.0");
  const detail = testMatch("NA1_ROUND", ["tracked"], "win");
  const speech = buildMatchAnnouncement(detail, "tracked", false).speech;
  for (const horse of rankTeam(detail, "tracked").horses) assert.ok(speech.includes(`${formatScore(horse.score)}分`), horse.participant.puuid);
});

test("the parsed match keeps Riot's game version when present and omits it otherwise", () => {
  const raw = buildMockMatch(buildMockProfile("Tracked", "NA1"), "NA1_PARSE", "win");
  assert.equal(parseMatchDetail(raw, "NA1_PARSE").info.gameVersion, undefined);
  (raw.info as Record<string, unknown>).gameVersion = " 16.19.123.4567 ";
  assert.equal(parseMatchDetail(raw, "NA1_PARSE").info.gameVersion, "16.19.123.4567");
});
