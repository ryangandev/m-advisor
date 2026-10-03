import benchmarkData from "../data/roleBenchmarks.json";
import { POSITIONS } from "../types";
import type { MatchDetail, MatchParticipant, PerformanceStat, Position } from "../types";

export const HORSE_TIERS = ["特等马", "上等马", "中等马", "下等马", "没有马"] as const;
export type HorseTier = (typeof HORSE_TIERS)[number];

export const DIMENSIONS = ["damage", "teamfight", "survival", "economy", "frontline", "vision", "objectives", "utility", "matchup"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type BenchmarkRole = Position | "ALL";

interface FeatureSpec { dimension: Dimension; weight: number; lowerIsBetter?: boolean }

/** Each feature is normalized by game length or team totals so long games and fast games compare fairly. */
export const FEATURES = {
  damageShare: { dimension: "damage", weight: 0.6 },
  damagePerMinute: { dimension: "damage", weight: 0.4 },
  killParticipation: { dimension: "teamfight", weight: 0.75 },
  takedownsPerMinute: { dimension: "teamfight", weight: 0.25 },
  deathsPerMinute: { dimension: "survival", weight: 0.6, lowerIsBetter: true },
  killLifeAssist: { dimension: "survival", weight: 0.4 },
  goldPerMinute: { dimension: "economy", weight: 0.4 },
  csPerMinute: { dimension: "economy", weight: 0.35 },
  xpPerMinute: { dimension: "economy", weight: 0.25 },
  damageTakenShare: { dimension: "frontline", weight: 0.6 },
  mitigatedPerMinute: { dimension: "frontline", weight: 0.4 },
  visionPerMinute: { dimension: "vision", weight: 0.6 },
  controlWardsPerMinute: { dimension: "vision", weight: 0.2 },
  wardKillsPerMinute: { dimension: "vision", weight: 0.2 },
  epicObjectiveShare: { dimension: "objectives", weight: 0.35 },
  buildingDamagePerMinute: { dimension: "objectives", weight: 0.45 },
  turretShare: { dimension: "objectives", weight: 0.2 },
  healShieldPerMinute: { dimension: "utility", weight: 0.4 },
  ccPerMinute: { dimension: "utility", weight: 0.3 },
  immobilizationsPerMinute: { dimension: "utility", weight: 0.3 },
  goldDiffPerMinute: { dimension: "matchup", weight: 0.4 },
  xpDiffPerMinute: { dimension: "matchup", weight: 0.3 },
  maxCsAdvantage: { dimension: "matchup", weight: 0.3 },
} as const satisfies Record<string, FeatureSpec>;
export type FeatureId = keyof typeof FEATURES;
export type FeatureValues = Partial<Record<FeatureId, number>>;

/**
 * How much each dimension matters for a position. Every feature is first compared with players of the
 * same position, so a support is judged on vision and protection instead of kills or farm.
 */
export const ROLE_WEIGHTS: Record<BenchmarkRole, Record<Dimension, number>> = {
  TOP: { damage: 0.18, teamfight: 0.1, survival: 0.12, economy: 0.12, frontline: 0.14, vision: 0.05, objectives: 0.12, utility: 0.05, matchup: 0.12 },
  JUNGLE: { damage: 0.14, teamfight: 0.18, survival: 0.1, economy: 0.1, frontline: 0.07, vision: 0.11, objectives: 0.2, utility: 0.05, matchup: 0.05 },
  MIDDLE: { damage: 0.24, teamfight: 0.14, survival: 0.12, economy: 0.13, frontline: 0.03, vision: 0.05, objectives: 0.09, utility: 0.06, matchup: 0.14 },
  BOTTOM: { damage: 0.26, teamfight: 0.12, survival: 0.13, economy: 0.16, frontline: 0, vision: 0.04, objectives: 0.11, utility: 0.03, matchup: 0.15 },
  UTILITY: { damage: 0.08, teamfight: 0.2, survival: 0.08, economy: 0.03, frontline: 0.07, vision: 0.22, objectives: 0.06, utility: 0.22, matchup: 0.04 },
  ALL: { damage: 0.15, teamfight: 0.15, survival: 0.12, economy: 0.12, frontline: 0.07, vision: 0.1, objectives: 0.11, utility: 0.08, matchup: 0.1 },
};

export interface RoleBenchmark {
  samples: number;
  features: Partial<Record<FeatureId, number[]>>;
  composite: number[];
}
export interface Benchmarks {
  version: number;
  sample: { matches: number; tiers: string[]; patches: string[]; collectedAt: string };
  roles: Record<BenchmarkRole, RoleBenchmark>;
}
export const DEFAULT_BENCHMARKS = benchmarkData as Benchmarks;

export interface RankedHorse {
  participant: MatchParticipant;
  tier: HorseTier;
  rank: number;
  /** 0-10: the share of same-position reference players this performance beats. */
  score: number;
  composite: number;
  dimensions: Partial<Record<Dimension, number>>;
  features: FeatureValues;
  /** Dimensions that matter for this player's position, strongest first. */
  strengths: Dimension[];
}

export interface HorseRanking {
  matchId: string;
  trackedPuuid: string;
  won: boolean;
  remake: boolean;
  aborted: boolean;
  durationMinutes: number;
  horses: RankedHorse[];
}

/** Empirical percentile of `value` in ascending, evenly spaced quantiles; ties land in the middle of their range. */
export function percentile(value: number, quantiles: readonly number[] | undefined): number | undefined {
  if (!quantiles || quantiles.length < 2 || !Number.isFinite(value)) return undefined;
  const last = quantiles.length - 1;
  if (value < quantiles[0]) return 0;
  if (value > quantiles[last]) return 1;
  let low = 0;
  while (low <= last && quantiles[low] < value) low++;
  let high = low;
  while (high <= last && quantiles[high] === value) high++;
  if (high > low) return (low + high - 1) / 2 / last;
  const below = quantiles[low - 1];
  const above = quantiles[low];
  return (low - 1 + (value - below) / (above - below)) / last;
}

/** Evenly spaced quantiles of a sample, rounded to keep the committed benchmark file small. */
export function quantiles(values: number[], points: number): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  return Array.from({ length: points }, (_, index) => {
    const position = (index / (points - 1)) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, sorted.length - 1);
    const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    return Number(value.toPrecision(5));
  });
}

