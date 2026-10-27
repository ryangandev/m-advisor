import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { getMemberHorseProfile, summarizeHorseRecords } from "../src/services/horseProfile";
import type { HorseTier } from "../src/services/horseRanking";
import { closeDatabase } from "../src/store/database";
import { recordHorseRecords } from "../src/store/horseRecordStore";
import type { HorseRecord } from "../src/store/horseRecordStore";
import { makeHorseRecord } from "./helpers/horseRecords";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-horse-profile-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

const MIDDLE_DIMENSIONS = { damage: 0.8, teamfight: 0.6, survival: 0.5, economy: 0.3, frontline: 0, vision: 0, objectives: 0.55, utility: 0, matchup: 0.7 };

/** Oldest first: each entry is a tier and a score. */
function seed(results: Array<[HorseTier, number]>, overrides: Partial<HorseRecord> = {}): HorseRecord[] {
  return results.map(([tier, score], index) => makeHorseRecord({
    matchId: `NA1_SEED_${index}`,
    playedAt: 1_800_000_000_000 + index * 3_600_000,
    tier,
    score,
    dimensions: MIDDLE_DIMENSIONS,
    won: index % 2 === 0,
    ...overrides,
  }));
}

const TEN_GAMES: Array<[HorseTier, number]> = [
  ["特等马", 9], ["特等马", 9.5], ["上等马", 7], ["没有马", 1], ["没有马", 0.5],
  ["中等马", 5], ["特等马", 9], ["特等马", 9.2], ["特等马", 8.8], ["没有马", 1.5],
];

test("an empty history gives an empty profile", () => {
  const profile = summarizeHorseRecords([]);
  assert.equal(profile.games, 0);
  assert.equal(profile.averageScore, null);
  assert.equal(profile.strongest, null);
  assert.equal(profile.weakest, null);
  assert.deepEqual(profile.recent, []);
  assert.deepEqual(profile.recentForm, []);
  assert.equal(profile.firstPlayedAt, null);
  assert.equal(profile.tiers["特等马"].rate, 0);
  assert.deepEqual(profile.streaks, { top: { current: 0, best: 0 }, none: { current: 0, best: 0 } });
});

test("tier counts, rates, average score and results come from the records", () => {
  const profile = summarizeHorseRecords(seed(TEN_GAMES));
  assert.equal(profile.games, 10);
  assert.equal(profile.wins, 5);
  assert.deepEqual(Object.fromEntries(Object.entries(profile.tiers).map(([tier, stat]) => [tier, stat.count])),
    { 特等马: 5, 上等马: 1, 中等马: 1, 下等马: 0, 没有马: 3 });
  assert.equal(profile.tiers["特等马"].rate, 0.5);
  assert.equal(profile.tiers["没有马"].rate, 0.3);
  assert.ok(Math.abs(profile.averageScore! - 6.05) < 1e-9);
});

test("streaks count the latest run and the longest run", () => {
  const profile = summarizeHorseRecords(seed(TEN_GAMES));
  assert.deepEqual(profile.streaks, { top: { current: 0, best: 3 }, none: { current: 1, best: 2 } });
  const hot = summarizeHorseRecords(seed([["没有马", 1], ["特等马", 9], ["特等马", 9], ["特等马", 9], ["特等马", 9]]));
  assert.deepEqual(hot.streaks, { top: { current: 4, best: 4 }, none: { current: 0, best: 1 } });
});

test("recent form and recent games list the newest first", () => {
  const profile = summarizeHorseRecords(seed(TEN_GAMES));
  assert.deepEqual(profile.recentForm, ["没有马", "特等马", "特等马", "特等马", "中等马", "没有马", "没有马", "上等马", "特等马", "特等马"]);
  assert.deepEqual(profile.recent.map((record) => record.matchId), ["NA1_SEED_9", "NA1_SEED_8", "NA1_SEED_7", "NA1_SEED_6", "NA1_SEED_5"]);
  assert.equal(profile.firstPlayedAt, 1_800_000_000_000);
  assert.equal(profile.lastPlayedAt, 1_800_000_000_000 + 9 * 3_600_000);
  const long = summarizeHorseRecords(seed(Array.from({ length: 14 }, () => ["中等马", 5] as [HorseTier, number])));
  assert.equal(long.recentForm.length, 10);
});

