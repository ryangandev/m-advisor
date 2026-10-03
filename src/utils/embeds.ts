import { EmbedBuilder } from "discord.js";
import type { RankedEntry, Summoner } from "../types";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import type { MatchReport } from "../services/announcementText";
import type { HorseTier } from "../services/horseRanking";

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

const TIER_ICONS: Record<HorseTier, string> = { 特等马: "👑", 上等马: "🐎", 中等马: "🐴", 下等马: "🫏", 没有马: "🪦" };

/** Channel report matching the spoken ranking; names are sanitized by the report builder. */
export function buildHorseReportEmbed(report: MatchReport): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(report.title)
    .setColor(report.mock ? 0x95A5A6 : 0x1C7A6F)
    .setDescription(report.summary)
    .setFooter({ text: report.mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });
  if (report.lines.length > 0) {
    embed.addFields({
      name: "马匹排行",
      value: report.lines.map((line) => `${TIER_ICONS[line.tier]} **${line.tier}** ${line.champion} · ${line.name}${line.tracked ? " (召唤者)" : ""} · ${line.score.toFixed(1)} 分 · ${line.kda}`).join("\n"),
    });
  }
  if (report.praise) embed.addFields({ name: "👑 军师表扬", value: report.praise.slice(0, 1024) });
  if (report.roast) embed.addFields({ name: "🪦 军师批评", value: report.roast.slice(0, 1024) });
  return embed;
}
