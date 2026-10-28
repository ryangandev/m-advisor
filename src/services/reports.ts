import { listTrackedMembers } from "../store/bindingStore";
import { listHorseRecords } from "../store/horseRecordStore";
import type { HorseRecord } from "../store/horseRecordStore";
import { markReportHandled } from "../store/reportStore";
import type { ReportKind } from "../store/reportStore";
import { pacificDay, pacificWeek } from "../utils/pacificTime";
import type { TimeRange } from "../utils/pacificTime";
import { formatScore } from "./announcementText";
import { summarizeHorseRecords } from "./horseProfile";
import { HORSE_TIERS } from "./horseRanking";
import type { HorseTier } from "./horseRanking";

export type { ReportKind };

/**
 * A member needs this many games in a week to be ranked for 本周特等马 and 本周没有马.
 * Three games is the same bar the 马厩 uses before it calls a dimension a strength, and it keeps one lucky or
 * unlucky game from deciding the week.
 */
export const MIN_WEEKLY_GAMES = 3;
/** A single game is enough to be ranked for a day. */
export const MIN_DAILY_GAMES = 1;
/**
 * How long after a period ends the report waits before it counts as due, so posts go out at 00:30 Pacific.
 * A game's time is when it ended, but Riot publishes the match minutes later, the monitor polls every 45 seconds and the
 * record is written around the announcement. Half an hour keeps a game that ended just before midnight in its own period.
 */
export const REPORT_GRACE_MS = 30 * 60_000;

export const minGamesFor = (kind: ReportKind): number => (kind === "day" ? MIN_DAILY_GAMES : MIN_WEEKLY_GAMES);

export function periodOf(kind: ReportKind, instant: number): TimeRange {
  return kind === "day" ? pacificDay(instant) : pacificWeek(instant);
}

/**
 * The latest day or week that has ended at least REPORT_GRACE_MS ago.
 * The scheduler posts exactly this period, so a report that was missed while the bot was off is still the one picked up,
 * and older missed periods are never posted.
 */
export function latestDuePeriod(kind: ReportKind, now: number): TimeRange {
  const current = periodOf(kind, now - REPORT_GRACE_MS);
  return periodOf(kind, current.start - 1);
}

/** The next instant at which a new day (and on Mondays a new week) becomes due, always later than `now`. */
export function nextReportDueAt(now: number): number {
  return pacificDay(now - REPORT_GRACE_MS).end + REPORT_GRACE_MS;
}

export interface MemberReport {
  discordUserId: string;
  games: number;
  wins: number;
  averageScore: number;
  tiers: Record<HorseTier, number>;
  /** The longest run of 特等马 inside the period. */
  topStreak: number;
  /** The longest run of 没有马 inside the period. */
  noneStreak: number;
  /** The member's highest-scoring game of the period. */
  best: HorseRecord;
  /** The member's lowest-scoring game of the period. */
  worst: HorseRecord;
  /** Whether the member played enough games to be ranked. */
  qualified: boolean;
}

export interface ReportData {
  kind: ReportKind;
  range: TimeRange;
  mock: boolean;
  minGames: number;
  totalGames: number;
  tierTotals: Record<HorseTier, number>;
  /** Ranked members first, best average first; members below the games bar follow, most games first. */
  members: MemberReport[];
  /**
   * Everyone sharing the best average among ranked members, usually one. Empty unless at least two members are ranked
   * and their averages differ.
   */
  topHorses: MemberReport[];
  /** Everyone sharing the worst average among ranked members, usually one. Empty under the same conditions as `topHorses`. */
  noneHorses: MemberReport[];
  bestGame: HorseRecord | null;
  worstGame: HorseRecord | null;
}

/**
 * An average as the embed prints it, with one decimal. Ties, ranking and the top and bottom decisions all use this, so
 * two members whose averages print the same are never split by a hidden difference (6.34 and 6.26 both print 6.3).
 */
export const printedAverage = (member: Pick<MemberReport, "averageScore">): number => Number(formatScore(member.averageScore));

/**
 * The bottom member of a 马报 still averaged at least this much: their last place is only relative, so the 军师 does
 * not roast them as a 没有马. It is also relative when their worst game of the period was a 特等马 or 上等马.
 */
export const RELATIVE_BOTTOM_AVERAGE = 6;

/** Whether a bottom member in a 马报 is last only relative to a strong field, so the roast is softened. */
export function isRelativeBottom(member: MemberReport): boolean {
  return printedAverage(member) >= RELATIVE_BOTTOM_AVERAGE || member.worst.tier === "特等马" || member.worst.tier === "上等马";
}

