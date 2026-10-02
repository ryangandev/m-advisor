import { createHash } from "node:crypto";
import type { MatchDetail, RankedEntry, RiotAccount, Summoner } from "../types";

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

export function buildMockMatch(profile: MockProfile, matchId: string, outcome: MockOutcome): MatchDetail {
  const won = outcome === "win";
  const participants: MatchDetail["info"]["participants"] = [
    { puuid: profile.account.puuid, riotIdGameName: profile.account.gameName, kills: won ? 8 : 2, deaths: won ? 2 : 7, assists: won ? 12 : 4, win: won, teamId: 100 },
    { puuid: "MOCK-ALLY-1", riotIdGameName: "模拟队友一", kills: 6, deaths: 3, assists: 9, win: won, teamId: 100 },
    { puuid: "MOCK-ALLY-2", riotIdGameName: "模拟队友二", kills: 3, deaths: 4, assists: 10, win: won, teamId: 100 },
    { puuid: "MOCK-ALLY-3", riotIdGameName: "模拟队友三", kills: 1, deaths: 9, assists: 2, win: won, teamId: 100 },
    { puuid: "MOCK-ALLY-4", riotIdGameName: "模拟队友四", kills: 4, deaths: 3, assists: 14, win: won, teamId: 100 },
    // Deliberately give an enemy the top KDA in a loss fixture to catch incorrect victory inference.
    { puuid: "MOCK-ENEMY-1", riotIdGameName: "模拟对手一", kills: won ? 3 : 18, deaths: won ? 7 : 1, assists: 11, win: !won, teamId: 200 },
    { puuid: "MOCK-ENEMY-2", riotIdGameName: "模拟对手二", kills: 4, deaths: 5, assists: 8, win: !won, teamId: 200 },
    { puuid: "MOCK-ENEMY-3", riotIdGameName: "模拟对手三", kills: 2, deaths: 6, assists: 9, win: !won, teamId: 200 },
    { puuid: "MOCK-ENEMY-4", riotIdGameName: "模拟对手四", kills: 5, deaths: 4, assists: 5, win: !won, teamId: 200 },
    { puuid: "MOCK-ENEMY-5", riotIdGameName: "模拟对手五", kills: 1, deaths: 5, assists: 13, win: !won, teamId: 200 },
  ];
  return {
    metadata: { matchId, participants: participants.map((participant) => participant.puuid) },
    info: { queueId: 420, gameDuration: 1800, participants },
  };
}
