import type { MatchDetail, ParticipantStats } from "../types";
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
  const raw = riotObject(await riotFetch<unknown>(detailUrl));
  const info = riotObject(raw.info);
  const metadata = riotObject(raw.metadata);
  if (!Array.isArray(info.participants) || info.participants.length === 0) {
    throw new RiotApiError("Riot API returned a match without participants.", "invalid_response");
  }
  const participants = info.participants.map((value) => {
    const player = riotObject(value);
    if (typeof player.puuid !== "string" || !player.puuid || (player.win !== undefined && typeof player.win !== "boolean")) {
      throw new RiotApiError("Riot API returned an invalid match participant.", "invalid_response");
    }
    return {
      puuid: player.puuid,
      riotIdGameName: typeof player.riotIdGameName === "string" ? player.riotIdGameName : "",
      kills: riotNumber(player.kills), deaths: riotNumber(player.deaths), assists: riotNumber(player.assists),
      win: player.win === true, teamId: riotNumber(player.teamId),
    };
  });
  if (metadata.matchId !== matchId) throw new RiotApiError("Riot API returned a mismatched match ID.", "invalid_response");
  const detail: MatchDetail = {
    metadata: { matchId, participants: participants.map((player) => player.puuid) },
    info: { queueId: riotNumber(info.queueId), gameDuration: riotNumber(info.gameDuration), participants },
  };
  matchCache.set(cacheKey, structuredClone(detail));
  if (matchCache.size > 200) matchCache.delete(matchCache.keys().next().value!);
  return detail;
}

export function getBestAndWorst(
  participants: ParticipantStats[],
): { best: ParticipantStats; worst: ParticipantStats } {
  if (participants.length === 0) {
    throw new Error("Cannot evaluate best/worst players from an empty participant list.");
  }

  const getKda = (participant: ParticipantStats): number =>
    (participant.kills + participant.assists) / Math.max(participant.deaths, 1);

  let best = participants[0];
  let worst = participants[0];

  for (const participant of participants.slice(1)) {
    if (getKda(participant) > getKda(best)) {
      best = participant;
    }
    if (getKda(participant) < getKda(worst)) {
      worst = participant;
    }
  }

  return { best, worst };
}

export { SR_QUEUE_IDS };
