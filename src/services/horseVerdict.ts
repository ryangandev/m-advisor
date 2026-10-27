import { listHorseRecords, listMatchHorseRecords } from "../store/horseRecordStore";
import type { HorseRecord } from "../store/horseRecordStore";
import type { Position } from "../types";
import { formatScore } from "./announcementText";
import { DIMENSION_LABELS } from "./horseProfile";
import { DIMENSIONS, ROLE_WEIGHTS, tierForRank } from "./horseRanking";
import type { Dimension, FeatureValues, HorseTier } from "./horseRanking";

export const POSITION_LABELS: Record<Position, string> = { TOP: "上单", JUNGLE: "打野", MIDDLE: "中单", BOTTOM: "下路", UTILITY: "辅助" };

/** Every dimension is drawn against the median same-position player; a shortfall is measured from there. */
export const MEDIAN = 0.5;
/** A position weight at or above this marks a dimension the position is judged on most (2 or 3 per position). */
export const KEY_WEIGHT = 0.14;
/**
 * A gap to the neighbouring rank that prints as at most this many points is 惜败 (just missed the rank above) or
 * 险胜 (just held off the rank below). 0.3 points is 3 percentile points of same-position players, well under the
 * typical gap between neighbouring teammates. It is compared with the printed value, so "差 0.3 分" always gets the label.
 */
export const CLOSE_GAP = 0.3;
/** How many of the costliest dimensions the verdict names. */
export const MAX_DRAGS = 3;

export interface VerdictDimension {
  dimension: Dimension;
  /** Percentile (0-1) against the same position, or undefined when the match had no data for it. */
  percentile: number | undefined;
  /** The position's weight for the dimension (the weights of a position sum to 1). */
  weight: number;
  /** One of the dimensions the position is judged on most. */
  key: boolean;
}

export interface DimensionImpact {
  dimension: Dimension;
  percentile: number;
  /** The position's weight for the dimension. */
  weight: number;
  /** One of the dimensions the position is judged on most. */
  key: boolean;
  /**
   * The dimension's share of this record's score: its weight divided by the weights of the dimensions the match had
   * data for, as the combined value renormalizes them.
   */
  share: number;
  /** Share times the distance from the median: how much the dimension moved the combined value. */
  impact: number;
}

export interface Neighbour {
  tier: HorseTier;
  /** True when the neighbour has the same tier, which happens only in teams larger than five. */
  sameTier: boolean;
  score: number;
  /** Always positive: how far the neighbour is from this record's score. */
  gap: number;
  /** The printed gap is within CLOSE_GAP, so the 军师 admits 惜败 (above) or 险胜 (below). */
  close: boolean;
}

export interface Verdict {
  record: HorseRecord;
  /** The position label, or 未知位置 when Riot could not tell; such records use the all-position weights. */
  positionLabel: string;
  /** All nine dimensions in their fixed order, for the radar. */
  dimensions: VerdictDimension[];
  /** The counted dimensions below the median that cost the most, costliest first. Empty when none is below the median. */
  drags: DimensionImpact[];
  /**
   * Whether every dimension the match had data for is at or above the median, counted or not. The radar shows them
   * all, so "每一项" may only be said when this holds; otherwise only the counted ones are meant.
   */
  allAboveMedian: boolean;
  /** The dimension that helped the most, when any is above the median. */
  best: DimensionImpact | null;
  /** The teammate ranked one place higher, or null for the 特等马. */
  above: Neighbour | null;
  /** The teammate ranked one place lower, or null for the last place. */
  below: Neighbour | null;
}

/** A gap as the announcement rounds scores; a gap that rounds to nothing still says it was not nothing. */
export function formatGap(gap: number): string {
  const text = formatScore(gap);
  return text === "0.0" ? "不到 0.1" : text;
}

function neighbour(record: HorseRecord, rank: number, score: number | null): Neighbour | null {
  if (score === null || rank < 1 || rank > record.teamSize) return null;
  const gap = Math.abs(score - record.score);
  const tier = tierForRank(rank, record.teamSize);
  return { tier, sameTier: tier === record.tier, score, gap, close: Number(formatScore(gap)) <= CLOSE_GAP };
}

