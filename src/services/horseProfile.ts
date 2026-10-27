import { listHorseRecords } from "../store/horseRecordStore";
import type { HorseRecord } from "../store/horseRecordStore";
import { DIMENSIONS, HORSE_TIERS, ROLE_WEIGHTS } from "./horseRanking";
import type { Dimension, HorseTier } from "./horseRanking";

export const DIMENSION_LABELS: Record<Dimension, string> = {
  damage: "输出",
  teamfight: "参团",
  survival: "生存",
  economy: "经济",
  frontline: "前排",
  vision: "视野",
  objectives: "资源",
  utility: "功能",
  matchup: "对线",
};

/** A dimension counts toward a player's strengths only when their position's weight for it is at least this. */
const RELEVANT_WEIGHT = 0.08;
/** A dimension needs this many games before it can be called the strongest or the weakest. */
export const MIN_DIMENSION_GAMES = 3;
/** How many of the latest results make up the recent form. */
export const RECENT_FORM_GAMES = 10;
/** How many of the latest games are listed one by one. */
export const RECENT_GAME_LIST = 5;

export interface TierStat {
  count: number;
  /** 0-1 share of the member's recorded games. */
  rate: number;
}

export interface StreakStat {
  /** How many of the latest games in a row had this tier. */
  current: number;
  /** The longest run ever. */
  best: number;
}

export interface DimensionStat {
  dimension: Dimension;
  /** Average percentile (0-1) against the same position, over the games where the dimension mattered for the position. */
  average: number;
  games: number;
}

export interface HorseProfile {
  games: number;
  wins: number;
  tiers: Record<HorseTier, TierStat>;
  averageScore: number | null;
  streaks: { top: StreakStat; none: StreakStat };
  /** The latest results, newest first. */
  recentForm: HorseTier[];
  /** Every dimension with enough games, strongest first. */
  dimensions: DimensionStat[];
  strongest: DimensionStat | null;
  weakest: DimensionStat | null;
  /** The latest games, newest first. */
  recent: HorseRecord[];
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
}

function streakOf(tiers: readonly HorseTier[], tier: HorseTier): StreakStat {
  let best = 0;
  let run = 0;
  for (const value of tiers) {
    run = value === tier ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let index = tiers.length - 1; index >= 0 && tiers[index] === tier; index -= 1) current += 1;
  return { current, best };
}

/**
 * Statistics over records the caller has already chosen, for example one member's real records or one week.
 * Mock and real records must never be passed together; the store queries enforce that.
 */
export function summarizeHorseRecords(records: readonly HorseRecord[]): HorseProfile {
  if (new Set(records.map((record) => record.mock)).size > 1) {
    throw new Error("Mock and real horse records must not be summarized together.");
  }
  const chronological = [...records].sort((a, b) => a.playedAt - b.playedAt || a.matchId.localeCompare(b.matchId));
  const games = chronological.length;
  const tiers = Object.fromEntries(HORSE_TIERS.map((tier) => {
    const count = chronological.filter((record) => record.tier === tier).length;
    return [tier, { count, rate: games > 0 ? count / games : 0 }];
  })) as Record<HorseTier, TierStat>;

  const sums = new Map<Dimension, { sum: number; games: number }>();
  for (const record of chronological) {
    const weights = ROLE_WEIGHTS[record.position ?? "ALL"];
    for (const dimension of DIMENSIONS) {
      const percentile = record.dimensions[dimension];
      if (percentile === undefined || weights[dimension] < RELEVANT_WEIGHT) continue;
      const entry = sums.get(dimension) ?? { sum: 0, games: 0 };
      entry.sum += percentile;
      entry.games += 1;
      sums.set(dimension, entry);
    }
  }
  const dimensions = DIMENSIONS
    .flatMap((dimension): DimensionStat[] => {
      const entry = sums.get(dimension);
      return entry && entry.games >= MIN_DIMENSION_GAMES ? [{ dimension, average: entry.sum / entry.games, games: entry.games }] : [];
    })
    .sort((a, b) => b.average - a.average);

  const results = chronological.map((record) => record.tier);
  return {
    games,
    wins: chronological.filter((record) => record.won).length,
    tiers,
    averageScore: games > 0 ? chronological.reduce((total, record) => total + record.score, 0) / games : null,
    streaks: { top: streakOf(results, "特等马"), none: streakOf(results, "没有马") },
    recentForm: results.slice(-RECENT_FORM_GAMES).reverse(),
    dimensions,
    strongest: dimensions.length >= 2 ? dimensions[0] : null,
    weakest: dimensions.length >= 2 ? dimensions[dimensions.length - 1] : null,
    recent: chronological.slice(-RECENT_GAME_LIST).reverse(),
    firstPlayedAt: games > 0 ? chronological[0].playedAt : null,
    lastPlayedAt: games > 0 ? chronological[games - 1].playedAt : null,
  };
}

/** One member's long-term profile. Mock and real history are separate: pass the mode the bot is running in. */
export function getMemberHorseProfile(guildId: string, discordUserId: string, mock: boolean): HorseProfile {
  return summarizeHorseRecords(listHorseRecords(guildId, { mock, discordUserId }));
}
