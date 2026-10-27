import type { RankResult, RankResultQueue } from "../store/rankStore";
import type { RankedEntry, RankedQueueType } from "../types";
import { isApex } from "./rankMath";
import type { RankRow } from "./rankTracker";

const QUEUES: Readonly<Record<RankedQueueType, RankResultQueue>> = { RANKED_SOLO_5x5: "solo", RANKED_FLEX_SR: "flex" };

/** Riot sends division "I" for the apex tiers, which have none: it is not stored. */
const divisionOf = (entry: Pick<RankedEntry, "tier" | "rank">): string | null => isApex(entry.tier) ? null : entry.rank;

export interface RankResultContext {
  guildId: string;
  discordUserId: string;
  matchId: string;
  mock: boolean;
  puuid: string;
  /** The game's end in Unix milliseconds, or null when Riot gave none: the record time is used then. */
  gameEndTimestamp: number | null;
  recordedAt: number;
}

/**
 * The result to store for one 段位变化 row, or null while the row is not final: pending, stale and unavailable rows
 * are stored by nobody, so a later read can still settle them. A demotion keeps its ranks but not its LP delta,
 * the same as the row shows.
 */
export function buildRankResult(row: RankRow, context: RankResultContext): RankResult | null {
  const { state } = row;
  const base = {
    guildId: context.guildId,
    discordUserId: context.discordUserId,
    matchId: context.matchId,
    mock: context.mock,
    puuid: context.puuid,
    queueType: QUEUES[row.queueType],
    playedAt: context.gameEndTimestamp ?? context.recordedAt,
    recordedAt: context.recordedAt,
  };
  switch (state.kind) {
    case "change":
    case "promoted":
    case "demoted":
      return {
        ...base,
        kind: state.kind,
        tier: state.after.tier,
        division: divisionOf(state.after),
        leaguePoints: state.after.leaguePoints,
        lpDelta: state.kind === "demoted" ? null : state.delta,
        beforeTier: state.before.tier,
        beforeDivision: divisionOf(state.before),
        beforeLeaguePoints: state.before.leaguePoints,
      };
    case "placed":
    case "unattributable":
      return {
        ...base,
        kind: state.kind,
        tier: state.after.tier,
        division: divisionOf(state.after),
        leaguePoints: state.after.leaguePoints,
        lpDelta: null,
        beforeTier: null,
        beforeDivision: null,
        beforeLeaguePoints: null,
      };
    default:
      return null;
  }
}
