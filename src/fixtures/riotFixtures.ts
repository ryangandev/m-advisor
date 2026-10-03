import { createHash } from "node:crypto";
import type { PerformanceStat, Position, RankedEntry, RiotAccount, Summoner } from "../types";

export type MockOutcome = "win" | "loss";

export const MOCK_RIOT_IDS = [
  "MockWin#NA1", "MockLoss#NA1", "MockUnranked#NA1", "MockAlt#NA1",
  "MockRateLimit#NA1", "MockService#NA1", "MockAuth#NA1", "MockMissing#NA1",
] as const;

export interface MockProfile {
  account: RiotAccount;
  summoner: Summoner;
  ranked: RankedEntry[];
  outcome: MockOutcome;
  failureStatus?: number;
}

export function buildMockProfile(gameName: string, tagLine: string): MockProfile {
  const normalizedId = `${gameName}#${tagLine}`.toLowerCase();
  const digest = createHash("sha256").update(normalizedId).digest("hex").slice(0, 24);
  const puuid = `MOCK-${digest}`;
  const name = gameName.toLowerCase();
  const account = { puuid, gameName, tagLine };
  const failureStatus = ({
    mockratelimit: 429, mockservice: 503, mockauth: 401, mockmissing: 404,
  } as Record<string, number>)[name];
  return {
    account,
    summoner: {
      id: `MOCK-SUMMONER-${digest}`, accountId: `MOCK-ACCOUNT-${digest}`, puuid,
      name: gameName, profileIconId: 29, summonerLevel: name === "mockalt" ? 88 : 245,
    },
    ranked: name === "mockunranked" ? [] : [
      { queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: 64, wins: 42, losses: 35 },
      { queueType: "RANKED_FLEX_SR", tier: "SILVER", rank: "I", leaguePoints: 28, wins: 17, losses: 12 },
    ],
    outcome: name === "mockloss" ? "loss" : "win",
    failureStatus,
  };
}

/** A match-v5 response body, so mock matches exercise the same parser as real ones. */
export type RawMatch = { metadata: { matchId: string; participants: string[] }; info: Record<string, unknown> };
type RawStats = Partial<Record<PerformanceStat, number>>;

// Typical 30-minute values per position; each fixture player scales or overrides them.
const ROLE_BASE: Record<Position, RawStats> = {
  TOP: { goldEarned: 11400, totalMinionsKilled: 210, neutralMinionsKilled: 8, champExperience: 15500, totalDamageDealtToChampions: 17000, totalDamageTaken: 36000, damageSelfMitigated: 38000, damageDealtToBuildings: 4500, visionScore: 22, wardsKilled: 3, detectorWardsPlaced: 2, timeCCingOthers: 35, turretTakedowns: 3, enemyChampionImmobilizations: 14, maxCsAdvantageOnLaneOpponent: 15, soloKills: 1, riftHeraldTakedowns: 1, dragonTakedowns: 1 },
  JUNGLE: { goldEarned: 11100, totalMinionsKilled: 30, neutralMinionsKilled: 180, champExperience: 13500, totalDamageDealtToChampions: 18000, totalDamageTaken: 30000, damageSelfMitigated: 25000, damageDealtToBuildings: 2000, visionScore: 36, wardsKilled: 8, detectorWardsPlaced: 5, timeCCingOthers: 28, turretTakedowns: 2, enemyChampionImmobilizations: 12, maxCsAdvantageOnLaneOpponent: 12, dragonTakedowns: 3, baronTakedowns: 1, riftHeraldTakedowns: 1 },
  MIDDLE: { goldEarned: 12000, totalMinionsKilled: 225, neutralMinionsKilled: 10, champExperience: 15000, totalDamageDealtToChampions: 24000, totalDamageTaken: 20000, damageSelfMitigated: 9000, damageDealtToBuildings: 3500, visionScore: 24, wardsKilled: 4, detectorWardsPlaced: 2, timeCCingOthers: 22, turretTakedowns: 3, enemyChampionImmobilizations: 10, maxCsAdvantageOnLaneOpponent: 18, soloKills: 1, dragonTakedowns: 2 },
  BOTTOM: { goldEarned: 12800, totalMinionsKilled: 250, neutralMinionsKilled: 10, champExperience: 13000, totalDamageDealtToChampions: 25000, totalDamageTaken: 18000, damageSelfMitigated: 6000, damageDealtToBuildings: 6000, visionScore: 20, wardsKilled: 4, detectorWardsPlaced: 1, timeCCingOthers: 8, turretTakedowns: 4, enemyChampionImmobilizations: 3, maxCsAdvantageOnLaneOpponent: 20, dragonTakedowns: 2 },
  UTILITY: { goldEarned: 7800, totalMinionsKilled: 35, neutralMinionsKilled: 0, champExperience: 10500, totalDamageDealtToChampions: 8000, totalDamageTaken: 21000, damageSelfMitigated: 18000, damageDealtToBuildings: 800, visionScore: 70, wardsKilled: 10, detectorWardsPlaced: 7, timeCCingOthers: 45, totalHealsOnTeammates: 1500, totalDamageShieldedOnTeammates: 2500, effectiveHealAndShielding: 4000, turretTakedowns: 2, enemyChampionImmobilizations: 28, saveAllyFromDeath: 1, dragonTakedowns: 2 },
};