/** Explains one stored record: what it was judged on, what cost it and how close the neighbouring tiers were. */
export function buildVerdict(record: HorseRecord): Verdict {
  const weights = ROLE_WEIGHTS[record.position ?? "ALL"];
  const dimensions = DIMENSIONS.map((dimension): VerdictDimension => ({
    dimension,
    percentile: record.dimensions[dimension],
    weight: weights[dimension],
    key: weights[dimension] >= KEY_WEIGHT,
  }));
  // A dimension with no weight for the position, or no data, did not count, as in the ranking itself.
  const counted = dimensions.filter((entry): entry is VerdictDimension & { percentile: number } =>
    entry.percentile !== undefined && entry.weight > 0);
  const total = counted.reduce((sum, entry) => sum + entry.weight, 0);
  const impacts = counted.map((entry): DimensionImpact => {
    const share = entry.weight / total;
    return { dimension: entry.dimension, percentile: entry.percentile, weight: entry.weight, key: entry.key, share, impact: share * (entry.percentile - MEDIAN) };
  });
  const order = (a: DimensionImpact, b: DimensionImpact) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension);
  const drags = impacts.filter((entry) => entry.impact < 0).sort((a, b) => a.impact - b.impact || order(a, b)).slice(0, MAX_DRAGS);
  const helps = impacts.filter((entry) => entry.impact > 0).sort((a, b) => b.impact - a.impact || order(a, b));
  return {
    record,
    positionLabel: record.position ? POSITION_LABELS[record.position] : "未知位置",
    dimensions,
    drags,
    allAboveMedian: dimensions.every((entry) => entry.percentile === undefined || entry.percentile >= MEDIAN),
    best: helps[0] ?? null,
    above: neighbour(record, record.teamRank - 1, record.scoreAbove),
    below: neighbour(record, record.teamRank + 1, record.scoreBelow),
  };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Deterministic, so the same match and member always read the same. */
export function pick<T>(options: readonly T[], seed: string): T {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return options[(state >>> 0) % options.length];
}

/** How a neighbour is named: by tier, or by place when it shares the member's tier. */
export function neighbourName(neighbour: Neighbour, direction: "above" | "below"): string {
  return neighbour.sameTier ? (direction === "above" ? "上一名" : "下一名") : neighbour.tier;
}

/** "每一项" when it is true of the whole radar, otherwise only of the dimensions that counted. */
export function everyItem(verdict: Verdict): string {
  return verdict.allAboveMedian ? "每一项" : "计入评分的每一项";
}

/**
 * Up to two of the record's own statistics behind a weak dimension, worded for a reader. Evidence is only ever quoted
 * against the member, so a signed statistic that favours them, such as a gold lead, is left out rather than
 * printed as praise beside a low percentile.
 */
