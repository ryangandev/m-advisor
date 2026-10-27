import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { getTrackedMember, listTrackedMembers, removeTrackedMember, setMemberAccounts } from "../src/store/bindingStore";
import { SCHEMA_VERSION, closeDatabase, getDatabase } from "../src/store/database";
import {
  countMemberHorseRecords,
  eraseMemberHorseRecords,
  listHorseRecords,
  listMatchHorseRecords,
  recordHorseRecords,
} from "../src/store/horseRecordStore";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-horses-"));
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
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function backupFiles(filePath: string): string[] {
  const prefix = `${basename(filePath)}.v`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
}

// The schema exactly as version 2 of the bot created it, written the way a running v2 bot leaves its file.
const SCHEMA_V2 = `
  CREATE TABLE tracked_members (
    guild_id TEXT NOT NULL CHECK(length(trim(guild_id)) > 0),
    discord_user_id TEXT NOT NULL CHECK(length(trim(discord_user_id)) > 0),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY (guild_id, discord_user_id),
    UNIQUE (guild_id, position)
  ) STRICT;
  CREATE TABLE member_accounts (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    puuid TEXT NOT NULL CHECK(length(trim(puuid)) > 0),
    game_name TEXT NOT NULL CHECK(length(trim(game_name)) > 0),
    tag_line TEXT NOT NULL CHECK(length(trim(tag_line)) > 0),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY (guild_id, puuid),
    UNIQUE (guild_id, discord_user_id, position),
    FOREIGN KEY (guild_id, discord_user_id) REFERENCES tracked_members(guild_id, discord_user_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE guild_preferences (
    guild_id TEXT PRIMARY KEY,
    voice_style TEXT NOT NULL CHECK(voice_style IN ('sweet', 'old'))
  ) STRICT;
  PRAGMA user_version = 2;
`;

function writeVersionTwoDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('foreign_keys = ON');
    db.exec(${JSON.stringify(SCHEMA_V2)});
    db.exec(${JSON.stringify(`
      INSERT INTO tracked_members VALUES ('guild-one', 'laowang', 0), ('guild-one', 'xiaoli', 1), ('guild-two', 'solo', 0);
      INSERT INTO member_accounts VALUES
        ('guild-one', 'laowang', 'puuid-w1', '老王', 'NA1', 0),
        ('guild-one', 'laowang', 'puuid-w2', '老王小号', 'NA1', 1),
        ('guild-one', 'xiaoli', 'puuid-l', 'Xiao Li', 'NA2', 0),
        ('guild-two', 'solo', 'puuid-s', 'Solo', 'NA3', 0);
      INSERT INTO guild_preferences VALUES ('guild-one', 'sweet'), ('guild-two', 'old');
    `)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

test("a version 2 database upgrades through version 3 to the current version with a backup and keeps every member", () => {
  const filePath = join(directory, "v2.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionTwoDatabase(filePath);

  const members = listTrackedMembers("guild-one");
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(members.map((member) => [member.discordUserId, member.accounts.map((account) => account.puuid)]), [
    ["laowang", ["puuid-w1", "puuid-w2"]],
    ["xiaoli", ["puuid-l"]],
  ]);
  assert.deepEqual(listTrackedMembers("guild-two").map((member) => member.discordUserId), ["solo"]);
  assert.equal((getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = 'guild-one'").get() as { voice_style: string }).voice_style, "sweet");
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }), []);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  // The backup is the version 2 file, written from the uncheckpointed WAL, with no horse table.
  assert.deepEqual(backupFiles(filePath), ["v2.sqlite3.v2.bak"]);
  const backupPath = `${filePath}.v2.bak`;
  if (process.platform !== "win32") assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  const backup = new Database(backupPath, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      [{ name: "guild_preferences" }, { name: "member_accounts" }, { name: "tracked_members" }]);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM member_accounts").get() as { count: number }).count, 4);
  } finally {
    backup.close();
  }

  // The upgraded file takes records, and a second open adds neither a backup nor a change.
  assert.equal(recordHorseRecords([makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", puuid: "puuid-w1" })]), 1);
  closeDatabase();
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(listHorseRecords("guild-one", { mock: false }).length, 1);
  assert.deepEqual(backupFiles(filePath), ["v2.sqlite3.v2.bak"]);
});

test("a failed version 3 step rolls back and leaves the version 2 database intact", () => {
  const filePath = join(directory, "v2-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionTwoDatabase(filePath, "CREATE TABLE horse_records (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*horse_records/);
  assert.deepEqual(backupFiles(filePath), ["v2-conflict.sqlite3.v2.bak"]);

  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), 2);
    assert.equal((verify.prepare("SELECT count(*) AS count FROM tracked_members").get() as { count: number }).count, 3);
    assert.equal((verify.prepare("SELECT count(*) AS count FROM member_accounts").get() as { count: number }).count, 4);
    assert.deepEqual(verify.prepare("SELECT name FROM pragma_table_info('horse_records')").all(), [{ name: "stray" }]);
  } finally {
    verify.close();
  }
});

test("a fresh database creates the horse table with its indexes and is not backed up", () => {
  const filePath = process.env.DATABASE_PATH!;
  const db = getDatabase();
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'horse_records' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), [
    { name: "horse_records_by_match" },
    { name: "horse_records_by_member" },
    { name: "horse_records_by_time" },
  ]);
  closeDatabase();
  assert.deepEqual(backupFiles(filePath), []);
});

