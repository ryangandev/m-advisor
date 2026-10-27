import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { listTrackedMembers } from "../src/store/bindingStore";
import { closeDatabase, getDatabase } from "../src/store/database";
import { listHorseRecords, recordHorseRecords } from "../src/store/horseRecordStore";
import {
  getReportMark,
  getReportSettings,
  listReportDestinations,
  markReportHandled,
  setReportChannel,
  setReportKindEnabled,
  setReportRoleHolders,
  setReportRoles,
} from "../src/store/reportStore";
import { makeHorseRecord } from "./helpers/horseRecords";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-reports-"));
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

// The schema exactly as version 3 of the bot created it (versions 1 and 2 folded in), written the way a running v3 bot leaves its file.
const SCHEMA_V3 = `
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
  CREATE TABLE horse_records (
    guild_id TEXT NOT NULL CHECK(length(trim(guild_id)) > 0),
    discord_user_id TEXT NOT NULL CHECK(length(trim(discord_user_id)) > 0),
    match_id TEXT NOT NULL CHECK(length(trim(match_id)) > 0),
    puuid TEXT NOT NULL CHECK(length(trim(puuid)) > 0),
    mock INTEGER NOT NULL CHECK(mock IN (0, 1)),
    team_id INTEGER NOT NULL,
    game_version TEXT,
    played_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    queue_id INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 0),
    won INTEGER NOT NULL CHECK(won IN (0, 1)),
    position TEXT CHECK(position IS NULL OR position IN ('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY')),
    champion_id INTEGER NOT NULL,
    champion_name TEXT NOT NULL,
    kills INTEGER NOT NULL CHECK(kills >= 0),
    deaths INTEGER NOT NULL CHECK(deaths >= 0),
    assists INTEGER NOT NULL CHECK(assists >= 0),
    tier TEXT NOT NULL CHECK(tier IN ('特等马', '上等马', '中等马', '下等马', '没有马')),
    team_rank INTEGER NOT NULL CHECK(team_rank >= 1),
    team_size INTEGER NOT NULL CHECK(team_size >= team_rank),
    score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
    composite REAL NOT NULL,
    score_above REAL,
    score_below REAL,
    dimensions TEXT NOT NULL CHECK(json_valid(dimensions)),
    features TEXT NOT NULL CHECK(json_valid(features)),
    benchmark_version INTEGER NOT NULL,
    benchmark_collected_at TEXT NOT NULL,
    commentary_tone TEXT CHECK(commentary_tone IS NULL OR commentary_tone IN ('praise', 'roast')),
    commentary TEXT CHECK(commentary IS NULL OR length(trim(commentary)) > 0),
    moment_kind TEXT CHECK(moment_kind IS NULL OR length(trim(moment_kind)) > 0),
    CHECK((commentary IS NULL) = (commentary_tone IS NULL)),
    CHECK(moment_kind IS NULL OR commentary IS NOT NULL),
    PRIMARY KEY (guild_id, discord_user_id, match_id, mock)
  ) STRICT;
  CREATE INDEX horse_records_by_member ON horse_records(guild_id, discord_user_id, mock, played_at);
  CREATE INDEX horse_records_by_time ON horse_records(guild_id, mock, played_at);
  CREATE INDEX horse_records_by_match ON horse_records(guild_id, match_id);
  PRAGMA user_version = 3;
`;

const ROWS_V3 = `
  INSERT INTO tracked_members VALUES ('guild-one', 'laowang', 0), ('guild-one', 'xiaoli', 1);
  INSERT INTO member_accounts VALUES
    ('guild-one', 'laowang', 'puuid-w1', '老王', 'NA1', 0),
    ('guild-one', 'xiaoli', 'puuid-l', 'Xiao Li', 'NA2', 0);
  INSERT INTO guild_preferences VALUES ('guild-one', 'sweet');
  INSERT INTO horse_records VALUES (
    'guild-one', 'laowang', 'NA1_HISTORY', 'puuid-w1', 0, 100, '16.19.100.1', 1800000000000, 1800000100000, 420, 1800, 1,
    'MIDDLE', 103, 'Ahri', 7, 2, 9, '特等马', 1, 5, 9.1, 0.91, NULL, 6.2,
    '{"damage":0.9,"teamfight":0.8}', '{"damageShare":0.3}', 1, '2026-10-03', 'praise', '老王这把像条龙。', NULL
  );
`;

function writeVersionThreeDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('foreign_keys = ON');
    db.exec(${JSON.stringify(SCHEMA_V3)});
    db.exec(${JSON.stringify(ROWS_V3)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

test("a version 3 database upgrades to version 4 with a backup and keeps members, preferences and horse history", () => {
  const filePath = join(directory, "v3.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionThreeDatabase(filePath);

  assert.equal(getReportSettings("guild-one"), undefined);
  assert.equal(getDatabase().pragma("user_version", { simple: true }), 4);
  assert.deepEqual(listTrackedMembers("guild-one").map((member) => member.discordUserId), ["laowang", "xiaoli"]);
  assert.equal((getDatabase().prepare("SELECT voice_style FROM guild_preferences").get() as { voice_style: string }).voice_style, "sweet");
  const history = listHorseRecords("guild-one", { mock: false });
  assert.equal(history.length, 1);
  assert.equal(history[0].matchId, "NA1_HISTORY");
  assert.equal(history[0].commentary, "老王这把像条龙。");
  assert.deepEqual(listReportDestinations(), []);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  // The backup is the version 3 file written from the uncheckpointed WAL: it has the horse row and no report tables.
  assert.deepEqual(backupFiles(filePath), ["v3.sqlite3.v3.bak"]);
  const backup = new Database(`${filePath}.v3.bak`, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      [{ name: "guild_preferences" }, { name: "horse_records" }, { name: "member_accounts" }, { name: "tracked_members" }]);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM horse_records").get() as { count: number }).count, 1);
  } finally {
    backup.close();
  }

  // The upgraded file takes settings, and reopening it adds neither a backup nor a change.
  setReportChannel("guild-one", "channel-1");
  closeDatabase();
  assert.equal(getReportSettings("guild-one")?.channelId, "channel-1");
  assert.deepEqual(backupFiles(filePath), ["v3.sqlite3.v3.bak"]);
});

test("a failed version 4 step rolls back and leaves the version 3 database intact", () => {
  const filePath = join(directory, "v3-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionThreeDatabase(filePath, "CREATE TABLE report_marks (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*report_marks/);
  assert.deepEqual(backupFiles(filePath), ["v3-conflict.sqlite3.v3.bak"]);

  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), 3);
    assert.equal((verify.prepare("SELECT count(*) AS count FROM horse_records").get() as { count: number }).count, 1);
    // The step created report_settings before it hit the conflict; the rollback must have removed it.
    assert.deepEqual(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'report_settings'").all(), []);
  } finally {
    verify.close();
  }
});

test("a fresh database has the report tables and is not backed up", () => {
  const filePath = process.env.DATABASE_PATH!;
  const db = getDatabase();
  assert.equal(db.pragma("user_version", { simple: true }), 4);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'report_%' ORDER BY name").all(),
    [{ name: "report_marks" }, { name: "report_settings" }]);
  closeDatabase();
  assert.deepEqual(backupFiles(filePath), []);
});

test("an unconfigured server has no settings, and setting a channel creates the defaults", () => {
  assert.equal(getReportSettings("guild-one"), undefined);
  assert.equal(setReportChannel("guild-one", "channel-1"), true, "the first channel reports that it was newly set");
  assert.deepEqual(getReportSettings("guild-one"), {
    guildId: "guild-one",
    channelId: "channel-1",
    dailyEnabled: true,
    weeklyEnabled: true,
    rolesEnabled: false,
    topRoleId: null,
    noneRoleId: null,
    topHolderIds: [],
    noneHolderIds: [],
  });
  assert.equal(setReportChannel("guild-one", "channel-2"), false, "moving the channel is not a new setup");
  assert.equal(getReportSettings("guild-one")?.channelId, "channel-2");
  assert.deepEqual(listReportDestinations().map((settings) => settings.guildId), ["guild-one"]);
  assert.equal(setReportChannel("guild-one", null), false);
  assert.deepEqual(listReportDestinations(), [], "a server without a channel is never scheduled");
  assert.equal(setReportChannel("guild-one", "channel-3"), true, "setting the channel again after clearing it is a new setup");
});

