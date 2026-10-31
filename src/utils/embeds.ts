import { EmbedBuilder } from "discord.js";
import type { MatchDetail, RankedEntry, Summoner } from "../types";
import { getRiotDataLabel, isMockData } from "../services/riotData";
import { championLabel, type MatchReport } from "../services/announcementText";
import type { HorseTier } from "../services/horseRanking";
import type { PartyEntry, PartyRanking } from "../services/partyRanking";
import type { MonitorStatus } from "../services/gameMonitor";
import { RECAP_FIELD_NAME } from "../services/pregameRecap";
import { RANK_ANNOUNCEMENT_TITLE, RANK_FIELD_NAME } from "../services/rankText";
import { isAnnouncedQueue } from "./riotMatchApi";
import { isApex } from "../services/rankMath";

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

  // Riot sends division I for MASTER, GRANDMASTER and CHALLENGER, which have no divisions.
  const tier = isApex(entry.tier) ? entry.tier : `${entry.tier} ${entry.rank}`;
  return `${tier} - ${entry.leaguePoints} LP | ${entry.wins}W ${entry.losses}L (${winRate}%)`;
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

/** For command replies that show member mentions without notifying anyone. */
export const NO_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false } as const;

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle(mockMode() ? "模拟数据 - Error" : "Error")
    .setDescription(message);
}

const TIER_ICONS: Record<HorseTier, string> = { 特等马: "👑", 上等马: "🐎", 中等马: "🐴", 下等马: "🫏", 没有马: "🪦" };

/**
 * Channel report matching the spoken ranking; names are sanitized by the report builder.
 * The optional `recap` is the 锦囊回顾 of the pregame pick, and `rankRows` the 段位变化 of the reported team's bound
 * members: both text only, never part of the speech.
 */
export function buildHorseReportEmbed(report: MatchReport, recap?: string, rankRows: readonly string[] = []): EmbedBuilder {
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
  if (recap) embed.addFields({ name: RECAP_FIELD_NAME, value: recap.slice(0, 1024) });
  if (rankRows.length > 0) embed.addFields({ name: RANK_FIELD_NAME, value: rankRows.join("\n").slice(0, 1024) });
  return embed;
}

/**
 * The 车队内战 embed, sent right after the report: the bound friends of one team ranked among themselves.
 * Members appear as mentions, which an embed never pings, so the message's allowedMentions stay what the report pings.
 */
export function buildPartyEmbed(party: PartyRanking): EmbedBuilder {
  const person = (entry: PartyEntry) => `<@${entry.memberId}> · ${entry.champion} · ${entry.tier} · ${entry.score.toFixed(1)} 分`;
  const row = (entry: PartyEntry, index: number) =>
    `${index + 1}. ${TIER_ICONS[entry.tier]} <@${entry.memberId}> · ${entry.champion} · **${entry.tier}** · ${entry.score.toFixed(1)} 分 · 队内第 ${entry.teamRank}/${entry.teamSize}`;
  const people = (entries: readonly PartyEntry[], line: string) => `${entries.map(person).join("\n")}\n军师：${line}`;
  const verdict: Array<{ name: string; value: string }> = [];
  if (party.tiedAll) {
    verdict.push({ name: "🤝 车队并列", value: people(party.entries, party.bestLine) });
  } else {
    const lead = party.modest ? " (相对)" : "";
    verdict.push({ name: party.best.length > 1 ? `👑 车队 MVP 并列${lead}` : `👑 车队 MVP${lead}`, value: people(party.best, party.bestLine) });
    verdict.push(party.worst.length > 1
      ? { name: "🤝 垫底并列 (无人背锅)", value: people(party.worst, party.worstLine) }
      : { name: party.relative ? "🍳 本局背锅 (相对)" : "🍳 本局背锅", value: people(party.worst, party.worstLine) });
  }
  return new EmbedBuilder()
    .setTitle(`${party.mock ? "模拟战报 · " : ""}车队内战`)
    .setColor(party.mock ? 0x95A5A6 : 0xB8651B)
    .setDescription(`本局 ${party.entries.length} 位车队成员同队开黑，只在车队内部排名，对面不计分。`)
    .addFields({ name: "车队内部排名", value: party.entries.map(row).join("\n") }, ...verdict)
    .setFooter({ text: party.mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });
}

/**
 * The separate 段位播报 message about promotions and demotions, one line per announced member (see rankMoveText).
 * Members are mentions inside the embed, which notifies nobody.
 */