export function dimensionEvidence(dimension: Dimension, record: HorseRecord): string[] {
  const f: FeatureValues = record.features;
  const minutes = record.durationSeconds / 60;
  const lines: Array<string | undefined> = [];
  switch (dimension) {
    case "damage":
      lines.push(f.damageShare === undefined ? undefined : `伤害占全队 ${percent(f.damageShare)}`);
      lines.push(f.damagePerMinute === undefined ? undefined : `每分钟 ${Math.round(f.damagePerMinute)} 伤害`);
      break;
    case "teamfight":
      lines.push(f.killParticipation === undefined ? undefined : `参团率 ${percent(f.killParticipation)}`);
      lines.push(`${record.kills}/${record.deaths}/${record.assists}`);
      break;
    case "survival":
      lines.push(`阵亡 ${record.deaths} 次`);
      lines.push(f.killLifeAssist === undefined ? undefined : `(击杀+助攻)/(阵亡+1) = ${f.killLifeAssist.toFixed(1)}`);
      break;
    case "economy":
      lines.push(f.goldPerMinute === undefined ? undefined : `每分钟 ${Math.round(f.goldPerMinute)} 金币`);
      lines.push(f.csPerMinute === undefined ? undefined : `每分钟补刀 ${f.csPerMinute.toFixed(1)}`);
      break;
    case "frontline":
      lines.push(f.damageTakenShare === undefined ? undefined : `承伤占全队 ${percent(f.damageTakenShare)}`);
      lines.push(f.mitigatedPerMinute === undefined ? undefined : `每分钟减免 ${Math.round(f.mitigatedPerMinute)} 伤害`);
      break;
    case "vision":
      lines.push(f.visionPerMinute === undefined ? undefined : `每分钟视野得分 ${f.visionPerMinute.toFixed(1)}`);
      lines.push(f.controlWardsPerMinute === undefined ? undefined : `插了 ${Math.round(f.controlWardsPerMinute * minutes)} 个真眼`);
      break;
    case "objectives":
      // Building damage is the heaviest objectives feature, then the share of the team's dragons, heralds and barons.
      lines.push(f.buildingDamagePerMinute === undefined ? undefined : `每分钟 ${Math.round(f.buildingDamagePerMinute)} 建筑伤害`);
      lines.push(f.epicObjectiveShare === undefined ? undefined : `龙、先锋和大龙参与 ${percent(f.epicObjectiveShare)}`);
      lines.push(f.turretShare === undefined ? undefined : `推塔参与 ${percent(f.turretShare)}`);
      break;
    case "utility":
      lines.push(f.healShieldPerMinute === undefined ? undefined : `每分钟治疗护盾 ${Math.round(f.healShieldPerMinute)}`);
      lines.push(f.ccPerMinute === undefined ? undefined : `每分钟控制 ${f.ccPerMinute.toFixed(1)} 秒`);
      break;
    case "matchup": {
      const deficit = f.goldDiffPerMinute === undefined ? undefined : Math.round(-f.goldDiffPerMinute * minutes);
      lines.push(deficit !== undefined && deficit > 0 ? `比对位少 ${deficit} 经济` : undefined);
      lines.push(f.maxCsAdvantage !== undefined && f.maxCsAdvantage <= 0 ? "补刀从没领先过对位" : undefined);
      break;
    }
  }
  return lines.filter((line): line is string => line !== undefined).slice(0, 2);
}

/** What to do about a weak dimension, about play only. */
const ADVICE: Record<Dimension, string> = {
  damage: "多打点伤害",
  teamfight: "多跟几波团",
  survival: "少送几次",
  economy: "多补几个兵",
  frontline: "多扛点伤害",
  vision: "多插几个眼",
  objectives: "多推塔拿龙",
  utility: "多给队友套盾控人",
  matchup: "对线别被压",
};

/**
 * The 军师's one-line summary of a verdict. It says 你 only when the viewer is the member, and talks about play only.
 * Seeded by match and member, so the same verdict always reads the same.
 */
export function verdictSummary(verdict: Verdict, self: boolean): string {
  const { record, drags, best, above } = verdict;
  const who = self ? "你" : `<@${record.discordUserId}>`;
  const seed = `${record.matchId}:${record.discordUserId}`;
  const worst = drags[0];
  if (record.tier === "特等马" || !above) {
    const strength = best ? `${DIMENSION_LABELS[best.dimension]}超过 ${percent(best.percentile)} 的同位置玩家，` : "";
    return `${strength}${pick(["队内第一，这一局的马鞭归" + who + "，军师无可挑剔。", "特等马实至名归，军师的扇子给" + who + "扇风。"], seed)}`;
  }
  if (above.close) {
    const advice = worst ? `${ADVICE[worst.dimension]}就上去了` : "下把再争一口气";
    return `离${neighbourName(above, "above")}只差 ${formatGap(above.gap)} 分，惜败，${advice}。`;
  }
  if (!worst) {
    return `${everyItem(verdict)}都在同位置中位数以上，只是队友更猛，${record.tier}输在了比较上。`;
  }
  const line = `${DIMENSION_LABELS[worst.dimension]}只超过 ${percent(worst.percentile)} 的同位置玩家，`;
  if (record.tier === "没有马") {
    const endings = [`军师判${who}没有马，有理有据。`, `下把${ADVICE[worst.dimension]}，马厩还给${who}留着位置。`];
    // Only a key dimension of a known position is what that position is judged on most.
    if (worst.key && record.position) endings.unshift(`这是${verdict.positionLabel}最看重的地方之一，判得不冤。`);
    return line + pick(endings, seed);
  }
  return `${line}${ADVICE[worst.dimension]}，下把就不是${record.tier}了。`;
}

