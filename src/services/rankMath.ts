import type { RankedEntry, RankedQueueType } from "../types";

/** Ladder tiers with divisions, lowest first. */
const DIVISIONED_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"] as const;
/** Tiers above DIVISIONED_TIERS: no divisions, one shared LP ladder, and moved between by cutoffs rather than by a game. */
const APEX_TIERS = ["MASTER", "GRANDMASTER", "CHALLENGER"] as const;
/** Divisions, lowest first: IV is the bottom of a tier and I the top. */
const DIVISIONS = ["IV", "III", "II", "I"] as const;

const LP_PER_DIVISION = 100;
const LP_PER_TIER = LP_PER_DIVISION * DIVISIONS.length;
/** The ladder value where the apex tiers start: the value of MASTER with 0 LP. */
const APEX_BASE = DIVISIONED_TIERS.length * LP_PER_TIER;

/** League-v4 queue types by match-v5 queue ID. Every other queue has no LP. */
const LEAGUE_QUEUES: Readonly<Record<number, RankedQueueType>> = { 420: "RANKED_SOLO_5x5", 440: "RANKED_FLEX_SR" };

/** The league-v4 queue whose entry a game in this queue moves, or null for a queue without LP. */
export function rankedQueueFor(queueId: number): RankedQueueType | null {
  return LEAGUE_QUEUES[queueId] ?? null;
}

function isApex(tier: string): boolean {
  return (APEX_TIERS as readonly string[]).includes(tier);
}

/**
 * Where an entry sits on one number line, so a difference of two values is the LP change across divisions and tiers.
 * Divisioned tiers are `tier * 400 + division * 100 + LP` with IRON 0 and IV 0. MASTER, GRANDMASTER and CHALLENGER
 * share `2800 + LP`, because they have no divisions and Riot moves players between them by cutoffs.
 * Returns null for a tier or division this code does not know, so a new Riot value never becomes a wrong number.
 */
export function ladderValue(entry: Pick<RankedEntry, "tier" | "rank" | "leaguePoints">): number | null {
  if (!Number.isFinite(entry.leaguePoints) || entry.leaguePoints < 0) return null;
  if (isApex(entry.tier)) return APEX_BASE + entry.leaguePoints;
  const tier = (DIVISIONED_TIERS as readonly string[]).indexOf(entry.tier);
  const division = (DIVISIONS as readonly string[]).indexOf(entry.rank);
  if (tier < 0 || division < 0) return null;
  return tier * LP_PER_TIER + division * LP_PER_DIVISION + entry.leaguePoints;
}

/** After minus before, across divisions, tiers and the DIAMOND to MASTER boundary. Null when either rank is unknown. */
export function lpDelta(before: RankedEntry, after: RankedEntry): number | null {
  const from = ladderValue(before);
  const to = ladderValue(after);
  return from === null || to === null ? null : to - from;
}

/**
 * Turns a ladder value back into an entry of the given queue, for the mock provider. Below the apex line it is a
 * divisioned tier. At or above it is an apex tier: `apexTier` when that is one, otherwise MASTER.
 * A value below 0 stops at IRON IV with 0 LP.
 */
export function entryFromLadderValue(
  value: number, queueType: string, record: { wins: number; losses: number }, apexTier = "MASTER",
): RankedEntry {
  if (value >= APEX_BASE) {
    return { queueType, tier: isApex(apexTier) ? apexTier : "MASTER", rank: "I", leaguePoints: value - APEX_BASE, ...record };
  }
  const clamped = Math.max(0, value);
  return {
    queueType,
    tier: DIVISIONED_TIERS[Math.floor(clamped / LP_PER_TIER)],
    rank: DIVISIONS[Math.floor((clamped % LP_PER_TIER) / LP_PER_DIVISION)],
    leaguePoints: clamped % LP_PER_DIVISION,
    ...record,
  };
}

