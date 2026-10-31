import { DIMENSIONS, HORSE_TIERS } from "../services/horseRanking";
import type { Dimension, FeatureValues, HorseTier } from "../services/horseRanking";
import { POSITIONS } from "../types";
import type { Position } from "../types";
import { logWarn } from "../utils/log";
import { eraseMemberAppeals } from "./appealStore";
import { markMemberErased } from "./eraseCutoff";
import { getDatabase, truncateWal } from "./database";
import { eraseMemberRankResults } from "./rankStore";
import { UntrackedMemberError } from "./storeErrors";

export { UntrackedMemberError };

/**
 * One tracked member's result in one announced match: the permanent 马厩 entry.
 * Only tracked members are ever stored; teammates and enemies appear nowhere in it, not even by name.
 */
export interface HorseRecord {
  guildId: string;
  discordUserId: string;
  matchId: string;
  /** The member's Riot account that played the match. */
  puuid: string;
  /** Records made from mock fixtures are kept apart from real ones and never mixed into real statistics. */
  mock: boolean;
  /** Riot's team ID (100 or 200), so friends on opposite teams are never ranked against each other. */
  teamId: number;
  /** Riot's game version string, or null when the match data had none. */
  gameVersion: string | null;
  /** Game end in Unix milliseconds, or the time of recording when Riot omitted it. Range queries use this. */
  playedAt: number;
  recordedAt: number;
  queueId: number;
  durationSeconds: number;
  won: boolean;
  position: Position | null;
  championId: number;
  /** Riot's English champion identifier, the fallback when the Chinese name table has no entry. */
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  tier: HorseTier;
  /** 1 is the best of the team. */
  teamRank: number;
  teamSize: number;
  /** 0-10: the share of same-position reference players this performance beats. */
  score: number;
  composite: number;
  /** Score of the teammate ranked one place higher, or null for the 特等马: what it takes to move up. */
  scoreAbove: number | null;
  /** Score of the teammate ranked one place lower, or null for the last place: how close the drop is. */
  scoreBelow: number | null;
  /** Percentile (0-1) against the same position for each dimension the match had data for. */
  dimensions: Partial<Record<Dimension, number>>;
  /** The normalized statistics behind the dimensions, for explaining a verdict later. */
  features: FeatureValues;
  /** Which reference sample scored this record, since scores from different samples do not compare exactly. */
  benchmarkVersion: number;
  benchmarkCollectedAt: string;
  /** Which kind of line the announcement said about this member; null when it said nothing about them. */
  commentaryTone: "praise" | "roast" | null;
  /** The praise or roast the 军师 spoke about this member, for `/why` to quote. It names only this member. */
  commentary: string | null;
  /** The timeline moment the commentary cited (a MatchEvent kind), or null when it quoted a statistic. */
  momentKind: string | null;
}

export interface HorseRecordQuery {
  /** Mock and real records are never returned together. */
  mock: boolean;
  discordUserId?: string;
  /** Inclusive start, Unix milliseconds. */
  from?: number;
  /** Exclusive end, Unix milliseconds. */
  to?: number;
  /** Oldest first by default. Ties break by match ID so the order is stable. */
  order?: "asc" | "desc";
  limit?: number;
}

interface HorseRecordRow {
  guild_id: string;
  discord_user_id: string;
  match_id: string;
  puuid: string;
  mock: number;
  team_id: number;
  game_version: string | null;
  played_at: number;
  recorded_at: number;
  queue_id: number;
  duration_seconds: number;
  won: number;
  position: Position | null;
  champion_id: number;
  champion_name: string;
  kills: number;
  deaths: number;
  assists: number;
  tier: HorseTier;
  team_rank: number;
  team_size: number;
  score: number;
  composite: number;
  score_above: number | null;
  score_below: number | null;
  dimensions: string;
  features: string;
  benchmark_version: number;
  benchmark_collected_at: string;
  commentary_tone: "praise" | "roast" | null;
  commentary: string | null;
  moment_kind: string | null;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
}