const byScoreThenAge = (a: HorseRecord, b: HorseRecord) => b.score - a.score || a.playedAt - b.playedAt || a.matchId.localeCompare(b.matchId);

export interface ReportInput {
  kind: ReportKind;
  range: TimeRange;
  mock: boolean;
  records: readonly HorseRecord[];
  /** Only these Discord users can appear. Anyone else's records are ignored. */
  memberIds: readonly string[];
}

/**
 * The numbers behind a report. It is pure: pass the records and the members to include.
 * Only records of the requested data mode inside the range and of the listed members are used, so mock and real
 * games and former members can never leak into a report whatever the caller passes.
 */
export function buildReportData(input: ReportInput): ReportData {
  const { kind, range, mock } = input;
  const allowed = new Set(input.memberIds);
  const records = input.records.filter((record) =>
    record.mock === mock && record.playedAt >= range.start && record.playedAt < range.end && allowed.has(record.discordUserId));
  const minGames = minGamesFor(kind);

  const perMember = new Map<string, HorseRecord[]>();
  for (const record of records) perMember.set(record.discordUserId, [...(perMember.get(record.discordUserId) ?? []), record]);

  const members: MemberReport[] = [...perMember].map(([discordUserId, own]) => {
    const profile = summarizeHorseRecords(own);
    const ordered = [...own].sort(byScoreThenAge);
    return {
      discordUserId,
      games: profile.games,
      wins: profile.wins,
      averageScore: profile.averageScore!,
      tiers: Object.fromEntries(HORSE_TIERS.map((tier) => [tier, profile.tiers[tier].count])) as Record<HorseTier, number>,
      topStreak: profile.streaks.top.best,
      noneStreak: profile.streaks.none.best,
      best: ordered[0],
      worst: ordered[ordered.length - 1],
      qualified: profile.games >= minGames,
    };
  });
  members.sort((a, b) =>
    Number(b.qualified) - Number(a.qualified)
    || (a.qualified
      ? printedAverage(b) - printedAverage(a) || b.tiers["特等马"] - a.tiers["特等马"] || b.games - a.games
      : b.games - a.games || printedAverage(b) - printedAverage(a))
    || a.discordUserId.localeCompare(b.discordUserId));

  const ranked = members.filter((member) => member.qualified);
  // Nobody is crowned or shamed when the whole field averaged the same, as printed.
  const topAverage = ranked.length > 0 ? printedAverage(ranked[0]) : 0;
  const bottomAverage = ranked.length > 0 ? printedAverage(ranked[ranked.length - 1]) : 0;
  const separated = ranked.length >= 2 && topAverage !== bottomAverage;
  const ordered = [...records].sort(byScoreThenAge);
  return {
    kind,
    range,
    mock,
    minGames,
    totalGames: records.length,
    tierTotals: Object.fromEntries(HORSE_TIERS.map((tier) => [tier, records.filter((record) => record.tier === tier).length])) as Record<HorseTier, number>,
    members,
    topHorses: separated ? ranked.filter((member) => printedAverage(member) === topAverage) : [],
    noneHorses: separated ? ranked.filter((member) => printedAverage(member) === bottomAverage) : [],
    bestGame: ordered[0] ?? null,
    worstGame: ordered[ordered.length - 1] ?? null,
  };
}

/** Loads and summarizes one period of one server for the data mode the bot runs in. Only currently tracked members appear. */
export function loadReport(guildId: string, kind: ReportKind, range: TimeRange, mock: boolean): ReportData {
  const memberIds = listTrackedMembers(guildId).map((member) => member.discordUserId);
  const records = listHorseRecords(guildId, { mock, from: range.start, to: range.end });
  return buildReportData({ kind, range, mock, records, memberIds });
}

/**
 * Marks every period that has already ended as handled, for both data modes, even one still inside its grace period.
 * Called when a channel is first set or a daily or weekly report is switched from off to on, so turning reports on posts
 * from the next period onward instead of replaying the one that just ended. `/report` still shows any finished period.
 */
export function skipFinishedPeriods(guildId: string, kinds: readonly ReportKind[], now: number): void {
  for (const kind of kinds) {
    const lastEnded = periodOf(kind, periodOf(kind, now).start - 1).start;
    for (const mock of [false, true]) markReportHandled(guildId, mock, kind, lastEnded, now);
  }
}
