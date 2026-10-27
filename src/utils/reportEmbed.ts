import { EmbedBuilder } from "discord.js";
import championNames from "../data/championNamesZh.json";
import { formatScore } from "../services/announcementText";
import { HORSE_TIERS } from "../services/horseRanking";
import type { MemberReport, ReportData } from "../services/reports";
import type { HorseRecord } from "../store/horseRecordStore";
import { PACIFIC_TIME_ZONE } from "./pacificTime";
import { TIER_ICONS } from "./stableEmbed";

/** The mentions of a report never ping anyone: members are shown as `<@id>` and nothing is allowed to notify. */
export const REPORT_ALLOWED_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false } as const;

const FIELD_LIMIT = 1024;
const DESCRIPTION_LIMIT = 4096;

const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: PACIFIC_TIME_ZONE, weekday: "short" });

/** Pacific calendar date as YYYY-MM-DD. */
export function pacificDateLabel(instant: number): string {
  return dateFormat.format(new Date(instant));
}

/** Label of the period: a day with its weekday, or a week from its Monday to its Sunday. */
export function periodLabel(data: Pick<ReportData, "kind" | "range">): string {
  if (data.kind === "day") return `${pacificDateLabel(data.range.start)} ${weekdayFormat.format(new Date(data.range.start))}`;
  return `${pacificDateLabel(data.range.start)} 至 ${pacificDateLabel(data.range.end - 1)}`;
}

function championLabel(record: HorseRecord): string {
  const names = (championNames as { names: Record<string, string> }).names;
  return names[String(record.championId)] ?? record.championName;
}

/** Deterministic, so the same period always reads the same. */
function pick<T>(options: readonly T[], seed: string): T {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return options[(state >>> 0) % options.length];
}

const mention = (member: MemberReport) => `<@${member.discordUserId}>`;
const kda = (record: HorseRecord) => `${record.kills}/${record.deaths}/${record.assists}`;
const tierCounts = (tiers: Record<string, number>) => HORSE_TIERS.map((tier) => `${TIER_ICONS[tier]}${tiers[tier]}`).join(" ");

/** Keeps a field within Discord's limit by dropping whole trailing lines. */
function fit(lines: readonly string[], limit = FIELD_LIMIT): string {
  const kept: string[] = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    const more = lines.length - index - 1;
    const tail = more > 0 ? "\n…" : "";
    if (length + line.length + (kept.length ? 1 : 0) + tail.length > limit) {
      kept.push("…");
      break;
    }
    length += line.length + (kept.length ? 1 : 0);
    kept.push(line);
  }
  return kept.join("\n");
}

function gameLine(label: string, record: HorseRecord): string {
  return `${label}：<@${record.discordUserId}> · ${TIER_ICONS[record.tier]} ${record.tier} · ${championLabel(record)} ${kda(record)} · ${formatScore(record.score)} 分`;
}

function memberLine(member: MemberReport, rank: number | null): string {
  const lead = rank === null ? "▫️" : rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
  return `${lead} ${mention(member)} · ${member.games} 局 ${member.wins} 胜 · 均分 **${formatScore(member.averageScore)}** · ${tierCounts(member.tiers)}`;
}

/** The 军师's line for the period's 特等马. It talks about play only. */
function topRemark(data: ReportData, member: MemberReport): string {
  const when = data.kind === "day" ? "今日" : "本周";
  const detail = `${when} ${member.games} 局均分 ${formatScore(member.averageScore)}，最亮眼的是${championLabel(member.best)}那把 ${kda(member.best)}，拿下 ${formatScore(member.best.score)} 分`;
  const closing = pick(data.kind === "day"
    ? ["这一天的头牌非此马莫属。", "别的马只配看着它的尾灯。", "军师的羽扇都为它摇了三下。"]
    : ["这一周的马厩，它说了算。", "别的马见了都得让道，军师记下一笔。", "一周下来稳稳压着全场，军师服气。"],
  `${data.kind}:${data.range.start}:top:${member.discordUserId}`);
  return `${mention(member)}：${detail}。${closing}`;
}

/** The 军师's line for the period's 没有马. It talks about play only. */
function noneRemark(data: ReportData, member: MemberReport): string {
  const when = data.kind === "day" ? "今日" : "本周";
  const detail = `${when} ${member.games} 局均分只有 ${formatScore(member.averageScore)}，最难看的是${championLabel(member.worst)}那把 ${kda(member.worst)}，只拿 ${formatScore(member.worst.score)} 分`;
  const closing = pick(data.kind === "day"
    ? ["军师建议明天先去训练模式热热身。", "兵法有云，知耻而后勇，明日再战。", "这样的操作，军师看了都替马脸红。"]
    : ["罚抄孙子兵法一遍，下周再看表现。", "这一周的操作，军师建议先跟木桩谈谈心。", "败军之将不言勇，下周请拿出点真功夫。"],
  `${data.kind}:${data.range.start}:none:${member.discordUserId}`);
  return `${mention(member)}：${detail}。${closing}`;
}