function requireCount(value: unknown, name: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}.`);
  }
}

function requireFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
}

function validate(record: HorseRecord): void {
  if (!record || typeof record !== "object") throw new TypeError("A horse record must be an object.");
  requireString(record.guildId, "Guild ID");
  requireString(record.discordUserId, "Discord user ID");
  requireString(record.matchId, "Match ID");
  requireString(record.puuid, "Account PUUID");
  if (typeof record.mock !== "boolean") throw new TypeError("mock must be a boolean.");
  if (typeof record.won !== "boolean") throw new TypeError("won must be a boolean.");
  requireCount(record.teamId, "teamId");
  if (record.gameVersion !== null) requireString(record.gameVersion, "gameVersion");
  requireCount(record.playedAt, "playedAt");
  requireCount(record.recordedAt, "recordedAt");
  requireCount(record.queueId, "queueId");
  requireCount(record.durationSeconds, "durationSeconds");
  requireCount(record.championId, "championId");
  requireString(record.championName, "Champion name");
  requireCount(record.kills, "kills");
  requireCount(record.deaths, "deaths");
  requireCount(record.assists, "assists");
  if (!(HORSE_TIERS as readonly string[]).includes(record.tier)) throw new TypeError(`Unknown horse tier ${String(record.tier)}.`);
  if (record.position !== null && !(POSITIONS as readonly string[]).includes(record.position)) throw new TypeError("Unknown position.");
  requireCount(record.teamRank, "teamRank", 1);
  requireCount(record.teamSize, "teamSize", record.teamRank);
  requireFinite(record.score, "score");
  if (record.score < 0 || record.score > 10) throw new RangeError("score must be between 0 and 10.");
  requireFinite(record.composite, "composite");
  for (const neighbour of [record.scoreAbove, record.scoreBelow]) {
    if (neighbour !== null) requireFinite(neighbour, "A neighbouring score");
  }
  for (const [name, values] of [["dimensions", record.dimensions], ["features", record.features]] as const) {
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError(`${name} must be an object.`);
    for (const value of Object.values(values)) requireFinite(value, `A value in ${name}`);
  }
  for (const key of Object.keys(record.dimensions)) {
    if (!(DIMENSIONS as readonly string[]).includes(key)) throw new TypeError(`Unknown dimension ${key}.`);
  }
  requireCount(record.benchmarkVersion, "benchmarkVersion");
  requireString(record.benchmarkCollectedAt, "benchmarkCollectedAt");
  if (record.commentaryTone !== null && record.commentaryTone !== "praise" && record.commentaryTone !== "roast") {
    throw new TypeError("commentaryTone must be praise, roast or null.");
  }
  if (record.commentary !== null) requireString(record.commentary, "commentary");
  if ((record.commentary === null) !== (record.commentaryTone === null)) {
    throw new TypeError("commentary and commentaryTone must both be set or both be null.");
  }
  if (record.momentKind !== null) {
    requireString(record.momentKind, "momentKind");
    if (record.commentary === null) throw new TypeError("A cited moment needs the commentary that cited it.");
  }
}

function fromRow(row: HorseRecordRow): HorseRecord {
  return {
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    matchId: row.match_id,
    puuid: row.puuid,
    mock: row.mock === 1,
    teamId: row.team_id,
    gameVersion: row.game_version,
    playedAt: row.played_at,
    recordedAt: row.recorded_at,
    queueId: row.queue_id,
    durationSeconds: row.duration_seconds,
    won: row.won === 1,
    position: row.position,
    championId: row.champion_id,
    championName: row.champion_name,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    tier: row.tier,
    teamRank: row.team_rank,
    teamSize: row.team_size,
    score: row.score,
    composite: row.composite,
    scoreAbove: row.score_above,
    scoreBelow: row.score_below,
    dimensions: JSON.parse(row.dimensions) as HorseRecord["dimensions"],
    features: JSON.parse(row.features) as FeatureValues,
    benchmarkVersion: row.benchmark_version,
    benchmarkCollectedAt: row.benchmark_collected_at,
    commentaryTone: row.commentary_tone,
    commentary: row.commentary,
    momentKind: row.moment_kind,
  };
}

/**
 * Saves records in one transaction and returns how many were new.
 * A record for a (guild, member, match, mock) that already exists is left exactly as it was, so announcing or
 * recording the same match twice never creates a second entry or changes the first.
 * Every record must belong to a member who currently owns that Riot account in that server, checked inside the
 * transaction; otherwise UntrackedMemberError is thrown and nothing in the batch is saved. This keeps the table
 * to bound members even if a caller passes the wrong list.
 */
export function recordHorseRecords(records: readonly HorseRecord[]): number {
  records.forEach(validate);
  if (records.length === 0) return 0;
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO horse_records (
      guild_id, discord_user_id, match_id, puuid, mock, team_id, game_version, played_at, recorded_at, queue_id, duration_seconds, won,
      position, champion_id, champion_name, kills, deaths, assists, tier, team_rank, team_size, score, composite,
      score_above, score_below, dimensions, features, benchmark_version, benchmark_collected_at,
      commentary_tone, commentary, moment_kind
    ) VALUES (
      @guildId, @discordUserId, @matchId, @puuid, @mock, @teamId, @gameVersion, @playedAt, @recordedAt, @queueId, @durationSeconds, @won,
      @position, @championId, @championName, @kills, @deaths, @assists, @tier, @teamRank, @teamSize, @score, @composite,
      @scoreAbove, @scoreBelow, @dimensions, @features, @benchmarkVersion, @benchmarkCollectedAt,
      @commentaryTone, @commentary, @momentKind
    ) ON CONFLICT(guild_id, discord_user_id, match_id, mock) DO NOTHING
  `);
  const owns = db.prepare("SELECT 1 FROM member_accounts WHERE guild_id = ? AND discord_user_id = ? AND puuid = ?");
  return db.transaction(() => {
    for (const record of records) {
      if (!owns.get(record.guildId, record.discordUserId, record.puuid)) {
        throw new UntrackedMemberError(record.guildId, record.discordUserId, record.puuid);
      }
    }
    let inserted = 0;
    for (const record of records) {
      inserted += insert.run({
        ...record,
        mock: record.mock ? 1 : 0,
        won: record.won ? 1 : 0,
        dimensions: JSON.stringify(record.dimensions),
        features: JSON.stringify(record.features),
      }).changes;
    }
    return inserted;
  })();
}