test("recording the same match twice keeps one record, unchanged", () => {
  const record = makeHorseRecord({ matchId: "NA1_ONCE", tier: "特等马", teamRank: 1, score: 9.1, scoreAbove: null });
  assert.equal(recordTracked([record]), 1);
  assert.equal(recordTracked([record]), 0);
  // A later write for the same (guild, member, match) never rewrites the first one.
  assert.equal(recordTracked([{ ...record, tier: "没有马", teamRank: 5, score: 0.5 }]), 0);
  const stored = listHorseRecords("guild-one", { mock: false });
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], record);
});

test("another member, another guild or another match is a separate record", () => {
  const base = makeHorseRecord({ matchId: "NA1_SHARED" });
  const written = recordTracked([
    base,
    { ...base, discordUserId: "member-two", puuid: "account-b" },
    { ...base, guildId: "guild-two" },
    { ...base, matchId: "NA1_NEXT" },
  ]);
  assert.equal(written, 4);
  assert.deepEqual(listMatchHorseRecords("guild-one", "NA1_SHARED", false).map((record) => record.discordUserId), ["member-one", "member-two"]);
});

test("a batch with an invalid record writes nothing", () => {
  const good = makeHorseRecord({ matchId: "NA1_GOOD" });
  for (const bad of [
    makeHorseRecord({ tier: "神马" as never }),
    makeHorseRecord({ score: 11 }),
    makeHorseRecord({ score: Number.NaN }),
    makeHorseRecord({ discordUserId: " " }),
    makeHorseRecord({ teamRank: 6 }),
    makeHorseRecord({ dimensions: { vision: Number.POSITIVE_INFINITY } }),
    makeHorseRecord({ dimensions: { speed: 0.5 } as never }),
    makeHorseRecord({ position: "SIDE" as never }),
    makeHorseRecord({ mock: "yes" as never }),
  ]) {
    assert.throws(() => recordHorseRecords([good, bad]));
  }
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }), []);
});

test("the database itself refuses an unknown tier or a duplicate key", () => {
  const db = getDatabase();
  recordTracked([makeHorseRecord({ matchId: "NA1_DB" })]);
  assert.throws(() => db.prepare("UPDATE horse_records SET tier = '神马'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE horse_records SET dimensions = 'not json'").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO horse_records SELECT * FROM horse_records").run(), /UNIQUE|PRIMARY/);
});

test("history survives removing the member and rebinding", () => {
  setMemberAccounts("guild-one", "member-one", [{ puuid: "account-a", gameName: "Player A", tagLine: "NA1" }]);
  recordTracked([makeHorseRecord({ matchId: "NA1_KEEP_1" }), makeHorseRecord({ matchId: "NA1_KEEP_2" })]);

  assert.equal(removeTrackedMember("guild-one", "member-one"), true);
  assert.equal(getTrackedMember("guild-one", "member-one"), undefined);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false, discordUserId: "member-one" }).map((record) => record.matchId), ["NA1_KEEP_1", "NA1_KEEP_2"]);

  // Closing and reopening the file changes nothing, and a rebind picks the history back up.
  closeDatabase();
  setMemberAccounts("guild-one", "member-one", [{ puuid: "account-b", gameName: "Player B", tagLine: "NA2" }]);
  assert.equal(listHorseRecords("guild-one", { mock: false, discordUserId: "member-one" }).length, 2);
});

test("history has no foreign key to tracked members", () => {
  const references = getDatabase().prepare("SELECT * FROM pragma_foreign_key_list('horse_records')").all();
  assert.deepEqual(references, []);
});

test("erasing one member removes only their records, real and mock, and reports the count", () => {
  recordTracked([
    makeHorseRecord({ matchId: "NA1_E1" }),
    makeHorseRecord({ matchId: "NA1_E2" }),
    makeHorseRecord({ matchId: "MOCK_E3", mock: true }),
    makeHorseRecord({ matchId: "NA1_E1", discordUserId: "member-two", puuid: "account-b" }),
    makeHorseRecord({ matchId: "NA1_E1", guildId: "guild-two" }),
  ]);
  assert.deepEqual(countMemberHorseRecords("guild-one", "member-one"), { real: 2, mock: 1 });
  assert.equal(eraseMemberHorseRecords("guild-one", "member-one"), 3);
  assert.deepEqual(countMemberHorseRecords("guild-one", "member-one"), { real: 0, mock: 0 });
  assert.equal(eraseMemberHorseRecords("guild-one", "member-one"), 0);
  assert.equal(listHorseRecords("guild-one", { mock: false, discordUserId: "member-two" }).length, 1);
  assert.equal(listHorseRecords("guild-two", { mock: false, discordUserId: "member-one" }).length, 1);
});

