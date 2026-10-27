import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { buildRankResult } from "../src/services/rankResults";
import { closeAppeal, isAppealClosed } from "../src/store/appealStore";
import { listTrackedMembers } from "../src/store/bindingStore";
import { closeDatabase, getDatabase, SCHEMA_VERSION } from "../src/store/database";
import { eraseMemberHorseRecords, listHorseRecords } from "../src/store/horseRecordStore";
import { eraseMemberRankResults, listRankResults, recordRankResults } from "../src/store/rankStore";
import type { RankResult } from "../src/store/rankStore";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";
import { ROWS_V6, SCHEMA_V6 } from "./helpers/schemaV6";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-rank-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

function runSeparateProcess(source: string): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function backupFiles(filePath: string): string[] {
  const prefix = `${basename(filePath)}.v`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
}

function writeVersionSixDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('foreign_keys = ON');
    db.exec(${JSON.stringify(SCHEMA_V6)});
    db.exec(${JSON.stringify(ROWS_V6)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

const RESULT: RankResult = {
  guildId: "guild-one",
  discordUserId: "laowang",
  matchId: "NA1_100",
  mock: false,
  puuid: "puuid-w1",
  queueType: "solo",
  playedAt: 1_800_000_000_000,
  recordedAt: 1_800_000_060_000,
  kind: "change",
  tier: "GOLD",
  division: "II",
  leaguePoints: 86,
  lpDelta: 22,
  beforeTier: "GOLD",
  beforeDivision: "II",
  beforeLeaguePoints: 64,
};

test("the schema version is at least 7, so the rank_results step is part of every upgrade", () => {
  assert.ok(SCHEMA_VERSION >= 7);
});

test("a version 6 database upgrades in a separate process with a backup and its data intact", () => {
  const filePath = join(directory, "v6.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionSixDatabase(filePath);

  // A different process performs the upgrade and stores a result; this one only inspects the outcome.
  const output = runSeparateProcess(`
    const { getDatabase, closeDatabase } = require(${JSON.stringify(resolve(__dirname, "../src/store/database.ts"))});
    const { recordRankResults } = require(${JSON.stringify(resolve(__dirname, "../src/store/rankStore.ts"))});
    process.stdout.write(String(getDatabase().pragma('user_version', { simple: true })));
    recordRankResults([${JSON.stringify(RESULT)}]);
    closeDatabase();
  `);
  assert.equal(output.trim().split("\n").pop(), String(SCHEMA_VERSION));

  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(listRankResults("guild-one", { mock: false }), [RESULT], "the result written by the other process is here");
  assert.deepEqual(listTrackedMembers("guild-one").map((member) => member.discordUserId), ["laowang"]);
  assert.equal(isAppealClosed({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_OLD", mock: false }, 1_800_000_000_000), true, "the v6 appeal case survives");
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  assert.deepEqual(backupFiles(filePath), ["v6.sqlite3.v6.bak"]);
  const backup = new Database(`${filePath}.v6.bak`, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'rank_results'").all(), []);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM appeal_cases").get() as { count: number }).count, 1);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM member_accounts").get() as { count: number }).count, 1);
  } finally {
    backup.close();
  }
});

test("the upgraded table is STRICT, has its two indexes and no foreign key", () => {
  getDatabase();
  const database = getDatabase();
  const table = database.prepare("SELECT strict FROM pragma_table_list('rank_results')").get() as { strict: number };
  assert.equal(table.strict, 1);
  assert.deepEqual(
    database.prepare("SELECT name FROM pragma_index_info('rank_results_by_member') ORDER BY seqno").all(),
    [{ name: "guild_id" }, { name: "discord_user_id" }, { name: "mock" }, { name: "played_at" }],
  );
  assert.deepEqual(
    database.prepare("SELECT name FROM pragma_index_info('rank_results_by_time') ORDER BY seqno").all(),
    [{ name: "guild_id" }, { name: "mock" }, { name: "played_at" }],
    "a server-wide period query, such as the weekly 马报, has its index",
  );
  assert.deepEqual(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rank_results' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    [{ name: "rank_results_by_member" }, { name: "rank_results_by_time" }],
  );
  assert.deepEqual(database.prepare("SELECT * FROM pragma_foreign_key_list('rank_results')").all(), []);
  assert.deepEqual(
    database.prepare("SELECT name FROM pragma_table_info('rank_results') WHERE pk > 0 ORDER BY pk").all(),
    [{ name: "guild_id" }, { name: "discord_user_id" }, { name: "match_id" }, { name: "mock" }],
  );
});

test("a failed version 7 step rolls back and leaves the version 6 database intact", () => {
  const filePath = join(directory, "v6-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionSixDatabase(filePath, "CREATE TABLE rank_results (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*rank_results/);
  assert.deepEqual(backupFiles(filePath), ["v6-conflict.sqlite3.v6.bak"]);

  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(verify.prepare("SELECT discord_user_id FROM tracked_members").all(), [{ discord_user_id: "laowang" }]);
    assert.deepEqual(verify.prepare("SELECT name FROM pragma_table_info('rank_results')").all(), [{ name: "stray" }]);
    assert.deepEqual(verify.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'rank_results_by_%'").all(), [], "the indexes of the failed step are gone");
  } finally {
    verify.close();
  }
});

test("a database from a newer bot is rejected and left untouched", () => {
  const filePath = join(directory, "newer.sqlite3");
  process.env.DATABASE_PATH = filePath;
  const newer = SCHEMA_VERSION + 1;
  const database = new Database(filePath);
  database.pragma(`user_version = ${newer}`);
  database.close();
  assert.throws(() => getDatabase(), new RegExp(`Database schema ${newer} is newer than this bot supports \\(${SCHEMA_VERSION}\\)`));
  assert.deepEqual(backupFiles(filePath), [], "a newer file is not backed up either");
  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), newer);
  } finally {
    verify.close();
  }
});

test("a stored result survives closing and reopening the database, also across processes", () => {
  assert.equal(recordRankResults([RESULT]), 1);
  closeDatabase();
  assert.deepEqual(listRankResults("guild-one", { mock: false }), [RESULT]);

  const output = runSeparateProcess(`
    const { listRankResults } = require(${JSON.stringify(resolve(__dirname, "../src/store/rankStore.ts"))});
    process.stdout.write(JSON.stringify(listRankResults('guild-one', { mock: false })));
  `);
  assert.deepEqual(JSON.parse(output), [RESULT]);
});

test("a result is stored once per server, member, match and data mode", () => {
  assert.equal(recordRankResults([RESULT]), 1);
  assert.equal(recordRankResults([RESULT]), 0, "the same key again adds nothing");
  assert.equal(recordRankResults([{ ...RESULT, leaguePoints: 1, lpDelta: -63, recordedAt: RESULT.recordedAt + 1 }]), 0);
  assert.deepEqual(listRankResults("guild-one", { mock: false }), [RESULT], "and never changes the first one");

  // The mock key makes a mock result and a real one of the same match two rows.
  assert.equal(recordRankResults([{ ...RESULT, mock: true, leaguePoints: 90 }]), 1);
  assert.equal(listRankResults("guild-one", { mock: false }).length, 1);
  assert.equal(listRankResults("guild-one", { mock: true }).length, 1);
  assert.equal(listRankResults("guild-one", { mock: true })[0].leaguePoints, 90);
  assert.equal(listRankResults("guild-one", { mock: false })[0].leaguePoints, 86);

  assert.equal(recordRankResults([
    { ...RESULT, guildId: "guild-two" },
    { ...RESULT, discordUserId: "xiaoli" },
    { ...RESULT, matchId: "NA1_101" },
  ]), 3);
  assert.equal((getDatabase().prepare("SELECT count(*) AS count FROM rank_results").get() as { count: number }).count, 5);
});

test("a batch is saved in one transaction, so one bad result saves none", () => {
  assert.throws(() => recordRankResults([{ ...RESULT, matchId: "NA1_200" }, { ...RESULT, matchId: "NA1_201", leaguePoints: -1 }]), TypeError);
  assert.equal(listRankResults("guild-one", { mock: false }).length, 0);
  assert.throws(() => recordRankResults([{ ...RESULT, matchId: "NA1_200" }, { ...RESULT, matchId: "NA1_201", tier: "" }]), TypeError);
  // A violation of the table's own checks rolls the batch back as well.
  assert.throws(() => recordRankResults([{ ...RESULT, matchId: "NA1_200" }, { ...RESULT, matchId: "NA1_201", kind: "placed", lpDelta: 5 }]), /CHECK/);
  assert.equal(listRankResults("guild-one", { mock: false }).length, 0);
});

test("results are listed per mode and member, oldest first, with an optional newest-first limit", () => {
  recordRankResults([
    { ...RESULT, matchId: "NA1_2", playedAt: 2000 },
    { ...RESULT, matchId: "NA1_1", playedAt: 1000 },
    { ...RESULT, matchId: "NA1_3", playedAt: 3000 },
    { ...RESULT, matchId: "NA1_4", playedAt: 1500, discordUserId: "xiaoli" },
    { ...RESULT, matchId: "NA1_5", playedAt: 1600, mock: true },
  ]);
  assert.deepEqual(listRankResults("guild-one", { mock: false, discordUserId: "laowang" }).map((result) => result.matchId), ["NA1_1", "NA1_2", "NA1_3"]);
  assert.deepEqual(listRankResults("guild-one", { mock: false }).map((result) => result.matchId), ["NA1_1", "NA1_4", "NA1_2", "NA1_3"]);
  assert.deepEqual(listRankResults("guild-one", { mock: false, discordUserId: "laowang", order: "desc", limit: 2 }).map((result) => result.matchId), ["NA1_3", "NA1_2"]);
  assert.deepEqual(listRankResults("guild-one", { mock: true }).map((result) => result.matchId), ["NA1_5"]);
  assert.deepEqual(listRankResults("guild-two", { mock: false }), []);
  assert.throws(() => listRankResults("guild-one", {} as never), TypeError);
  assert.throws(() => listRankResults("guild-one", { mock: false, limit: 0 }), TypeError);
});

test("erasing a member deletes that member's rank results with the horse records and nothing else", () => {
  const mine = makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100" });
  const theirs = makeHorseRecord({ guildId: "guild-one", discordUserId: "xiaoli", puuid: "account-b", matchId: "NA1_100" });
  recordTracked([mine, theirs]);
  recordRankResults([
    RESULT,
    { ...RESULT, mock: true },
    { ...RESULT, matchId: "NA1_101", kind: "demoted", lpDelta: null },
    { ...RESULT, guildId: "guild-two" },
    { ...RESULT, discordUserId: "xiaoli" },
  ]);
  closeAppeal({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100", mock: false });

  assert.equal(eraseMemberHorseRecords("guild-one", "laowang"), 1, "the return value still counts horse records");
  assert.deepEqual(listRankResults("guild-one", { mock: false, discordUserId: "laowang" }), []);
  assert.deepEqual(listRankResults("guild-one", { mock: true, discordUserId: "laowang" }), []);
  assert.equal(listRankResults("guild-two", { mock: false }).length, 1, "another server is untouched");
  assert.equal(listRankResults("guild-one", { mock: false, discordUserId: "xiaoli" }).length, 1, "another member is untouched");
  assert.equal(listHorseRecords("guild-one", { mock: false, discordUserId: "xiaoli" }).length, 1);
  assert.equal(isAppealClosed({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100", mock: false }), false);

  assert.equal(eraseMemberRankResults("guild-one", "xiaoli"), 1);
  assert.equal(eraseMemberRankResults("guild-one", "xiaoli"), 0);
});

test("erasing removes the rank results in the same transaction, so a failed erase keeps them", () => {
  recordTracked([makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100" })]);
  recordRankResults([RESULT]);
  getDatabase().exec("CREATE TRIGGER fail_erase BEFORE DELETE ON horse_records BEGIN SELECT RAISE(ABORT, 'erase refused'); END;");
  assert.throws(() => eraseMemberHorseRecords("guild-one", "laowang"), /erase refused/);
  assert.equal(listRankResults("guild-one", { mock: false }).length, 1, "the rank result was rolled back with the failed erase");
});

test("unbinding a member keeps their rank results", () => {
  recordTracked([makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100" })]);
  recordRankResults([RESULT]);
  getDatabase().prepare("DELETE FROM tracked_members WHERE guild_id = 'guild-one' AND discord_user_id = 'laowang'").run();
  assert.equal(listRankResults("guild-one", { mock: false }).length, 1);
});

test("a result needs valid fields, and the table refuses rows that break its rules", () => {
  assert.throws(() => recordRankResults([{ ...RESULT, guildId: " " }]), TypeError);
  assert.throws(() => recordRankResults([{ ...RESULT, kind: "pending" as never }]), TypeError);
  assert.throws(() => recordRankResults([{ ...RESULT, queueType: "aram" as never }]), TypeError);
  assert.throws(() => recordRankResults([{ ...RESULT, mock: 1 as never }]), TypeError);
  assert.equal(recordRankResults([]), 0);

  const insert = (columns: string, values: string) => () => getDatabase().exec(`INSERT INTO rank_results (guild_id, discord_user_id, match_id, mock, puuid, queue_type, played_at, recorded_at, ${columns}) VALUES ('g', 'u', 'm', 0, 'p', 'solo', 1, 1, ${values})`);
  assert.throws(insert("kind, tier, league_points", "'pending', 'GOLD', 1"), /CHECK/);
  assert.throws(insert("kind, tier, league_points", "'placed', 'GOLD', -1"), /CHECK/);
  assert.throws(insert("kind, tier, league_points", "'change', 'GOLD', 5"), /CHECK/, "a change needs a delta and a before-value");
  assert.throws(insert("kind, tier, league_points, lp_delta, before_tier, before_league_points", "'placed', 'GOLD', 5, 5, NULL, NULL"), /CHECK/, "a placement has no delta");
  assert.throws(insert("kind, tier, league_points, before_tier, before_league_points", "'placed', 'GOLD', 5, 'SILVER', 3"), /CHECK/, "a placement has no before-value");
  assert.throws(insert("kind, tier, division, league_points", "'unattributable', 'GOLD', 'V', 5"), /CHECK/);
  assert.throws(insert("kind, tier, league_points, before_tier", "'unattributable', 'GOLD', 5, 'SILVER'"), /CHECK/, "a before-tier needs its LP");
  assert.doesNotThrow(insert("kind, tier, league_points", "'unattributable', 'MASTER', 300"));
});

// buildRankResult: which rows are final, and what they store.

const entry = (tier: string, rank: string, leaguePoints: number, wins = 10, losses = 10) =>
  ({ queueType: "RANKED_SOLO_5x5", tier, rank, leaguePoints, wins, losses });
const CONTEXT = { guildId: "g", discordUserId: "u", matchId: "m", mock: false, puuid: "p", gameEndTimestamp: 5000, recordedAt: 9000 };

test("only final rows become results, and a demotion drops its delta but keeps its ranks", () => {
  const before = entry("GOLD", "IV", 5);
  const after = entry("SILVER", "I", 75, 10, 11);
  for (const kind of ["pending", "stale", "unavailable"] as const) {
    assert.equal(buildRankResult({ queueType: "RANKED_SOLO_5x5", state: { kind } }, CONTEXT), null, kind);
  }
  const demoted: RankResult = {
    guildId: "g", discordUserId: "u", matchId: "m", mock: false, puuid: "p", queueType: "solo", playedAt: 5000, recordedAt: 9000,
    kind: "demoted", tier: "SILVER", division: "I", leaguePoints: 75, lpDelta: null,
    beforeTier: "GOLD", beforeDivision: "IV", beforeLeaguePoints: 5,
  };
  assert.deepEqual(buildRankResult({ queueType: "RANKED_SOLO_5x5", state: { kind: "demoted", delta: -30, before, after } }, CONTEXT), demoted);
  const promoted = buildRankResult({ queueType: "RANKED_FLEX_SR", state: { kind: "promoted", delta: 24, before: entry("PLATINUM", "I", 90), after: entry("EMERALD", "IV", 14, 11, 10) } }, CONTEXT);
  assert.equal(promoted?.queueType, "flex");
  assert.equal(promoted?.lpDelta, 24);
  const placed = buildRankResult({ queueType: "RANKED_SOLO_5x5", state: { kind: "placed", after: entry("GOLD", "IV", 0) } }, CONTEXT);
  assert.deepEqual([placed?.kind, placed?.lpDelta, placed?.beforeTier], ["placed", null, null]);
  const lost = buildRankResult({ queueType: "RANKED_SOLO_5x5", state: { kind: "unattributable", after: entry("GOLD", "IV", 12) } }, CONTEXT);
  assert.deepEqual([lost?.kind, lost?.lpDelta, lost?.beforeTier], ["unattributable", null, null]);
});

test("apex tiers store no division, and a missing game end falls back to the record time", () => {
  const result = buildRankResult({
    queueType: "RANKED_SOLO_5x5",
    state: { kind: "change", delta: 25, before: entry("DIAMOND", "I", 90), after: entry("MASTER", "I", 15, 11, 10) },
  }, { ...CONTEXT, gameEndTimestamp: null });
  assert.equal(result?.division, null);
  assert.equal(result?.beforeDivision, "I");
  assert.equal(result?.playedAt, 9000);
  assert.equal(recordRankResults([result!]), 1, "the table accepts it");
});
