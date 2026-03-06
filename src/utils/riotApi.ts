import { RankedEntry, RiotAccount, Summoner } from "../types";

const NA1_BASE_URL = "https://na1.api.riotgames.com";
const AMERICAS_BASE_URL = "https://americas.api.riotgames.com";

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

export async function getAccountByRiotId(
  gameName: string,
  tagLine: string,
): Promise<RiotAccount> {
  const url = `${AMERICAS_BASE_URL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  return riotFetch<RiotAccount>(url);
}

export async function getSummonerByPuuid(puuid: string): Promise<Summoner> {
  const url = `${NA1_BASE_URL}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
  return riotFetch<Summoner>(url);
}

export async function getRankedEntries(summonerId: string): Promise<RankedEntry[]> {
  const url = `${NA1_BASE_URL}/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`;
  return riotFetch<RankedEntry[]>(url);
}