/** Moves an entry along the ladder by `delta` LP, keeping its apex tier while it stays at or above the apex line. */
export function shiftEntry(entry: RankedEntry, delta: number, record: { wins: number; losses: number }): RankedEntry {
  const value = ladderValue(entry);
  if (value === null) return { ...entry, ...record };
  return entryFromLadderValue(value + delta, entry.queueType, record, entry.tier);
}

/**
 * A rung of the ladder that counts as a rank: each division is one, and the apex tiers share a single rung because
 * they are separated by cutoffs, not by games. DIAMOND I is just below it.
 */
function rankStep(entry: Pick<RankedEntry, "tier" | "rank">): number | null {
  if (isApex(entry.tier)) return DIVISIONED_TIERS.length * DIVISIONS.length;
  const tier = (DIVISIONED_TIERS as readonly string[]).indexOf(entry.tier);
  const division = (DIVISIONS as readonly string[]).indexOf(entry.rank);
  return tier < 0 || division < 0 ? null : tier * DIVISIONS.length + division;
}

/**
 * Whether going from one rung to another is a promotion or demotion worth announcing.
 * Ryan has not yet decided between "every division or tier change" (this) and "only a tier change". To switch, compare
 * `Math.floor(step / DIVISIONS.length)` instead of the step itself; this is the only place that decides it.
 * An apex to apex move has the same step, so it is never a promotion or demotion.
 */
function countsAsRankMove(beforeStep: number, afterStep: number): boolean {
  return afterStep !== beforeStep;
}

/** The entry of one queue, or null when the account has none (unranked, or still in placements). */
export function entryForQueue(entries: readonly RankedEntry[], queueType: string): RankedEntry | null {
  return entries.find((entry) => entry.queueType === queueType) ?? null;
}

/** What a game did to an account's entry in one queue. `none` means no row is shown. */
export type RankChange =
  | { kind: "none"; reason: "no_entry" | "entry_lost" | "unknown_rank" | "queue_mismatch" }
  /** No entry before the game, one after: placements just finished. There is no delta. */
  | { kind: "placed"; after: RankedEntry }
  /** League-v4 has not caught up with the game yet (wins plus losses did not move): read again later. */
  | { kind: "pending" }
  /** Several games passed between the two reads, or the record went backwards, so the change belongs to no single game. */
  | { kind: "unattributable"; after: RankedEntry }
  | { kind: "change" | "promoted" | "demoted"; delta: number; before: RankedEntry; after: RankedEntry };

/**
 * Compares the entries of one queue read before and after a game. Wins plus losses is the attribution key:
 * - 0 more games: league-v4 is lagging, so `pending`.
 * - exactly 1 more game: the change belongs to this game.
 * - 2 or more (or fewer): `unattributable`.
 * An unknown tier or division gives `none`, never an error.
 */
export function classifyRankChange(before: RankedEntry | null, after: RankedEntry | null): RankChange {
  if (!before && !after) return { kind: "none", reason: "no_entry" };
  if (!after) return { kind: "none", reason: "entry_lost" };
  if (before && before.queueType !== after.queueType) return { kind: "none", reason: "queue_mismatch" };
  if (rankStep(after) === null || ladderValue(after) === null) return { kind: "none", reason: "unknown_rank" };
  if (!before) return { kind: "placed", after };

  const games = after.wins + after.losses - (before.wins + before.losses);
  if (games === 0) return { kind: "pending" };
  if (games !== 1) return { kind: "unattributable", after };

  const beforeStep = rankStep(before);
  const afterStep = rankStep(after);
  const delta = lpDelta(before, after);
  if (beforeStep === null || afterStep === null || delta === null) return { kind: "none", reason: "unknown_rank" };
  if (!countsAsRankMove(beforeStep, afterStep)) return { kind: "change", delta, before, after };
  return { kind: afterStep > beforeStep ? "promoted" : "demoted", delta, before, after };
}