export function buildRankAnnouncementEmbed(lines: readonly string[], mock: boolean): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${mock ? "模拟数据 · " : ""}${RANK_ANNOUNCEMENT_TITLE}`)
    .setColor(mock ? 0x95A5A6 : 0xC9A227)
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });
}

const QUEUE_NAMES: Readonly<Record<number, string>> = {
  400: "征召匹配", 420: "单双排", 430: "盲选匹配", 440: "灵活组排", 450: "大乱斗", 480: "极速匹配", 490: "快速匹配",
  700: "冠军杯", 900: "无限乱斗", 1700: "斗魂竞技场", 1900: "无限火力",
};

export interface RecentAccountView {
  /** The owning member's place in the server's bind order, from 1; it prefixes the account's field. */
  memberOrder: number;
  riotId: string;
  puuid: string;
  /** The monitor's starting point or last announced match for this account, while monitoring. */
  lastMatchId?: string;
  matches: Array<{ matchId: string; detail: MatchDetail }>;
  /** Replaces the match list, for example for a skipped mock account or a Riot error. */
  notice?: string;
}

export interface RecentMemberView {
  memberId: string;
  /** The member's place in the server's bind order, from 1. */
  order: number;
  /** The member's current voice channel, or null when they are not in voice. */
  voiceChannelId: string | null;
  /** Whether the monitoring session currently covers this member. */
  monitored: boolean;
}

export interface RecentMatchesView {
  mock: boolean;
  /** The members shown, in bind order: the whole server, or the one member asked for. */
  members: RecentMemberView[];
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
    lines.push(`🟢 正在监听 · 每 ${view.pollIntervalSeconds} 秒检查一次 · `
      + (status.lastPollAt ? `上次检查 ${timestamp(status.lastPollAt)}` : "正在记录监听起点"));
  } else if (view.members.some((member) => member.voiceChannelId)) {
    lines.push("⚪ 没在监听：有成员在语音频道里，但监听已停止。修好下面的错误后重启机器人，或重新进入语音频道。");
  } else {
    lines.push("⚪ 没在监听：没有被追踪成员在语音频道。进入语音频道后才开始监听，之前结束的对局不会补播。");
  }
  for (const member of view.members) {
    lines.push(`${member.order}. <@${member.memberId}> · ${member.voiceChannelId ? `<#${member.voiceChannelId}>` : "不在语音"} · `
      + (member.monitored ? "监听中" : "未监听"));
  }
  if (status.lastError) lines.push(`⚠️ 上次错误 ${timestamp(status.lastError.at)}：${status.lastError.message.slice(0, 300)}`);
  if (status.active) lines.push("📍 监听起点之后结束的召唤师峡谷对局会被播报。");

  const embed = new EmbedBuilder()
    .setTitle(view.mock ? "模拟数据 · 最近对局" : "最近对局 · 策马军师")
    .setColor(view.mock ? 0x95A5A6 : 0x1C7A6F)
    .setDescription(lines.join("\n"))
    .setFooter({ text: view.mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });
  // Discord allows 25 fields in an embed, counted across every member's accounts.
  const fields = view.accounts.slice(0, 25).map((account) => ({
    name: `${account.memberOrder}. ${account.riotId}`.slice(0, 256),
    rows: account.notice ? [account.notice]
      : account.matches.length === 0 ? ["没有对局记录。"]
        : account.matches.map((_, index) => recentMatchLine(account, index, view)),
  }));
  // Discord also caps the whole embed at 6000 characters, so every field gets an even share of what the rest leaves.
  const json = embed.toJSON();
  const fixed = (json.title?.length ?? 0) + (json.description?.length ?? 0) + (json.footer?.text.length ?? 0)
    + fields.reduce((total, field) => total + field.name.length, 0);
  const share = Math.min(FIELD_VALUE_LIMIT, Math.floor((EMBED_TOTAL_LIMIT - fixed) / Math.max(1, fields.length)));
  for (const field of fields) embed.addFields({ name: field.name, value: fitRows(field.rows, share) });
  return embed;
}

const FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;
const MORE_ROWS = "…";

/** The rows that fit in `limit` characters, newest first, with a marker when some are dropped; the newest row always stays. */
function fitRows(rows: readonly string[], limit: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const [index, row] of rows.entries()) {
    const added = (kept.length > 0 ? 1 : 0) + row.length;
    // Room for "\n…" is kept unless this is the last row.
    const reserve = index < rows.length - 1 ? 1 + MORE_ROWS.length : 0;
    if (length + added + reserve > limit) break;
    kept.push(row);
    length += added;
  }
  if (kept.length === rows.length) return kept.join("\n");
  if (kept.length === 0) {
    // Even the newest row is too long for the share: shorten it rather than drop it.
    const room = Math.max(1, limit - 1 - MORE_ROWS.length);
    return `${rows[0].slice(0, room)}\n${MORE_ROWS}`.slice(0, FIELD_VALUE_LIMIT);
  }
  return `${kept.join("\n")}\n${MORE_ROWS}`;
}