/**
 * The public ruling on an appeal. Always 维持原判: it cites the strongest data against the appellant and admits
 * 惜败 or 险胜 when a neighbouring rank was within CLOSE_GAP. Seeded by match and appellant.
 */
export function appealRuling(verdict: Verdict): string {
  const { record, drags, above, below } = verdict;
  const seed = `${record.matchId}:${record.discordUserId}:appeal`;
  const tier = record.tier;
  const lines: string[] = [];
  lines.push(pick([
    `<@${record.discordUserId}> 不服${tier}的判决，提起上诉。`,
    `<@${record.discordUserId}> 拍案而起，对${tier}的判决提起上诉。`,
    `<@${record.discordUserId}> 击鼓鸣冤，坚称自己不是${tier}。`,
  ], seed));

  const worst = drags[0];
  if (!above) {
    lines.push("特等马也要上诉？军师翻遍马厩，也没有比特等马更高的档位了。");
  } else if (worst) {
    const evidence = dimensionEvidence(worst.dimension, record);
    lines.push(`呈堂证供：${DIMENSION_LABELS[worst.dimension]}只超过 ${percent(worst.percentile)} 的同位置玩家，`
      + `而这一项在这局${verdict.positionLabel}评分里占 ${percent(worst.share)}${evidence.length > 0 ? `，${evidence.join("，")}` : ""}。`);
  } else {
    lines.push(`呈堂证供：${everyItem(verdict)}都在同位置中位数以上，但队内第 ${record.teamRank - 1} 名比你高 ${formatGap(above.gap)} 分，比较之下，${tier}没有判错。`);
  }

  if (below?.close) {
    lines.push(below.sameTier
      ? `顺便提醒，你只比下一名多 ${formatGap(below.gap)} 分，这是险胜。`
      : `顺便提醒，你只比${below.tier}多 ${formatGap(below.gap)} 分，这是险胜，再闹下去怕要改判成${below.tier}。`);
  }
  const admission = above?.close ? `军师承认这一局是惜败，离${neighbourName(above, "above")}只差 ${formatGap(above.gap)} 分。可差一点也是差，` : "";
  lines.push(`${admission}驳回上诉，维持原判：${tier}。${pick(["退堂！", "此案到此为止，下把峡谷见真章。", "军师的扇子就是法槌。"], seed)}`);
  return lines.join("\n");
}

/** Lets a member's latest record, or a chosen one, be explained. Mock and real records are never mixed. */
export function findVerdictRecord(guildId: string, discordUserId: string, mock: boolean, matchId?: string | null): HorseRecord | undefined {
  if (!matchId) return listHorseRecords(guildId, { mock, discordUserId, order: "desc", limit: 1 })[0];
  const candidates = /^\d+$/.test(matchId) ? [matchId, `NA1_${matchId}`] : [matchId];
  for (const candidate of candidates) {
    const record = listMatchHorseRecords(guildId, candidate, mock).find((entry) => entry.discordUserId === discordUserId);
    if (record) return record;
  }
  return undefined;
}

/** A member's latest records, newest first, to offer as /why match choices. */
export function listVerdictChoices(guildId: string, discordUserId: string, mock: boolean, limit = 25): HorseRecord[] {
  return listHorseRecords(guildId, { mock, discordUserId, order: "desc", limit });
}