test("the order records are passed in does not matter", () => {
  const records = seed(TEN_GAMES);
  assert.deepEqual(summarizeHorseRecords([...records].reverse()), summarizeHorseRecords(records));
});

test("strongest and weakest dimensions are the extremes of the average percentile", () => {
  const profile = summarizeHorseRecords(seed(TEN_GAMES));
  assert.equal(profile.strongest?.dimension, "damage");
  assert.ok(Math.abs(profile.strongest!.average - 0.8) < 1e-9);
  assert.equal(profile.weakest?.dimension, "economy");
  assert.ok(Math.abs(profile.weakest!.average - 0.3) < 1e-9);
  assert.equal(profile.weakest?.games, 10);
});

test("dimensions that do not matter for the position never count as strongest or weakest", () => {
  // A bottom laner carries no frontline weight and little vision weight, so low numbers there say nothing.
  const bottom = seed(Array.from({ length: 4 }, () => ["中等马", 5] as [HorseTier, number]), {
    position: "BOTTOM",
    dimensions: { damage: 0.7, teamfight: 0.6, survival: 0.55, economy: 0.4, frontline: 0, vision: 0.05, objectives: 0.5, utility: 0, matchup: 0.65 },
  });
  const profile = summarizeHorseRecords(bottom);
  assert.deepEqual(profile.dimensions.map((stat) => stat.dimension), ["damage", "matchup", "teamfight", "survival", "objectives", "economy"]);
  assert.equal(profile.weakest?.dimension, "economy");
  // The same numbers for a support do count vision.
  const support = summarizeHorseRecords(seed(Array.from({ length: 4 }, () => ["中等马", 5] as [HorseTier, number]), {
    position: "UTILITY",
    dimensions: { damage: 0.7, teamfight: 0.6, survival: 0.55, economy: 0.4, frontline: 0, vision: 0.05, objectives: 0.5, utility: 0.6, matchup: 0.65 },
  }));
  assert.equal(support.weakest?.dimension, "vision");
});

test("a dimension needs three games before it is named, and two dimensions before there is a contrast", () => {
  assert.equal(summarizeHorseRecords(seed(TEN_GAMES.slice(0, 2))).strongest, null);
  assert.equal(summarizeHorseRecords(seed(TEN_GAMES.slice(0, 3))).strongest?.dimension, "damage");
  const single = summarizeHorseRecords(seed(TEN_GAMES.slice(0, 5), { dimensions: { damage: 0.9 } }));
  assert.equal(single.dimensions.length, 1);
  assert.equal(single.strongest, null);
  assert.equal(single.weakest, null);
});

test("a player without a known position is judged on the all-position weights", () => {
  const profile = summarizeHorseRecords(seed(TEN_GAMES.slice(0, 3), { position: null, dimensions: { frontline: 0.2, vision: 0.9, damage: 0.5 } }));
  assert.equal(profile.strongest?.dimension, "vision");
  assert.equal(profile.weakest?.dimension, "damage", "frontline weighs 0.07 for everyone, below the bar");
});

test("mock and real records are never summarized together", () => {
  const mixed = [...seed(TEN_GAMES.slice(0, 2)), ...seed(TEN_GAMES.slice(0, 2), { mock: true, matchId: "MOCK_X" }).map((record, index) => ({ ...record, matchId: `MOCK_${index}` }))];
  assert.throws(() => summarizeHorseRecords(mixed), /Mock and real/);
});

test("a member's stored profile counts only the current data mode", () => {
  recordHorseRecords([
    ...seed(TEN_GAMES.slice(0, 4)),
    ...seed([["没有马", 0.2], ["没有马", 0.1]], { mock: true }).map((record, index) => ({ ...record, matchId: `MOCK_${index}` })),
    ...seed(TEN_GAMES.slice(0, 1), { discordUserId: "member-two", matchId: "NA1_OTHER" }),
  ]);
  const real = getMemberHorseProfile("guild-one", "member-one", false);
  const mock = getMemberHorseProfile("guild-one", "member-one", true);
  assert.equal(real.games, 4);
  assert.equal(real.tiers["没有马"].count, 1);
  assert.equal(mock.games, 2);
  assert.equal(mock.tiers["没有马"].count, 2);
  assert.equal(getMemberHorseProfile("guild-one", "nobody", false).games, 0);
  assert.equal(getMemberHorseProfile("guild-two", "member-one", false).games, 0);
});
