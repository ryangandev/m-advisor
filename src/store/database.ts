import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logInfo } from "../utils/log";

/**
 * Entry i upgrades a database from schema version i to i + 1.
 * Never edit a shipped entry; append a new one so existing files upgrade in place.
 */
const MIGRATIONS: readonly string[] = [
  // 0 -> 1: the original single-member schema.
  `
    CREATE TABLE guild_bindings (
      guild_id TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL CHECK(length(trim(discord_user_id)) > 0)
    ) STRICT;
    CREATE TABLE bound_accounts (
      guild_id TEXT NOT NULL REFERENCES guild_bindings(guild_id) ON DELETE CASCADE,
      puuid TEXT NOT NULL CHECK(length(trim(puuid)) > 0),
      game_name TEXT NOT NULL CHECK(length(trim(game_name)) > 0),
      tag_line TEXT NOT NULL CHECK(length(trim(tag_line)) > 0),
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY (guild_id, puuid),
      UNIQUE (guild_id, position)
    ) STRICT;
    CREATE TABLE guild_preferences (
      guild_id TEXT PRIMARY KEY,
      voice_style TEXT NOT NULL CHECK(voice_style IN ('sweet', 'old'))
    ) STRICT;
  `,
  // 1 -> 2: several tracked members per guild, each with their own ordered accounts.
  `
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
    INSERT INTO tracked_members (guild_id, discord_user_id, position)
      SELECT guild_id, discord_user_id, 0 FROM guild_bindings;
    INSERT INTO member_accounts (guild_id, discord_user_id, puuid, game_name, tag_line, position)
      SELECT a.guild_id, b.discord_user_id, a.puuid, a.game_name, a.tag_line, a.position
      FROM bound_accounts a JOIN guild_bindings b ON b.guild_id = a.guild_id;
    DROP TABLE bound_accounts;
    DROP TABLE guild_bindings;
  `,
  // 2 -> 3: the 马厩, one permanent horse record per tracked member per announced match.
  // Deliberately no foreign key to tracked_members: a member's history must survive /unbind.
  `
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
  `,
  // 3 -> 4: per-server 马报 settings (channel, daily/weekly switches, optional weekly roles) and which periods were already posted.
  // Only new tables, so every existing row is untouched.
  `
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
  `,
  // 4 -> 5: the per-server switch for the pre-game voice line. No row means on, so every existing server keeps the default.
  // Only a new table, so every existing row is untouched.
  `
    CREATE TABLE pregame_settings (
      guild_id TEXT PRIMARY KEY CHECK(length(trim(guild_id)) > 0),
      voice_enabled INTEGER NOT NULL CHECK(voice_enabled IN (0, 1))
    ) STRICT;
  `,
];
const SCHEMA_VERSION = MIGRATIONS.length;
let database: Database.Database | undefined;

/** Resolved lazily so importing a store does not create a database. */
export function getDatabasePath(): string {
  const configuredPath = process.env.DATABASE_PATH?.trim();
  if (configuredPath === ":memory:") {
    return configuredPath;
  }
  if (configuredPath) {
    return resolve(configuredPath);
  }
  return resolve(process.env.BOT_DATA_DIR?.trim() || ".data", "bot.sqlite3");
}

/**
 * A consistent copy of the database next to it, written before any migration step.
 * An existing backup is never overwritten: a later name is used instead.
 */
function backUpBeforeMigration(connection: Database.Database, filePath: string, version: number): string {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const backupPath = attempt === 1 ? `${filePath}.v${version}.bak` : `${filePath}.v${version}.${attempt}.bak`;
    if (existsSync(backupPath)) continue;
    try {
      connection.prepare("VACUUM INTO ?").run(backupPath);
    } catch (error) {
      // Another process may have taken this name between the check and the copy.
      if (existsSync(backupPath)) continue;
      throw error;
    }
    chmodSync(backupPath, 0o600);
    return backupPath;
  }
  throw new Error(`Could not find an unused backup name for ${filePath}.`);
}

/** The process owns one connection, opened only on the first store operation. */
export function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  const filePath = getDatabasePath();
  const fileBacked = filePath !== ":memory:";
  if (fileBacked) {
    const directory = dirname(filePath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }

  let connection: Database.Database | undefined;
  try {
    connection = new Database(filePath);
    if (fileBacked) {
      // SQLite's WAL and SHM files inherit the database file's permissions.
      chmodSync(filePath, 0o600);
    }
    connection.pragma("busy_timeout = 5000");
    connection.pragma("foreign_keys = ON");

    const version = connection.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema ${version} is newer than this bot supports (${SCHEMA_VERSION}).`);
    }

    if (fileBacked && version > 0 && version < SCHEMA_VERSION) {
      const backupPath = backUpBeforeMigration(connection, filePath, version);
      logInfo(`Backed up the version ${version} database to ${backupPath} before upgrading it.`);
    }
    for (let from = version; from < MIGRATIONS.length; from += 1) {
      // The write lock is taken up front and the version re-read under it, so a process that opens the
      // same file at the same moment applies each step once. A failure rolls the step and its version bump back together.
      connection.transaction(() => {
        const current = connection!.pragma("user_version", { simple: true }) as number;
        if (current !== from) return;
        connection!.exec(MIGRATIONS[from]);
        connection!.pragma(`user_version = ${from + 1}`);
      }).immediate();
    }
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = FULL");
    database = connection;
    return database;
  } catch (error) {
    connection?.close();
    throw new Error(`Could not open the bot database at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Close during graceful shutdown; a later store operation opens a new connection. */
export function closeDatabase(): void {
  database?.close();
  database = undefined;
}