/** Records of one server, oldest first, optionally for one member and a half-open time range [from, to). */
export function listHorseRecords(guildId: string, query: HorseRecordQuery): HorseRecord[] {
  requireString(guildId, "Guild ID");
  if (typeof query?.mock !== "boolean") throw new TypeError("A horse record query must say whether it wants mock or real records.");
  const conditions = ["guild_id = @guildId", "mock = @mock"];
  const parameters: Record<string, string | number> = { guildId, mock: query.mock ? 1 : 0 };
  if (query.discordUserId !== undefined) {
    requireString(query.discordUserId, "Discord user ID");
    conditions.push("discord_user_id = @discordUserId");
    parameters.discordUserId = query.discordUserId;
  }
  if (query.from !== undefined) {
    requireFinite(query.from, "from");
    conditions.push("played_at >= @from");
    parameters.from = query.from;
  }
  if (query.to !== undefined) {
    requireFinite(query.to, "to");
    conditions.push("played_at < @to");
    parameters.to = query.to;
  }
  const direction = query.order === "desc" ? "DESC" : "ASC";
  let sql = `SELECT * FROM horse_records WHERE ${conditions.join(" AND ")} ORDER BY played_at ${direction}, match_id ${direction}, discord_user_id ${direction}`;
  if (query.limit !== undefined) {
    requireCount(query.limit, "limit", 1);
    sql += " LIMIT @limit";
    parameters.limit = query.limit;
  }
  return (getDatabase().prepare(sql).all(parameters) as HorseRecordRow[]).map(fromRow);
}

/**
 * Every tracked member's record for one match, grouped by team and best first within a team.
 * Friends on opposite teams were ranked against their own teammates, so rank only within a `teamId`.
 */
export function listMatchHorseRecords(guildId: string, matchId: string, mock: boolean): HorseRecord[] {
  requireString(guildId, "Guild ID");
  requireString(matchId, "Match ID");
  const rows = getDatabase().prepare(
    "SELECT * FROM horse_records WHERE guild_id = ? AND match_id = ? AND mock = ? ORDER BY team_id, team_rank, discord_user_id",
  ).all(guildId, matchId, mock ? 1 : 0) as HorseRecordRow[];
  return rows.map(fromRow);
}

/** How many records exist for a member, mock and real counted separately. */
export function countMemberHorseRecords(guildId: string, discordUserId: string): { real: number; mock: number } {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  const rows = getDatabase().prepare(
    "SELECT mock, count(*) AS count FROM horse_records WHERE guild_id = ? AND discord_user_id = ? GROUP BY mock",
  ).all(guildId, discordUserId) as Array<{ mock: number; count: number }>;
  return {
    real: rows.find((row) => row.mock === 0)?.count ?? 0,
    mock: rows.find((row) => row.mock === 1)?.count ?? 0,
  };
}

/**
 * Deletes every record, real and mock, of one member in one server and returns how many were removed.
 * The member's closed /why appeal cases and stored LP results go in the same transaction, so erased history leaves nothing behind.
 * This is the only way history is erased: removing a tracked member never touches it.
 * The connection overwrites deleted content (`secure_delete`), and the WAL is checkpointed and truncated afterwards (without waiting for other processes) so the old page images do not linger in it.
 * Backups made before schema upgrades and log files are separate copies that this never touches.
 * The erase time is also remembered in memory (see eraseCutoff), because the member stays bound and a report that was
 * already under way would otherwise write its rows back when its late writes arrive.
 */
export function eraseMemberHorseRecords(guildId: string, discordUserId: string): number {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  const database = getDatabase();
  const erased = database.transaction(() => {
    eraseMemberAppeals(guildId, discordUserId);
    eraseMemberRankResults(guildId, discordUserId);
    return database.prepare("DELETE FROM horse_records WHERE guild_id = ? AND discord_user_id = ?").run(guildId, discordUserId).changes;
  })();
  markMemberErased(guildId, discordUserId);
  // The erase is already committed, so a checkpoint that cannot finish is reported but never fails the command.
  // The checkpoint never waits for another process, so a busy database cannot stall the reply.
  try {
    if (!truncateWal(database)) logWarn("The erase is saved, but another process is reading the database, so the WAL was not truncated; the copy of the erased rows in it is cleared when the bot shuts down.");
  } catch (error) {
    logWarn(`The erase is saved, but the WAL checkpoint failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return erased;
}