export function extractFeatures(detail: MatchDetail, participant: MatchParticipant): FeatureValues {
  const minutes = detail.info.gameDuration / 60;
  if (!(minutes > 0)) return {};
  const team = detail.info.participants.filter((player) => player.teamId === participant.teamId);
  const stats = participant.stats;
  const teamTotal = (key: PerformanceStat) => team.reduce((total, player) => total + (player.stats[key] ?? 0), 0);
  const perMinute = (value: number | undefined) => value === undefined ? undefined : value / minutes;
  const share = (value: number | undefined, total: number) => value === undefined || total <= 0 ? undefined : Math.min(1, value / total);
  const anyDefined = (...values: (number | undefined)[]) =>
    values.some((value) => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined;
  const takedowns = participant.kills + participant.assists;
  const teamKills = team.reduce((total, player) => total + player.kills, 0);
  const objectives = detail.info.teams.find((teamObjectives) => teamObjectives.teamId === participant.teamId);
  const epicTotal = objectives ? objectives.dragon + objectives.baron + objectives.riftHerald : 0;
  const opponent = participant.position
    ? detail.info.participants.find((player) => player.teamId !== participant.teamId && player.position === participant.position)
    : undefined;
  const difference = (key: PerformanceStat) => {
    const own = stats[key];
    const theirs = opponent?.stats[key];
    return own === undefined || theirs === undefined ? undefined : (own - theirs) / minutes;
  };

  const values: Record<FeatureId, number | undefined> = {
    damageShare: share(stats.totalDamageDealtToChampions, teamTotal("totalDamageDealtToChampions")),
    damagePerMinute: perMinute(stats.totalDamageDealtToChampions),
    killParticipation: teamKills > 0 ? Math.min(1, takedowns / teamKills) : undefined,
    takedownsPerMinute: takedowns / minutes,
    deathsPerMinute: participant.deaths / minutes,
    killLifeAssist: takedowns / (participant.deaths + 1),
    goldPerMinute: perMinute(stats.goldEarned),
    csPerMinute: perMinute(anyDefined(stats.totalMinionsKilled, stats.neutralMinionsKilled)),
    xpPerMinute: perMinute(stats.champExperience),
    damageTakenShare: share(stats.totalDamageTaken, teamTotal("totalDamageTaken")),
    mitigatedPerMinute: perMinute(stats.damageSelfMitigated),
    visionPerMinute: perMinute(stats.visionScore),
    controlWardsPerMinute: perMinute(stats.controlWardsPlaced ?? stats.detectorWardsPlaced),
    wardKillsPerMinute: perMinute(stats.wardTakedowns ?? stats.wardsKilled),
    epicObjectiveShare: share(anyDefined(stats.dragonTakedowns, stats.baronTakedowns, stats.riftHeraldTakedowns), epicTotal),
    buildingDamagePerMinute: perMinute(stats.damageDealtToBuildings),
    turretShare: share(stats.turretTakedowns, objectives?.tower ?? 0),
    healShieldPerMinute: perMinute(stats.effectiveHealAndShielding
      ?? anyDefined(stats.totalHealsOnTeammates, stats.totalDamageShieldedOnTeammates)),
    ccPerMinute: perMinute(stats.timeCCingOthers),
    immobilizationsPerMinute: perMinute(stats.enemyChampionImmobilizations),
    goldDiffPerMinute: difference("goldEarned"),
    xpDiffPerMinute: difference("champExperience"),
    maxCsAdvantage: stats.maxCsAdvantageOnLaneOpponent,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && Number.isFinite(value))) as FeatureValues;
}

