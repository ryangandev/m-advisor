import { EmbedBuilder } from "discord.js";
import type { RankedEntry, Summoner } from "../types";
import { getRiotDataLabel, isMockData } from "../services/riotData";

// Verified against the official versions endpoint on 2026-10-02; configurable without changing code.
const DEFAULT_DDRAGON_VERSION = "16.19.1";

export function getProfileIconUrl(profileIconId: number): string | undefined {
  const version = process.env.DDRAGON_VERSION?.trim() || DEFAULT_DDRAGON_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(profileIconId) || profileIconId < 0) return undefined;
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${profileIconId}.png`;
}

function mockMode(): boolean {
  try { return isMockData(); }
  catch { return false; }
}

function formatRank(entry?: RankedEntry): string {
  if (!entry) {
    return "Unranked";
  }

  const totalGames = entry.wins + entry.losses;
  const winRate = totalGames > 0 ? Math.round((entry.wins / totalGames) * 100) : 0;

  return `${entry.tier} ${entry.rank} - ${entry.leaguePoints} LP | ${entry.wins}W ${entry.losses}L (${winRate}%)`;
}

export function buildProfileEmbed(
  riotId: string,
  summoner: Summoner,
  rankedEntries: RankedEntry[],
): EmbedBuilder {
  const soloQueue = rankedEntries.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
  const flexQueue = rankedEntries.find((entry) => entry.queueType === "RANKED_FLEX_SR");

  const mock = mockMode();
  const embed = new EmbedBuilder()
    .setTitle(mock ? `[模拟数据] ${riotId}` : riotId)
    .setColor(0xF0B232)
    .addFields(
      { name: "Summoner Level", value: String(summoner.summonerLevel), inline: true },
      { name: "Solo/Duo", value: formatRank(soloQueue), inline: false },
      { name: "Flex", value: formatRank(flexQueue), inline: false },
    )
    .setFooter({ text: `NA Server • M-Advisor • ${getRiotDataLabel()}` });
  const thumbnail = getProfileIconUrl(summoner.profileIconId);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle(mockMode() ? "模拟数据 - Error" : "Error")
    .setDescription(message);
}
