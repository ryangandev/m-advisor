import { MatchDetail, ParticipantStats } from "../types";

const AMERICAS = "https://americas.api.riotgames.com";
const SR_QUEUE_IDS = [400, 420, 430, 440];

async function riotFetch<T>(url: string): Promise<T> {
  const apiKey = process.env.RIOT_API_KEY;

  if (!apiKey) {
    throw new Error("Missing RIOT_API_KEY environment variable.");
  }

  const targetUrl = new URL(url);
  targetUrl.searchParams.set("api_key", apiKey);

  const response = await fetch(targetUrl.toString());

  if (!response.ok) {
    let details = `Riot API request failed (${response.status} ${response.statusText})`;

    try {
      const body = (await response.json()) as {
        status?: { message?: string };
      };
      const message = body?.status?.message;
      if (message) {
        details = `Riot API error ${response.status}: ${message}`;
      }
    } catch {
      // Keep fallback message when response body is not JSON.
    }

    throw new Error(details);
  }

  return (await response.json()) as T;
}

export async function getLatestSRMatchId(puuid: string): Promise<string | null> {
  const idsUrl = `${AMERICAS}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=5`;
  const matchIds = await riotFetch<string[]>(idsUrl);

  for (const matchId of matchIds) {
    const detail = await getMatchDetail(matchId);
    if (SR_QUEUE_IDS.includes(detail.info.queueId)) {
      return matchId;
    }
  }

  return null;
}

export async function getMatchDetail(matchId: string): Promise<MatchDetail> {
  const detailUrl = `${AMERICAS}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  return riotFetch<MatchDetail>(detailUrl);
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
