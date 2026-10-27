import { getDatabase } from "./database";

export const RANK_RESULT_KINDS = ["change", "promoted", "demoted", "placed", "unattributable"] as const;
export type RankResultKind = (typeof RANK_RESULT_KINDS)[number];
export type RankResultQueue = "solo" | "flex";

/**
 * One tracked member's LP result in one ranked match, stored once when their 段位变化 row is final.
 * Tiers and divisions are Riot's own strings (`GOLD`, `II`), not the Chinese wording. The division is null for
 * MASTER and above. A pending, stale or unavailable row has no result and is never stored.
 */
export interface RankResult {
  guildId: string;
  discordUserId: string;
  matchId: string;
  mock: boolean;
  /** The member's Riot account that played the match. */
  puuid: string;
  queueType: RankResultQueue;
  /** Unix milliseconds: the game's end, or the time it was recorded when Riot gave none. */
  playedAt: number;
  recordedAt: number;
  kind: RankResultKind;
  tier: string;
  division: string | null;
  leaguePoints: number;
  /**
   * The ladder distance of the game. Null for a placement, an unattributable change and a demotion, whose distance is
   * not the LP Riot actually took until a real demotion has been measured.
   */
  lpDelta: number | null;
  /** The rank before the game, whenever it is known: null for a placement and an unattributable change. */
  beforeTier: string | null;
  beforeDivision: string | null;
  beforeLeaguePoints: number | null;
}

interface RankResultRow {
  guild_id: string;
  discord_user_id: string;
  match_id: string;
  mock: number;
  puuid: string;
  queue_type: RankResultQueue;
  played_at: number;
  recorded_at: number;
  kind: RankResultKind;
  tier: string;
  division: string | null;
  league_points: number;
  lp_delta: number | null;
  before_tier: string | null;
  before_division: string | null;
  before_league_points: number | null;
}

export interface RankResultQuery {
  /** Required, so mock and real results are never returned together. */
  mock: boolean;
  discordUserId?: string;
  /** By `played_at`; the default is oldest first. */
  order?: "asc" | "desc";
  limit?: number;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
}

function requireCount(value: unknown, name: string, minimum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer of at least ${minimum}.`);
}

function validate(result: RankResult): void {
  requireString(result.guildId, "Guild ID");
  requireString(result.discordUserId, "Discord user ID");
  requireString(result.matchId, "Match ID");
  requireString(result.puuid, "PUUID");
  requireString(result.tier, "Tier");
  if (typeof result.mock !== "boolean") throw new TypeError("A rank result must say whether it is mock or real.");
  if (!RANK_RESULT_KINDS.includes(result.kind)) throw new TypeError(`Unknown rank result kind: ${String(result.kind)}.`);
  if (result.queueType !== "solo" && result.queueType !== "flex") throw new TypeError(`Unknown rank result queue: ${String(result.queueType)}.`);
  requireCount(result.playedAt, "playedAt", 0);
  requireCount(result.recordedAt, "recordedAt", 0);
  requireCount(result.leaguePoints, "League points", 0);
  if (result.lpDelta !== null && (typeof result.lpDelta !== "number" || !Number.isInteger(result.lpDelta))) throw new TypeError("lpDelta must be an integer or null.");
  if (result.beforeLeaguePoints !== null) requireCount(result.beforeLeaguePoints, "Before league points", 0);
}

function fromRow(row: RankResultRow): RankResult {
  return {
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    matchId: row.match_id,
    mock: row.mock === 1,
    puuid: row.puuid,
    queueType: row.queue_type,
    playedAt: row.played_at,
    recordedAt: row.recorded_at,
    kind: row.kind,
    tier: row.tier,
    division: row.division,
    leaguePoints: row.league_points,
    lpDelta: row.lp_delta,
    beforeTier: row.before_tier,
    beforeDivision: row.before_division,
    beforeLeaguePoints: row.before_league_points,
  };
}

/**
 * Saves the results in one transaction and returns how many were new.
 * An existing (server, member, match, mock) key is left unchanged, so a result that settles again, for example
 * when the late update edits the report, never makes a second row or changes the first.
 * Only a repeated key is skipped: a row that breaks the table's rules throws, instead of vanishing as INSERT OR IGNORE would.
 */
export function recordRankResults(results: readonly RankResult[]): number {
  results.forEach(validate);
  if (results.length === 0) return 0;
  const database = getDatabase();
  const insert = database.prepare(`
    INSERT INTO rank_results (
      guild_id, discord_user_id, match_id, mock, puuid, queue_type, played_at, recorded_at, kind,
      tier, division, league_points, lp_delta, before_tier, before_division, before_league_points
    ) VALUES (
      @guildId, @discordUserId, @matchId, @mock, @puuid, @queueType, @playedAt, @recordedAt, @kind,
      @tier, @division, @leaguePoints, @lpDelta, @beforeTier, @beforeDivision, @beforeLeaguePoints
    ) ON CONFLICT(guild_id, discord_user_id, match_id, mock) DO NOTHING
  `);
  return database.transaction(() => {
    let inserted = 0;
    for (const result of results) inserted += insert.run({ ...result, mock: result.mock ? 1 : 0 }).changes;
    return inserted;
  })();
}

/** Results of one server, optionally for one member. The `mock` flag is required so mock and real are never mixed. */
export function listRankResults(guildId: string, query: RankResultQuery): RankResult[] {
  requireString(guildId, "Guild ID");
  if (typeof query?.mock !== "boolean") throw new TypeError("A rank result query must say whether it wants mock or real results.");
  const conditions = ["guild_id = @guildId", "mock = @mock"];
  const parameters: Record<string, string | number> = { guildId, mock: query.mock ? 1 : 0 };
  if (query.discordUserId !== undefined) {
    requireString(query.discordUserId, "Discord user ID");
    conditions.push("discord_user_id = @discordUserId");
    parameters.discordUserId = query.discordUserId;
  }
  const direction = query.order === "desc" ? "DESC" : "ASC";
  let sql = `SELECT * FROM rank_results WHERE ${conditions.join(" AND ")} ORDER BY played_at ${direction}, match_id ${direction}, discord_user_id ${direction}`;
  if (query.limit !== undefined) {
    requireCount(query.limit, "limit", 1);
    sql += " LIMIT @limit";
    parameters.limit = query.limit;
  }
  return (getDatabase().prepare(sql).all(parameters) as RankResultRow[]).map(fromRow);
}

/** Deletes every result, real and mock, of one member in one server and returns how many were removed. */
export function eraseMemberRankResults(guildId: string, discordUserId: string): number {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  return getDatabase().prepare("DELETE FROM rank_results WHERE guild_id = ? AND discord_user_id = ?").run(guildId, discordUserId).changes;
}
