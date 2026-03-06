import { EmbedBuilder } from "discord.js";
import { RankedEntry, Summoner } from "../types";

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

  return new EmbedBuilder()
    .setTitle(riotId)
    .setColor(0xF0B232)
    .setThumbnail(
      `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/profileicon/${summoner.profileIconId}.png`,
    )
    .addFields(
      { name: "Summoner Level", value: String(summoner.summonerLevel), inline: true },
      { name: "Solo/Duo", value: formatRank(soloQueue), inline: false },
      { name: "Flex", value: formatRank(flexQueue), inline: false },
    )
    .setFooter({ text: "NA Server • M-Advisor" });
}

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle("Error")
    .setDescription(message);
}