function roleOf(participant: MatchParticipant): BenchmarkRole {
  return participant.position ?? "ALL";
}

function benchmarkFor(role: BenchmarkRole, benchmarks: Benchmarks): RoleBenchmark | undefined {
  const own = benchmarks.roles[role];
  return own && own.samples > 0 ? own : benchmarks.roles.ALL;
}

export function dimensionScores(features: FeatureValues, role: BenchmarkRole, benchmarks: Benchmarks): Partial<Record<Dimension, number>> {
  const benchmark = benchmarkFor(role, benchmarks);
  const totals = new Map<Dimension, { sum: number; weight: number }>();
  for (const [id, spec] of Object.entries(FEATURES) as [FeatureId, FeatureSpec][]) {
    const value = features[id];
    const rank = value === undefined ? undefined : percentile(value, benchmark?.features[id]);
    if (rank === undefined) continue;
    const entry = totals.get(spec.dimension) ?? { sum: 0, weight: 0 };
    entry.sum += spec.weight * (spec.lowerIsBetter ? 1 - rank : rank);
    entry.weight += spec.weight;
    totals.set(spec.dimension, entry);
  }
  return Object.fromEntries([...totals].map(([dimension, { sum, weight }]) => [dimension, sum / weight]));
}

export function compositeScore(dimensions: Partial<Record<Dimension, number>>, role: BenchmarkRole): number {
  const weights = ROLE_WEIGHTS[role];
  let sum = 0;
  let weight = 0;
  for (const dimension of DIMENSIONS) {
    const value = dimensions[dimension];
    if (value === undefined || weights[dimension] <= 0) continue;
    sum += weights[dimension] * value;
    weight += weights[dimension];
  }
  return weight > 0 ? sum / weight : 0.5;
}

