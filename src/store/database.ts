import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;
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

    if (version === 0) {
      connection.transaction(() => {
        connection!.exec(`
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
        `);
        connection!.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
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
