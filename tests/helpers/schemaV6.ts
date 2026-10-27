import { ROWS_V5, SCHEMA_V5 } from "./schemaV5";

/** The literal version 6 schema, frozen: a shipped migration is never edited, so this fixture never needs to follow the code. */
export const SCHEMA_V6 = `
  ${SCHEMA_V5}
  CREATE TABLE appeal_cases (
    guild_id TEXT NOT NULL CHECK(length(trim(guild_id)) > 0),
    discord_user_id TEXT NOT NULL CHECK(length(trim(discord_user_id)) > 0),
    match_id TEXT NOT NULL CHECK(length(trim(match_id)) > 0),
    mock INTEGER NOT NULL CHECK(mock IN (0, 1)),
    closed_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id, match_id, mock)
  ) STRICT;
  CREATE INDEX appeal_cases_by_time ON appeal_cases(closed_at);
  PRAGMA user_version = 6;
`;

/** Rows a version 6 file already holds when it is upgraded: they must survive untouched. */
export const ROWS_V6 = `
  ${ROWS_V5}
  INSERT INTO appeal_cases VALUES ('guild-one', 'laowang', 'NA1_OLD', 0, 1800000000000);
`;
