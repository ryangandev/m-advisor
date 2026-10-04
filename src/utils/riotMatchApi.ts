import { CHALLENGE_STATS, PERFORMANCE_STATS, POSITIONS } from "../types";
import type { MatchDetail, MatchParticipant, ParticipantPerformance, Position, TeamObjectives } from "../types";
import { getRiotMode, RiotApiError, riotFetch, riotNumber, riotObject } from "../services/riotData";

const AMERICAS = "https://americas.api.riotgames.com";
// Current Riot game constants include Swiftplay and Quickplay; keep Blind Pick for older history.
const SR_QUEUE_IDS = [400, 420, 430, 440, 480, 490];
const matchCache = new Map<string, MatchDetail>();

export async function getLatestSRMatchId(puuid: string): Promise<string | null> {
  const idsUrl = `${AMERICAS}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=20`;
  const matchIds = await riotFetch<unknown>(idsUrl);
  if (!Array.isArray(matchIds) || matchIds.some((id) => typeof id !== "string")) {
    throw new RiotApiError("Riot API returned invalid match history.", "invalid_response");
  }

  for (const matchId of matchIds) {
    const detail = await getMatchDetail(matchId);
    if (SR_QUEUE_IDS.includes(detail.info.queueId)) {
      return matchId;
    }
  }

  return null;
}

export async function getMatchDetail(matchId: string): Promise<MatchDetail> {
  const cacheKey = `${getRiotMode()}:${matchId}`;
  const cached = matchCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const detailUrl = `${AMERICAS}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const detail = parseMatchDetail(await riotFetch<unknown>(detailUrl), matchId);
  matchCache.set(cacheKey, structuredClone(detail));
  if (matchCache.size > 200) matchCache.delete(matchCache.keys().next().value!);
  return detail;
}

/** Validates a match-v5 response body and keeps the fields used for announcements and scoring. */
export function parseMatchDetail(body: unknown, matchId: string): MatchDetail {
  const raw = riotObject(body);
  const info = riotObject(raw.info);
  const metadata = riotObject(raw.metadata);
  if (!Array.isArray(info.participants) || info.participants.length === 0) {
    throw new RiotApiError("Riot API returned a match without participants.", "invalid_response");
  }
  const participants = info.participants.map(parseParticipant);
  if (metadata.matchId !== matchId) throw new RiotApiError("Riot API returned a mismatched match ID.", "invalid_response");
  return {
    metadata: { matchId, participants: participants.map((player) => player.puuid) },
    info: {
      queueId: riotNumber(info.queueId),
      gameDuration: riotNumber(info.gameDuration),
      gameEndTimestamp: typeof info.gameEndTimestamp === "number" && info.gameEndTimestamp > 0 ? info.gameEndTimestamp : null,
      earlySurrender: info.participants.some((value) => riotObject(value).gameEndedInEarlySurrender === true),
      // Older matches omit endOfGameResult, so a game in which nobody won also counts as aborted.
      aborted: (typeof info.endOfGameResult === "string" && info.endOfGameResult !== "GameComplete")
        || !participants.some((player) => player.win),
      teams: Array.isArray(info.teams) ? info.teams.map(parseTeam) : [],
      participants,
    },
  };
}

function parsePosition(...values: unknown[]): Position | null {
  for (const value of values) {
    if (typeof value === "string" && (POSITIONS as readonly string[]).includes(value)) return value as Position;
  }
  return null;
}

/** Keeps finite numbers only; scoring treats an omitted statistic as unavailable rather than zero. */
function parsePerformance(player: Record<string, unknown>): ParticipantPerformance {
  const challenges = player.challenges && typeof player.challenges === "object" && !Array.isArray(player.challenges)
    ? player.challenges as Record<string, unknown> : {};
  const stats: ParticipantPerformance = {};
  for (const key of PERFORMANCE_STATS) {
    if (typeof player[key] === "number" && Number.isFinite(player[key])) stats[key] = player[key];
  }
  for (const key of CHALLENGE_STATS) {
    if (typeof challenges[key] === "number" && Number.isFinite(challenges[key])) stats[key] = challenges[key];
  }
  return stats;
}

function parseParticipant(value: unknown): MatchParticipant {
  const player = riotObject(value);
  if (typeof player.puuid !== "string" || !player.puuid || (player.win !== undefined && typeof player.win !== "boolean")) {
    throw new RiotApiError("Riot API returned an invalid match participant.", "invalid_response");
  }
  return {
    puuid: player.puuid,
    riotIdGameName: typeof player.riotIdGameName === "string" ? player.riotIdGameName : "",
    championId: riotNumber(player.championId),
    championName: typeof player.championName === "string" ? player.championName : "",
    position: parsePosition(player.teamPosition, player.individualPosition),
    kills: riotNumber(player.kills), deaths: riotNumber(player.deaths), assists: riotNumber(player.assists),
    win: player.win === true, teamId: riotNumber(player.teamId),
    stats: parsePerformance(player),
  };
}

function parseTeam(value: unknown): TeamObjectives {
  const team = riotObject(value);
  const objectives = team.objectives && typeof team.objectives === "object" ? team.objectives as Record<string, unknown> : {};
  const kills = (name: string) => {
    const objective = objectives[name];
    return objective && typeof objective === "object" ? riotNumber((objective as Record<string, unknown>).kills) : 0;
  };
  return { teamId: riotNumber(team.teamId), dragon: kills("dragon"), baron: kills("baron"), riftHerald: kills("riftHerald"), tower: kills("tower") };
}

export { SR_QUEUE_IDS };