export function scoreParticipant(detail: MatchDetail, participant: MatchParticipant, benchmarks: Benchmarks = DEFAULT_BENCHMARKS) {
  const role = roleOf(participant);
  const features = extractFeatures(detail, participant);
  const dimensions = dimensionScores(features, role, benchmarks);
  const composite = compositeScore(dimensions, role);
  // Calibrating the composite per position keeps every position equally likely to be 特等马.
  const calibrated = percentile(composite, benchmarkFor(role, benchmarks)?.composite) ?? composite;
  const relevant = DIMENSIONS.filter((dimension) => ROLE_WEIGHTS[role][dimension] >= 0.08 && dimensions[dimension] !== undefined);
  const strengths = relevant.sort((a, b) => dimensions[b]! - dimensions[a]!);
  return { features, dimensions, composite, score: calibrated * 10, strengths };
}

/** Ranks the tracked player's team from 特等马 to 没有马; enemies are never scored. */
export function rankTeam(detail: MatchDetail, trackedPuuid: string, benchmarks: Benchmarks = DEFAULT_BENCHMARKS): HorseRanking {
  const tracked = detail.info.participants.find((player) => player.puuid === trackedPuuid);
  if (!tracked) throw new Error("The tracked Riot account is missing from the match participants.");
  const team = detail.info.participants.filter((player) => player.teamId === tracked.teamId);
  const scored = team
    .map((participant) => ({ participant, ...scoreParticipant(detail, participant, benchmarks) }))
    .sort((a, b) => b.score - a.score || b.composite - a.composite || a.participant.puuid.localeCompare(b.participant.puuid));
  const last = scored.length - 1;
  const horses = scored.map((horse, index) => ({
    ...horse,
    rank: index + 1,
    // Teams of five map one-to-one; any other size spreads across the same five tiers.
    tier: HORSE_TIERS[last <= 0 ? 0 : Math.round((index * (HORSE_TIERS.length - 1)) / last)],
  }));
  return {
    matchId: detail.metadata.matchId,
    trackedPuuid,
    won: tracked.win,
    remake: detail.info.earlySurrender,
    aborted: detail.info.aborted,
    durationMinutes: detail.info.gameDuration / 60,
    horses,
  };
}

/** Builds per-position reference distributions from real matches. */
export function buildBenchmarks(matches: MatchDetail[], sample: Benchmarks["sample"], points = 41): Benchmarks {
  const roles = [...POSITIONS, "ALL"] as BenchmarkRole[];
  const featureSamples = new Map<BenchmarkRole, Map<FeatureId, number[]>>(roles.map((role) => [role, new Map()]));
  const players: Array<{ role: BenchmarkRole; features: FeatureValues }> = [];
  for (const detail of matches) {
    for (const participant of detail.info.participants) {
      const role = roleOf(participant);
      const features = extractFeatures(detail, participant);
      players.push({ role, features });
      for (const target of new Set<BenchmarkRole>([role, "ALL"])) {
        for (const [id, value] of Object.entries(features) as [FeatureId, number][]) {
          const values = featureSamples.get(target)!.get(id) ?? [];
          values.push(value);
          featureSamples.get(target)!.set(id, values);
        }
      }
    }
  }
  const result: Benchmarks = { version: 1, sample, roles: {} as Record<BenchmarkRole, RoleBenchmark> };
  for (const role of roles) {
    const features = Object.fromEntries([...featureSamples.get(role)!].map(([id, values]) => [id, quantiles(values, points)]));
    result.roles[role] = {
      samples: players.filter((player) => role === "ALL" || player.role === role).length,
      features,
      composite: [],
    };
  }
  // Composite calibration needs the finished feature distributions, so it is a second pass.
  for (const role of roles) {
    const composites = players
      .filter((player) => role === "ALL" || player.role === role)
      .map((player) => compositeScore(dimensionScores(player.features, role === "ALL" ? "ALL" : player.role, result), role === "ALL" ? "ALL" : player.role));
    result.roles[role].composite = quantiles(composites, points);
  }
  return result;
}
