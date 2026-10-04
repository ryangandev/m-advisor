import { EmbedBuilder } from "discord.js";
import type { MatchDetail, RankedEntry, Summoner } from "../types";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import { championLabel, type MatchReport } from "../services/announcementText";
import type { HorseTier } from "../services/horseRanking";
import type { MonitorStatus } from "../services/gameMonitor";
import { isAnnouncedQueue } from "./riotMatchApi";

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

const QUEUE_NAMES: Readonly<Record<number, string>> = {
  400: "征召匹配", 420: "单双排", 430: "盲选匹配", 440: "灵活组排", 450: "大乱斗", 480: "极速匹配", 490: "快速匹配",
  700: "冠军杯", 900: "无限乱斗", 1700: "斗魂竞技场", 1900: "无限火力",
};

export interface RecentAccountView {
  riotId: string;
  puuid: string;
  /** The monitor's starting point or last announced match for this account, while monitoring. */
  lastMatchId?: string;
  matches: Array<{ matchId: string; detail: MatchDetail }>;
  /** Replaces the match list, for example for a skipped mock account or a Riot error. */
  notice?: string;
}

export interface RecentMatchesView {
  mock: boolean;
  memberId: string;
  /** The tracked member's current voice channel. */
  voiceChannelId: string | null;
  pollIntervalSeconds: number;
  status: MonitorStatus;
  accounts: RecentAccountView[];
}

const timestamp = (milliseconds: number) => `<t:${Math.floor(milliseconds / 1000)}:R>`;

function recentMatchLine(account: RecentAccountView, index: number, view: RecentMatchesView): string {
  const { matchId, detail } = account.matches[index];
  const player = detail.info.participants.find((participant) => participant.puuid === account.puuid);
  const result = detail.info.aborted ? "⏹️ 中止" : detail.info.earlySurrender ? "↩️ 重开" : player?.win ? "✅ 胜" : "❌ 负";
  const parts = [
    result,
    player ? `${championLabel(player)} ${player.kills}/${player.deaths}/${player.assists}` : "未找到该玩家",
    QUEUE_NAMES[detail.info.queueId] ?? `队列 ${detail.info.queueId}`,
    `${Math.round(detail.info.gameDuration / 60)} 分钟`,
  ];
  if (detail.info.gameEndTimestamp !== null) parts.push(timestamp(detail.info.gameEndTimestamp));
  const lastIndex = account.lastMatchId ? account.matches.findIndex((match) => match.matchId === account.lastMatchId) : -1;
  if (!isAnnouncedQueue(detail.info.queueId)) parts.push("不播报此模式");
  else if (view.status.announced.has(matchId)) parts.push("📢 已播报");
  else if (matchId === account.lastMatchId) parts.push("📍 监听起点");
  // A newer match than the monitor's last one is announced on the next check.
  else if (account.lastMatchId && (lastIndex === -1 || index < lastIndex)) parts.push("⏳ 下次检查时播报");
  return parts.join(" · ");
}

/** Recent matches of every bound account plus the monitor's state, for diagnosing a missed announcement. */
export function buildRecentMatchesEmbed(view: RecentMatchesView): EmbedBuilder {
  const { status } = view;
  const lines: string[] = [];
  if (status.active) {
    lines.push(`🟢 正在监听 <@${view.memberId}>${view.voiceChannelId ? ` · <#${view.voiceChannelId}>` : ""} · 每 ${view.pollIntervalSeconds} 秒检查一次 · `
      + (status.lastPollAt ? `上次检查 ${timestamp(status.lastPollAt)}` : "正在记录监听起点"));
  } else if (view.voiceChannelId) {
    lines.push(`⚪ 没在监听：<@${view.memberId}> 在语音频道里，但监听已停止。修好下面的错误后重启机器人，或重新进入语音频道。`);
  } else {
    lines.push(`⚪ 没在监听：<@${view.memberId}> 不在语音频道。进入语音频道后才开始监听，之前结束的对局不会补播。`);
  }
  if (status.lastError) lines.push(`⚠️ 上次错误 ${timestamp(status.lastError.at)}：${status.lastError.message.slice(0, 300)}`);
  if (status.active) lines.push("📍 监听起点之后结束的召唤师峡谷对局会被播报。");

  const embed = new EmbedBuilder()
    .setTitle(view.mock ? "模拟数据 · 最近对局" : "最近对局 · 策马军师")
    .setColor(view.mock ? 0x95A5A6 : 0x1C7A6F)
    .setDescription(lines.join("\n"))
    .setFooter({ text: view.mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });
  for (const account of view.accounts.slice(0, 25)) {
    const rows = account.notice ? [account.notice]
      : account.matches.length === 0 ? ["没有对局记录。"]
        : account.matches.map((_, index) => recentMatchLine(account, index, view));
    let value = "";
    for (const row of rows) {
      if (value.length + row.length + 1 > 1024) break;
      value += `${value ? "\n" : ""}${row}`;
    }
    embed.addFields({ name: account.riotId.slice(0, 256), value: value || rows[0].slice(0, 1024) });
  }
  return embed;
}
