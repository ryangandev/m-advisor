/** The literal version 5 schema, frozen: a shipped migration is never edited, so this fixture never needs to follow the code. */
export const SCHEMA_V5 = `
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
  CREATE TABLE pregame_settings (
    guild_id TEXT PRIMARY KEY CHECK(length(trim(guild_id)) > 0),
    voice_enabled INTEGER NOT NULL CHECK(voice_enabled IN (0, 1))
  ) STRICT;
  PRAGMA user_version = 5;
`;
export const ROWS_V5 = `
  INSERT INTO tracked_members VALUES ('guild-one', 'laowang', 0);
  INSERT INTO member_accounts VALUES ('guild-one', 'laowang', 'puuid-w1', '老王', 'NA1', 0);
  INSERT INTO guild_preferences VALUES ('guild-one', 'sweet');
  INSERT INTO pregame_settings VALUES ('guild-one', 0);
`;