interface FixturePlayer {
  puuid: string; name: string; championId: number; championName: string; position: Position;
  kda: [number, number, number]; scale?: number; stats?: RawStats;
}

function rawParticipant(player: FixturePlayer, teamId: number, win: boolean): Record<string, unknown> {
  const stats: RawStats = {};
  for (const [key, value] of Object.entries(ROLE_BASE[player.position]) as [PerformanceStat, number][]) {
    stats[key] = Math.round(value * (player.scale ?? 1));
  }
  Object.assign(stats, player.stats);
  stats.controlWardsPlaced = stats.detectorWardsPlaced;
  stats.wardTakedowns = stats.wardsKilled;
  const { effectiveHealAndShielding, enemyChampionImmobilizations, saveAllyFromDeath, dragonTakedowns, baronTakedowns,
    riftHeraldTakedowns, maxCsAdvantageOnLaneOpponent, soloKills, controlWardsPlaced, wardTakedowns, ...top } = stats;
  const [kills, deaths, assists] = player.kda;
  return {
    puuid: player.puuid, riotIdGameName: player.name, championId: player.championId, championName: player.championName,
    teamPosition: player.position, individualPosition: player.position, teamId, win, kills, deaths, assists,
    totalTimeSpentDead: deaths * 25, ...top,
    challenges: { effectiveHealAndShielding, enemyChampionImmobilizations, saveAllyFromDeath, dragonTakedowns, baronTakedowns,
      riftHeraldTakedowns, maxCsAdvantageOnLaneOpponent, soloKills, controlWardsPlaced, wardTakedowns },
  };
}

export function buildMockMatch(profile: MockProfile, matchId: string, outcome: MockOutcome): RawMatch {
  const won = outcome === "win";
  // Each player's takedowns stay within their team's kills, and each team's kills equal the other team's deaths.
  const allies: FixturePlayer[] = [
    { puuid: profile.account.puuid, name: profile.account.gameName, championId: 103, championName: "Ahri", position: "MIDDLE",
      kda: won ? [8, 2, 7] : [2, 7, 4], scale: won ? 1.15 : 0.8 },
    { puuid: "MOCK-ALLY-1", name: "模拟队友一", championId: 516, championName: "Ornn", position: "TOP",
      kda: won ? [2, 3, 9] : [2, 3, 6], scale: 1.05 },
    { puuid: "MOCK-ALLY-2", name: "模拟队友二", championId: 64, championName: "LeeSin", position: "JUNGLE",
      kda: won ? [6, 3, 9] : [6, 3, 3] },
    // A feeding carry with low damage, so ranking cannot simply follow kills.
    { puuid: "MOCK-ALLY-3", name: "模拟队友三", championId: 222, championName: "Jinx", position: "BOTTOM", kda: [1, 9, 2], scale: 0.6,
      stats: { visionScore: 8, maxCsAdvantageOnLaneOpponent: 0 } },
    // A support with no kills but excellent vision and protection.
    { puuid: "MOCK-ALLY-4", name: "模拟队友四", championId: 412, championName: "Thresh", position: "UTILITY",
      kda: won ? [0, 4, 16] : [0, 4, 9], scale: 1.25 },
  ];
  const enemies: FixturePlayer[] = [
    { puuid: "MOCK-ENEMY-1", name: "模拟对手一", championId: 238, championName: "Zed", position: "MIDDLE",
      // Deliberately give an enemy the top KDA in a loss fixture to catch incorrect victory inference.
      kda: won ? [6, 4, 8] : [14, 1, 8], scale: won ? 0.85 : 1.3 },
    { puuid: "MOCK-ENEMY-2", name: "模拟对手二", championId: 122, championName: "Darius", position: "TOP", kda: won ? [4, 3, 8] : [4, 3, 9] },
    { puuid: "MOCK-ENEMY-3", name: "模拟对手三", championId: 121, championName: "Khazix", position: "JUNGLE",
      kda: won ? [3, 4, 9] : [3, 3, 12], scale: 0.9 },
    { puuid: "MOCK-ENEMY-4", name: "模拟对手四", championId: 51, championName: "Caitlyn", position: "BOTTOM", kda: won ? [7, 3, 6] : [4, 2, 10] },
    { puuid: "MOCK-ENEMY-5", name: "模拟对手五", championId: 89, championName: "Leona", position: "UTILITY",
      kda: won ? [1, 3, 13] : [1, 2, 16], scale: 0.9 },
  ];
  const participants = [
    ...allies.map((player) => rawParticipant(player, 100, won)),
    ...enemies.map((player) => rawParticipant(player, 200, !won)),
  ];
  const team = (teamId: number, ahead: boolean) => ({
    teamId, win: teamId === 100 ? won : !won,
    objectives: { dragon: { kills: ahead ? 3 : 1 }, baron: { kills: ahead ? 1 : 0 }, riftHerald: { kills: ahead ? 1 : 0 }, tower: { kills: ahead ? 9 : 3 } },
  });
  return {
    metadata: { matchId, participants: participants.map((participant) => participant.puuid as string) },
    info: { queueId: 420, gameDuration: 1800, endOfGameResult: "GameComplete", teams: [team(100, won), team(200, !won)], participants },
  };
}