/** Why nobody was crowned, so the field never looks broken. */
function noWinnerNote(data: ReportData): string {
  const ranked = data.members.filter((member) => member.qualified);
  if (ranked.length >= 2) return "大家的均分一模一样，军师分不出高下，这次不评。";
  const who = data.kind === "day" ? "今天只有" : `本周满 ${data.minGames} 局的只有`;
  return `${who} ${ranked.length} 位参评，至少要两位才分得出高下，这次不评。`;
}

function summaryLines(data: ReportData): string[] {
  const lines = [`共鉴定 ${data.totalGames} 局：${tierCounts(data.tierTotals)}`];
  const busiest = [...data.members].sort((a, b) => b.games - a.games || a.discordUserId.localeCompare(b.discordUserId))[0];
  if (data.kind === "week" && busiest && data.members.length > 1) lines.push(`出勤最多：${mention(busiest)}（${busiest.games} 局）`);
  const topStreak = [...data.members].sort((a, b) => b.topStreak - a.topStreak || a.discordUserId.localeCompare(b.discordUserId))[0];
  if (data.kind === "week" && topStreak && topStreak.topStreak >= 2) lines.push(`最长连续特等马：${mention(topStreak)} ${topStreak.topStreak} 局`);
  const noneStreak = [...data.members].sort((a, b) => b.noneStreak - a.noneStreak || a.discordUserId.localeCompare(b.discordUserId))[0];
  if (data.kind === "week" && noneStreak && noneStreak.noneStreak >= 2) lines.push(`最长连续没有马：${mention(noneStreak)} ${noneStreak.noneStreak} 局，军师替这匹马捏了把汗`);
  return lines;
}

/** The 军师's closing remark on the whole period. */
function overallRemark(data: ReportData): string {
  const seed = `${data.kind}:${data.range.start}:all`;
  const rate = (tier: (typeof HORSE_TIERS)[number]) => data.tierTotals[tier] / data.totalGames;
  if (data.totalGames < 3) return pick(["才鉴定了几局，军师还看不出成色。", "样本太少，军师的羽扇还没摇起来。"], seed);
  if (rate("没有马") >= 0.4) return pick(["没有马扎堆出现，军师建议全员回营整训。", "马厩里冷清得很，好马都躲起来了。"], seed);
  if (rate("特等马") >= 0.4) return pick(["好马成群，军师脸上有光。", "马厩里群雄并起，军师甚慰。"], seed);
  return pick(["有高光也有翻车，军师继续观察。", "不上不下，稳稳当当，是马厩的常态。"], seed);
}

/** The public 马报 of a period. Mock-mode reports are visibly labeled. `final` is false for a period still running. */
export function buildReportEmbed(data: ReportData, options: { final: boolean }): EmbedBuilder {
  const name = data.kind === "day" ? "每日马报" : "每周马报";
  const label = periodLabel(data);
  const embed = new EmbedBuilder()
    .setTitle(`${data.mock ? "模拟数据 · " : ""}${name} · ${label}${options.final ? "" : "（进行中）"}`)
    .setColor(data.mock ? 0x95A5A6 : 0x1C7A6F)
    .setFooter({ text: `${data.mock ? "模拟数据 / Mock data" : "Riot 实时数据"} • 太平洋时间结算 • 策马军师` });

  if (data.totalGames === 0) {
    return embed.setDescription(`${data.kind === "day" ? "这一天" : "这一周"}还没有任何对局入档，马厩静悄悄的。`);
  }

  const ranked = data.members.filter((member) => member.qualified);
  const unranked = data.members.filter((member) => !member.qualified);
  const board = [
    ...ranked.map((member, index) => memberLine(member, index + 1)),
    ...unranked.map((member) => memberLine(member, null)),
  ];
  const notes: string[] = [];
  if (unranked.length > 0 && data.kind === "week") notes.push(`▫️ 本周不满 ${data.minGames} 局的不参与评选。`);

  embed.setDescription(fit([`共 **${data.totalGames}** 局 · **${data.members.length}** 位出战`, ...notes], DESCRIPTION_LIMIT));
  embed.addFields(
    { name: data.kind === "day" ? "今日战绩" : "本周排行榜（按平均分）", value: fit(board) },
  );
  if (data.topHorse && data.noneHorse) {
    embed.addFields(
      { name: data.kind === "day" ? "👑 今日特等马" : "👑 本周特等马", value: fit([topRemark(data, data.topHorse)]) },
      { name: data.kind === "day" ? "🪦 今日没有马" : "🪦 本周没有马", value: fit([noneRemark(data, data.noneHorse)]) },
    );
  } else {
    embed.addFields({ name: data.kind === "day" ? "今日特等马 / 没有马" : "本周特等马 / 没有马", value: noWinnerNote(data) });
  }
  if (data.bestGame && data.worstGame) {
    embed.addFields({ name: "单局之最", value: fit([gameLine("👑 最佳", data.bestGame), gameLine("🪦 最差", data.worstGame)]) });
  }
  embed.addFields({ name: "军师总评", value: fit([...summaryLines(data), overallRemark(data)]) });
  return embed;
}
