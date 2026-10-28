import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { getAnnouncerState, getPregameVoiceEnabled, setPregameVoiceEnabled } from "../src/store/announcerStore";
import { listTrackedMembers } from "../src/store/bindingStore";
import { SCHEMA_VERSION, closeDatabase, getDatabase } from "../src/store/database";
import { getReportSettings } from "../src/store/reportStore";
import { backupLine, captureConsole } from "./helpers/captureConsole";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-pregame-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

function runSeparateProcess(source: string): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

function backupFiles(filePath: string): string[] {
  const prefix = `${basename(filePath)}.v`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
}

const SCHEMA_V4 = `
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
  CREATE TABLE report_settings (
    guild_id TEXT PRIMARY KEY CHECK(length(trim(guild_id)) > 0),
    channel_id TEXT CHECK(channel_id IS NULL OR length(trim(channel_id)) > 0),
    daily_enabled INTEGER NOT NULL DEFAULT 1 CHECK(daily_enabled IN (0, 1)),
    weekly_enabled INTEGER NOT NULL DEFAULT 1 CHECK(weekly_enabled IN (0, 1)),
    roles_enabled INTEGER NOT NULL DEFAULT 0 CHECK(roles_enabled IN (0, 1)),
    top_role_id TEXT CHECK(top_role_id IS NULL OR length(trim(top_role_id)) > 0),
    none_role_id TEXT CHECK(none_role_id IS NULL OR length(trim(none_role_id)) > 0),
    top_holder_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(top_holder_ids)),
    none_holder_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(none_holder_ids)),
    CHECK(roles_enabled = 0 OR (top_role_id IS NOT NULL AND none_role_id IS NOT NULL))
  ) STRICT;
  CREATE TABLE report_marks (
    guild_id TEXT NOT NULL CHECK(length(trim(guild_id)) > 0),
    mock INTEGER NOT NULL CHECK(mock IN (0, 1)),
    kind TEXT NOT NULL CHECK(kind IN ('day', 'week')),
    period_start INTEGER NOT NULL,
    handled_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, mock, kind)
  ) STRICT;
  PRAGMA user_version = 4;
`;
const ROWS_V4 = `
  INSERT INTO tracked_members VALUES ('guild-one', 'laowang', 0);
  INSERT INTO member_accounts VALUES ('guild-one', 'laowang', 'puuid-w1', '老王', 'NA1', 0);
  INSERT INTO guild_preferences VALUES ('guild-one', 'sweet');
  INSERT INTO report_settings (guild_id, channel_id) VALUES ('guild-one', 'channel-1');
`;

function writeVersionFourDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('foreign_keys = ON');
    db.exec(${JSON.stringify(SCHEMA_V4)});
    db.exec(${JSON.stringify(ROWS_V4)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

test("a version 4 database upgrades to the current version with a backup, default on and its data intact", (t) => {
  const log = captureConsole(t);
  const filePath = join(directory, "v4.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionFourDatabase(filePath);

  assert.equal(getPregameVoiceEnabled("guild-one"), true);
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(getDatabase().prepare("SELECT * FROM pregame_settings").all(), []);
  assert.deepEqual(listTrackedMembers("guild-one").map((member) => member.discordUserId), ["laowang"]);
  assert.equal(getAnnouncerState("guild-one").voiceStyle, "sweet");
  assert.equal(getReportSettings("guild-one")?.channelId, "channel-1");
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  assert.deepEqual(backupFiles(filePath), ["v4.sqlite3.v4.bak"]);
  assert.equal(log.lines.filter((line) => backupLine(4, filePath).test(line)).length, 1, "the backup is announced once");
  const backup = new Database(`${filePath}.v4.bak`, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 4);
    assert.deepEqual(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'pregame_settings'").all(), []);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM report_settings").get() as { count: number }).count, 1);
  } finally {
    backup.close();
  }
});

test("the pregame voice switch defaults on, can be turned off and on, and survives reopening", () => {
  assert.equal(getPregameVoiceEnabled("guild-a"), true);
  setPregameVoiceEnabled("guild-a", false);
  assert.equal(getPregameVoiceEnabled("guild-a"), false);
  assert.equal(getPregameVoiceEnabled("guild-b"), true, "another server keeps the default");
  closeDatabase();
  assert.equal(getPregameVoiceEnabled("guild-a"), false);
  setPregameVoiceEnabled("guild-a", true);
  closeDatabase();
  assert.equal(getPregameVoiceEnabled("guild-a"), true);
  assert.throws(() => setPregameVoiceEnabled("  ", false), TypeError);
  assert.throws(() => getPregameVoiceEnabled(""), TypeError);
  assert.throws(() => getDatabase().prepare("INSERT INTO pregame_settings VALUES ('guild-c', 2)").run(), /CHECK/);
});

test("a failed version 5 step rolls back and leaves the version 4 database intact", (t) => {
  const log = captureConsole(t);
  const filePath = join(directory, "v4-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionFourDatabase(filePath, "CREATE TABLE pregame_settings (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*pregame_settings/);
  assert.deepEqual(backupFiles(filePath), ["v4-conflict.sqlite3.v4.bak"]);
  assert.equal(log.lines.filter((line) => backupLine(4, filePath).test(line)).length, 1, "the backup is announced once");

  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), 4);
    assert.deepEqual(verify.prepare("SELECT discord_user_id FROM tracked_members").all(), [{ discord_user_id: "laowang" }]);
    assert.deepEqual(verify.prepare("SELECT name FROM pragma_table_info('pregame_settings')").all(), [{ name: "stray" }]);
  } finally {
    verify.close();
  }
});

test("a database from a newer bot is still rejected", () => {
  const CURRENT = (getDatabase().pragma("user_version", { simple: true }) as number);
  closeDatabase();
  const filePath = join(directory, "future.sqlite3");
  process.env.DATABASE_PATH = filePath;
  const future = new Database(filePath);
  future.exec(`CREATE TABLE future_marker (value TEXT); PRAGMA user_version = ${CURRENT + 1};`);
  future.close();
  assert.throws(() => getDatabase(), new RegExp(`schema ${CURRENT + 1} is newer`));
});
