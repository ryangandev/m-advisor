import type { MatchDetail } from "../types";
import type { HorseRecord } from "../store/horseRecordStore";
import { MIN_RANKED_MINUTES } from "./announcementText";
import { DEFAULT_BENCHMARKS, rankTeam } from "./horseRanking";
import type { Benchmarks, HorseRanking } from "./horseRanking";

/** A tracked member and one of their Riot accounts. A member with several accounts contributes one pair per account. */
export interface TrackedAccount {
  discordUserId: string;
  puuid: string;
}

export interface BuildHorseRecordsInput {
  guildId: string;
  detail: MatchDetail;
  /** Every tracked member of the server with their accounts; only those who played this match produce records. */
  tracked: readonly TrackedAccount[];
  /** Whether the data came from mock fixtures. Mock records are stored apart from real ones. */
  mock: boolean;
  /** Recording time in Unix milliseconds, also the fallback game time when Riot omitted the end time. */
  recordedAt?: number;
  /** Must be the benchmarks the announcement was built with; the default reference otherwise. */
  benchmarks?: Benchmarks;
  /** Rankings the caller already computed with the same benchmarks; any team without one is ranked here. */
  rankings?: readonly HorseRanking[];
}

/**
 * Turns one announced match into the 马厩 records of the tracked members who played it.
 * Only tracked members are ever returned: teammates and enemies are ranked to place the members, then dropped.
 * A tracked member on the other team from the announcement's perspective is a friend, so they are recorded
 * from their own team's ranking.
 * Remakes, stopped games and games under the minimum length are not judged by the announcement, so they leave no record.
 * A member appears at most once per match, through the first of their accounts in the input.
 */
export function buildHorseRecords(input: BuildHorseRecordsInput): HorseRecord[] {
  const { guildId, detail, tracked, mock } = input;
  const benchmarks = input.benchmarks ?? DEFAULT_BENCHMARKS;
  const recordedAt = input.recordedAt ?? Date.now();
  const info = detail.info;
  if (info.aborted || info.earlySurrender || info.gameDuration / 60 < MIN_RANKED_MINUTES) return [];

  const rankingsByTeam = new Map<number, HorseRanking>();
  for (const ranking of input.rankings ?? []) {
    const team = ranking.horses[0]?.participant.teamId;
    if (ranking.matchId === detail.metadata.matchId && team !== undefined) rankingsByTeam.set(team, ranking);
  }

  const records: HorseRecord[] = [];
  const seenMembers = new Set<string>();
  for (const { discordUserId, puuid } of tracked) {
    if (seenMembers.has(discordUserId)) continue;
    const participant = info.participants.find((player) => player.puuid === puuid);
    if (!participant) continue;
    let ranking = rankingsByTeam.get(participant.teamId);
    if (!ranking) {
      ranking = rankTeam(detail, puuid, benchmarks);
      rankingsByTeam.set(participant.teamId, ranking);
    }
    const index = ranking.horses.findIndex((horse) => horse.participant.puuid === puuid);
    if (index === -1) continue;
    const horse = ranking.horses[index];
    seenMembers.add(discordUserId);
    records.push({
      guildId,
      discordUserId,
      matchId: detail.metadata.matchId,
      puuid,
      mock,
      playedAt: info.gameEndTimestamp ?? recordedAt,
      recordedAt,
      queueId: info.queueId,
      durationSeconds: Math.round(info.gameDuration),
      won: participant.win,
      position: participant.position,
      championId: participant.championId,
      championName: participant.championName || "Unknown",
      kills: participant.kills,
      deaths: participant.deaths,
      assists: participant.assists,
      tier: horse.tier,
      teamRank: horse.rank,
      teamSize: ranking.horses.length,
      score: horse.score,
      composite: horse.composite,
      scoreAbove: index > 0 ? ranking.horses[index - 1].score : null,
      scoreBelow: index < ranking.horses.length - 1 ? ranking.horses[index + 1].score : null,
      dimensions: { ...horse.dimensions },
      features: { ...horse.features },
      benchmarkVersion: benchmarks.version,
      benchmarkCollectedAt: benchmarks.sample.collectedAt,
    });
  }
  return records;
}
