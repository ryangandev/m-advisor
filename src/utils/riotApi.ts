import type { RankedEntry, RiotAccount, Summoner } from "../types";
import { RiotApiError, riotFetch, riotNumber, riotObject } from "../services/riotData";

const NA1_BASE_URL = "https://na1.api.riotgames.com";
const AMERICAS_BASE_URL = "https://americas.api.riotgames.com";

export async function getAccountByRiotId(
  gameName: string,
  tagLine: string,
): Promise<RiotAccount> {
  const url = `${AMERICAS_BASE_URL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const account = riotObject(await riotFetch<unknown>(url));
  if (typeof account.puuid !== "string" || !account.puuid) throw new RiotApiError("Riot API returned an invalid account.", "invalid_response");
  return {
    puuid: account.puuid,
    gameName: typeof account.gameName === "string" && account.gameName ? account.gameName : gameName,
    tagLine: typeof account.tagLine === "string" && account.tagLine ? account.tagLine : tagLine,
  };
}

export async function getSummonerByPuuid(puuid: string): Promise<Summoner> {
  const url = `${NA1_BASE_URL}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
  const summoner = riotObject(await riotFetch<unknown>(url));
  return {
    puuid,
    id: typeof summoner.id === "string" ? summoner.id : "",
    accountId: typeof summoner.accountId === "string" ? summoner.accountId : "",
    name: typeof summoner.name === "string" ? summoner.name : "",
    profileIconId: riotNumber(summoner.profileIconId),
    summonerLevel: riotNumber(summoner.summonerLevel),
  };
}

export async function getRankedEntries(puuid: string): Promise<RankedEntry[]> {
  const url = `${NA1_BASE_URL}/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  const entries = await riotFetch<unknown>(url);
  if (!Array.isArray(entries)) throw new RiotApiError("Riot API returned invalid ranked entries.", "invalid_response");
  return entries.map((value) => {
    const entry = riotObject(value);
    if (typeof entry.queueType !== "string" || typeof entry.tier !== "string" || typeof entry.rank !== "string") {
      throw new RiotApiError("Riot API returned an invalid ranked entry.", "invalid_response");
    }
    return {
      queueType: entry.queueType, tier: entry.tier, rank: entry.rank,
      leaguePoints: riotNumber(entry.leaguePoints), wins: riotNumber(entry.wins), losses: riotNumber(entry.losses),
    };
  });
}