test("mock and real records are never returned together", () => {
  recordTracked([
    makeHorseRecord({ matchId: "NA1_REAL" }),
    makeHorseRecord({ matchId: "MOCK_ONE", mock: true }),
  ]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }).map((record) => record.matchId), ["NA1_REAL"]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: true }).map((record) => record.matchId), ["MOCK_ONE"]);
  assert.deepEqual(listMatchHorseRecords("guild-one", "MOCK_ONE", false), []);
  assert.equal(listMatchHorseRecords("guild-one", "MOCK_ONE", true).length, 1);
  assert.deepEqual(countMemberHorseRecords("guild-one", "member-one"), { real: 1, mock: 1 });
  assert.throws(() => listHorseRecords("guild-one", {} as never), /mock or real/);
});

test("queries come back oldest first, newest first on request, and honor a limit", () => {
  recordTracked([
    makeHorseRecord({ matchId: "NA1_B", playedAt: 2000 }),
    makeHorseRecord({ matchId: "NA1_A", playedAt: 2000 }),
    makeHorseRecord({ matchId: "NA1_C", playedAt: 1000 }),
  ]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false }).map((record) => record.matchId), ["NA1_C", "NA1_A", "NA1_B"]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false, order: "desc" }).map((record) => record.matchId), ["NA1_B", "NA1_A", "NA1_C"]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false, order: "desc", limit: 1 }).map((record) => record.matchId), ["NA1_B"]);
});

test("a day range includes its first millisecond and excludes its last, across the 25-hour day", () => {
  const day = pacificDay(Date.parse("2026-11-01T12:00:00Z"));
  recordTracked([
    makeHorseRecord({ matchId: "BEFORE", playedAt: day.start - 1 }),
    makeHorseRecord({ matchId: "START", playedAt: day.start }),
    makeHorseRecord({ matchId: "FALL_BACK_ONE", playedAt: Date.parse("2026-11-01T09:30:00Z") }),
    makeHorseRecord({ matchId: "LAST", playedAt: day.end - 1 }),
    makeHorseRecord({ matchId: "END", playedAt: day.end }),
  ]);
  const inDay = listHorseRecords("guild-one", { mock: false, from: day.start, to: day.end });
  assert.deepEqual(inDay.map((record) => record.matchId), ["START", "FALL_BACK_ONE", "LAST"]);
  assert.equal((day.end - day.start) / 3_600_000, 25);
});

test("a week range follows Monday midnight Pacific, across the daylight saving change", () => {
  const week = pacificWeek(Date.parse("2026-03-08T20:00:00Z"));
  const sundayNight = Date.parse("2026-03-09T06:59:59Z");
  const mondayMorning = Date.parse("2026-03-09T07:00:00Z");
  recordTracked([
    makeHorseRecord({ matchId: "LAST_WEEK_SUNDAY", playedAt: week.start - 1 }),
    makeHorseRecord({ matchId: "MONDAY", playedAt: week.start }),
    makeHorseRecord({ matchId: "SPRING_FORWARD", playedAt: Date.parse("2026-03-08T11:00:00Z") }),
    makeHorseRecord({ matchId: "SUNDAY_NIGHT", playedAt: sundayNight }),
    makeHorseRecord({ matchId: "NEXT_MONDAY", playedAt: mondayMorning }),
  ]);
  assert.equal(week.end, mondayMorning);
  assert.deepEqual(
    listHorseRecords("guild-one", { mock: false, from: week.start, to: week.end }).map((record) => record.matchId),
    ["MONDAY", "SPRING_FORWARD", "SUNDAY_NIGHT"],
  );
  assert.deepEqual(
    listHorseRecords("guild-one", { mock: false, from: week.end, to: pacificWeek(week.end).end }).map((record) => record.matchId),
    ["NEXT_MONDAY"],
  );
});

test("a range can be limited to one member", () => {
  recordTracked([
    makeHorseRecord({ matchId: "NA1_R1", playedAt: 5000 }),
    makeHorseRecord({ matchId: "NA1_R1", playedAt: 5000, discordUserId: "member-two", puuid: "account-b" }),
  ]);
  assert.equal(listHorseRecords("guild-one", { mock: false, from: 0, to: 10_000 }).length, 2);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false, from: 0, to: 10_000, discordUserId: "member-two" }).map((record) => record.puuid), ["account-b"]);
});

test("a record round-trips with its dimensions, features and neighbour scores", () => {
  const record = makeHorseRecord({
    matchId: "NA1_ROUND",
    position: null,
    scoreAbove: null,
    scoreBelow: 1.25,
    dimensions: { vision: 0.91, frontline: 0 },
    features: { visionPerMinute: 2.4, deathsPerMinute: 0.1 },
    won: false,
  });
  recordTracked([record]);
  assert.deepEqual(listHorseRecords("guild-one", { mock: false })[0], record);
});
