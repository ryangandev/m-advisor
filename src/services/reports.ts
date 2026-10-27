import { listTrackedMembers } from "../store/bindingStore";
import { listHorseRecords } from "../store/horseRecordStore";
import type { HorseRecord } from "../store/horseRecordStore";
import { markReportHandled } from "../store/reportStore";
import type { ReportKind } from "../store/reportStore";
import { pacificDay, pacificWeek } from "../utils/pacificTime";
import type { TimeRange } from "../utils/pacificTime";
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
 * How long after a period ends the report waits before it counts as due.
 * A game that ends just before midnight is announced and recorded a little later, and this keeps it in its own day.
 */
export const REPORT_GRACE_MS = 5 * 60_000;

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
  /** The best average among ranked members, named only when at least two members are ranked and their averages differ. */
  topHorse: MemberReport | null;
  /** The worst average among ranked members, named only when at least two members are ranked and their averages differ. */
  noneHorse: MemberReport | null;
  bestGame: HorseRecord | null;
  worstGame: HorseRecord | null;
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
      ? b.averageScore - a.averageScore || b.tiers["特等马"] - a.tiers["特等马"] || b.games - a.games
      : b.games - a.games || b.averageScore - a.averageScore)
    || a.discordUserId.localeCompare(b.discordUserId));

  const ranked = members.filter((member) => member.qualified);
  // Nobody is crowned or shamed when the whole field averaged the same.
  const separated = ranked.length >= 2 && ranked[0].averageScore - ranked[ranked.length - 1].averageScore > 1e-9;
  const ordered = [...records].sort(byScoreThenAge);
  return {
    kind,
    range,
    mock,
    minGames,
    totalGames: records.length,
    tierTotals: Object.fromEntries(HORSE_TIERS.map((tier) => [tier, records.filter((record) => record.tier === tier).length])) as Record<HorseTier, number>,
    members,
    topHorse: separated ? ranked[0] : null,
    noneHorse: separated ? ranked[ranked.length - 1] : null,
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
 * Marks every period that has already finished as handled, for both data modes.
 * Called when a channel is first set or a kind is switched on, so turning reports on posts from the next period
 * onward instead of replaying yesterday. `/report` can still show any finished period on demand.
 */
export function skipFinishedPeriods(guildId: string, kinds: readonly ReportKind[], now: number): void {
  for (const kind of kinds) {
    for (const mock of [false, true]) markReportHandled(guildId, mock, kind, latestDuePeriod(kind, now).start, now);
  }
}
