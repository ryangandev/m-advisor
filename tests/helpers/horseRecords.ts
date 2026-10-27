import type { HorseRecord } from "../../src/store/horseRecordStore";

let sequence = 0;

/** A valid record for tests; every field can be overridden. Dimensions are all 0.5 unless given. */
export function makeHorseRecord(overrides: Partial<HorseRecord> = {}): HorseRecord {
  sequence += 1;
  return {
    guildId: "guild-one",
    discordUserId: "member-one",
    matchId: `NA1_${sequence}`,
    puuid: "account-a",
    mock: false,
    playedAt: 1_800_000_000_000 + sequence * 60_000,
    recordedAt: 1_800_000_100_000 + sequence * 60_000,
    queueId: 420,
    durationSeconds: 1800,
    won: true,
    position: "MIDDLE",
    championId: 103,
    championName: "Ahri",
    kills: 5,
    deaths: 3,
    assists: 8,
    tier: "中等马",
    teamRank: 3,
    teamSize: 5,
    score: 5,
    composite: 0.5,
    scoreAbove: 6.5,
    scoreBelow: 3.2,
    dimensions: { damage: 0.5, teamfight: 0.5, survival: 0.5, economy: 0.5, vision: 0.5, objectives: 0.5, matchup: 0.5 },
    features: { damageShare: 0.22, killParticipation: 0.6 },
    benchmarkVersion: 1,
    benchmarkCollectedAt: "2026-10-03",
    ...overrides,
  };
}