test("daily and weekly switches are independent and per server", () => {
  setReportChannel("guild-one", "channel-1");
  setReportChannel("guild-two", "channel-9");
  setReportKindEnabled("guild-one", "day", false);
  assert.equal(getReportSettings("guild-one")?.dailyEnabled, false);
  assert.equal(getReportSettings("guild-one")?.weeklyEnabled, true);
  assert.equal(getReportSettings("guild-two")?.dailyEnabled, true);
  setReportKindEnabled("guild-one", "week", false);
  setReportKindEnabled("guild-one", "day", true);
  assert.equal(getReportSettings("guild-one")?.dailyEnabled, true);
  assert.equal(getReportSettings("guild-one")?.weeklyEnabled, false);
  assert.throws(() => setReportKindEnabled("guild-one", "month" as never, true), /day or week/);
});

test("weekly roles need two different roles and keep holders only for unchanged roles", () => {
  setReportChannel("guild-one", "channel-1");
  assert.throws(() => setReportRoles("guild-one", { enabled: true, topRoleId: "r1", noneRoleId: "r1" }), /different/);
  setReportRoles("guild-one", { enabled: true, topRoleId: "r1", noneRoleId: "r2" });
  setReportRoleHolders("guild-one", { top: ["a", "a"], none: ["b"] });
  assert.deepEqual(getReportSettings("guild-one")?.topHolderIds, ["a"], "duplicates collapse");
  setReportRoles("guild-one", { enabled: false });
  assert.deepEqual(
    [getReportSettings("guild-one")?.rolesEnabled, getReportSettings("guild-one")?.topRoleId],
    [false, "r1"], "turning roles off remembers which roles they were");
  // Re-enabling with the same role keeps who holds it; a different role forgets that role's holders.
  setReportRoles("guild-one", { enabled: true, topRoleId: "r1", noneRoleId: "r3" });
  const settings = getReportSettings("guild-one")!;
  assert.deepEqual([settings.rolesEnabled, settings.topRoleId, settings.noneRoleId, settings.topHolderIds, settings.noneHolderIds], [true, "r1", "r3", ["a"], []]);
  // The table itself refuses enabled roles without role IDs.
  assert.throws(() => getDatabase().prepare("UPDATE report_settings SET top_role_id = NULL WHERE guild_id = 'guild-one'").run(), /CHECK/);
});

test("marks move only forward and mock and real marks are separate", () => {
  assert.equal(getReportMark("guild-one", false, "day"), undefined);
  markReportHandled("guild-one", false, "day", 2_000, 10);
  markReportHandled("guild-one", false, "day", 1_000, 20);
  assert.equal(getReportMark("guild-one", false, "day"), 2_000, "handling an older period never moves the mark back");
  markReportHandled("guild-one", false, "day", 3_000, 30);
  assert.equal(getReportMark("guild-one", false, "day"), 3_000);
  assert.equal(getReportMark("guild-one", true, "day"), undefined, "a mock rehearsal does not use up a real report");
  assert.equal(getReportMark("guild-one", false, "week"), undefined);
  assert.equal(getReportMark("guild-two", false, "day"), undefined);
});

test("report settings and marks leave horse history alone", () => {
  getDatabase().prepare("INSERT INTO tracked_members VALUES ('guild-one', 'laowang', 0)").run();
  getDatabase().prepare("INSERT INTO member_accounts VALUES ('guild-one', 'laowang', 'puuid-w1', 'W', 'NA1', 0)").run();
  recordHorseRecords([makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", puuid: "puuid-w1" })]);
  setReportChannel("guild-one", "channel-1");
  markReportHandled("guild-one", false, "week", 5, 6);
  assert.equal(listHorseRecords("guild-one", { mock: false }).length, 1);
});
