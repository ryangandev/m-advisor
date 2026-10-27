import type { HorseRecord } from "../../src/store/horseRecordStore";
import { makeHorseRecord } from "./horseRecords";

/** A 没有马 support who just missed 下等马: the costliest dimensions are vision, teamfight and utility. */
export function seededSupport(overrides: Partial<HorseRecord> = {}): HorseRecord {
  return makeHorseRecord({
    matchId: "NA1_5100000001",
    discordUserId: "support-friend",
    puuid: "puuid-support",
    position: "UTILITY",
    championId: 412,
    championName: "Thresh",
    tier: "没有马",
    teamRank: 5,
    teamSize: 5,
    score: 1.6,
    composite: 0.31,
    scoreAbove: 1.8,
    scoreBelow: null,
    won: false,
    kills: 0,
    deaths: 9,
    assists: 4,
    durationSeconds: 1800,
    dimensions: { damage: 0.42, teamfight: 0.18, survival: 0.12, economy: 0.55, frontline: 0.35, vision: 0.09, objectives: 0.3, utility: 0.22, matchup: 0.4 },
    features: { killParticipation: 0.24, visionPerMinute: 0.8, controlWardsPerMinute: 0.1, damageShare: 0.06, healShieldPerMinute: 20, ccPerMinute: 0.4, killLifeAssist: 0.4 },
    commentaryTone: "roast",
    commentary: "参团率24%，队友在打团，你在峡谷里旅游采风。",
    ...overrides,
  });
}

/** A 特等马 jungler who only just held off the 上等马. */
export function seededJungler(overrides: Partial<HorseRecord> = {}): HorseRecord {
  return makeHorseRecord({
    matchId: "NA1_5100000002",
    discordUserId: "jungle-friend",
    puuid: "puuid-jungle",
    position: "JUNGLE",
    championId: 64,
    championName: "LeeSin",
    tier: "特等马",
    teamRank: 1,
    teamSize: 5,
    score: 9.4,
    composite: 0.81,
    scoreAbove: null,
    scoreBelow: 9.2,
    won: true,
    kills: 11,
    deaths: 2,
    assists: 14,
    dimensions: { damage: 0.81, teamfight: 0.93, survival: 0.88, economy: 0.74, frontline: 0.52, vision: 0.66, objectives: 0.97, utility: 0.41, matchup: 0.7 },
    features: { killParticipation: 0.78, turretShare: 0.4, epicObjectiveShare: 0.8 },
    ...overrides,
  });
}
