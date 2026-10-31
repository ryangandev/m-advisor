import { EmbedBuilder } from "discord.js";
import { formatScore } from "../services/announcementText";
import { HORSE_TIERS } from "../services/horseRanking";
import { RELATIVE_BOTTOM_AVERAGE, isRelativeBottom, printedAverage } from "../services/reports";
import type { MemberReport, ReportData } from "../services/reports";
import type { HorseRecord } from "../store/horseRecordStore";
import { PACIFIC_TIME_ZONE } from "./pacificTime";
import { TIER_ICONS, championLabel } from "./stableEmbed";

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

/**
 * How the text refers to the period. A finished period is never called "today" or "this week": the 00:30 post covers the
 * day before, and a catch-up post can be older still, so it says 当日 / 当周 and the title carries the date.
 */
function whenWord(data: ReportData, final: boolean): string {
  if (data.kind === "day") return final ? "当日" : "今日";
  return final ? "当周" : "本周";
}

const mentions = (members: readonly MemberReport[]) => members.map(mention).join("、");

/** The 军师's line for the period's 特等马, or for several who share the best average. It talks about play only. */
function topRemark(data: ReportData, members: readonly MemberReport[], final: boolean): string {
  const when = whenWord(data, final);
  const seed = `${data.kind}:${data.range.start}:top:${members.map((member) => member.discordUserId).join(",")}`;
  if (members.length > 1) {
    // 双雄 means exactly two, so a bigger tie only gets the closing that fits any number.
    const closing = members.length === 2
      ? pick(["并驾齐驱，军师一碗水端平。", "谁也不让谁，马厩里难得的双雄并立。"], seed)
      : "并驾齐驱，军师一碗水端平。";
    return `${mentions(members)} 并列：${when}各自均分都是 ${formatScore(members[0].averageScore)}。${closing}`;
  }
  const member = members[0];
  const detail = `${when} ${member.games} 局均分 ${formatScore(member.averageScore)}，${member.games === 1 ? `那一把是${championLabel(member.best)}` : `最亮眼的是${championLabel(member.best)}那把`} ${kda(member.best)}，拿下 ${formatScore(member.best.score)} 分`;
  const closing = pick(data.kind === "day"
    ? ["这一天的头牌非此马莫属。", "别的马只配看着它的尾灯。", "军师的羽扇都为它摇了三下。"]
    : ["这一周的马厩，它说了算。", "别的马见了都得让道，军师记下一笔。", "一周下来稳稳压着全场，军师服气。"], seed);
  return `${mention(member)}：${detail}。${closing}`;
}

/**
 * The soft line for a last place that is only relative: the average is still a good one, or the worst game was a
 * 特等马 or 上等马. It mirrors the 车队内战's 相对背锅 and, like every line here, talks about play only.
 */
function relativeBottomRemark(data: ReportData, members: readonly MemberReport[], final: boolean, seed: string): string {
  const when = whenWord(data, final);
  // Score-based praise only when the printed average really is a good one; otherwise only the rank in the party is talked about.
  const goodScores = members.every((member) => printedAverage(member) >= RELATIVE_BOTTOM_AVERAGE);
  if (members.length > 1) {
    const closing = pick(goodScores
      ? ["水准都不低，只是车队里有人更强，别往心里去。", "这个垫底只是相对的，军师的羽扇没有摇头。"]
      : ["队内排名不差，只是车队里有人更强，别往心里去。", "这个垫底只是相对的，军师的羽扇没有摇头。"], seed);
    return `${mentions(members)} 并列相对垫底：${when}各自均分都是 ${formatScore(members[0].averageScore)}。${closing}`;
  }
  const member = members[0];
  const lowest = member.games === 1 ? `那一把是${championLabel(member.worst)}` : `最低的是${championLabel(member.worst)}那把`;
  const detail = `${when} ${member.games} 局均分 ${formatScore(member.averageScore)}，在车队里排最后，${lowest} ${kda(member.worst)}，${formatScore(member.worst.score)} 分`;
  const closing = pick(goodScores
    ? [
      "其实打得不差，只是车队里有人更强，这口锅只是相对的。",
      "分数不低，只是在车队里排最后，相对垫底，别往心里去。",
      "军师不扣分，下把和大家一起再往上走一步。",
    ]
    : [
      "队内排名不差，只是车队里有人更强，这口锅只是相对的。",
      "只是在车队里排最后，相对垫底，别往心里去。",
      "军师不扣分，下把和大家一起再往上走一步。",
    ], seed);
  return `${mention(member)}：${detail}。${closing}`;
}

/** The 军师's line for the period's 没有马, or for several who share the worst average. It talks about play only. */
function noneRemark(data: ReportData, members: readonly MemberReport[], final: boolean): string {
  const when = whenWord(data, final);
  const seed = `${data.kind}:${data.range.start}:none:${members.map((member) => member.discordUserId).join(",")}`;
  if (members.every(isRelativeBottom)) return relativeBottomRemark(data, members, final, seed);
  if (members.length > 1) {
    const closing = pick(["难兄难弟，军师建议结伴去训练模式。", "一起罚抄孙子兵法，抄完再战。"], seed);
    return `${mentions(members)} 并列：${when}各自均分都只有 ${formatScore(members[0].averageScore)}。${closing}`;
  }
  const member = members[0];
  const detail = `${when} ${member.games} 局均分只有 ${formatScore(member.averageScore)}，${member.games === 1 ? `那一把是${championLabel(member.worst)}` : `最难看的是${championLabel(member.worst)}那把`} ${kda(member.worst)}，只拿 ${formatScore(member.worst.score)} 分`;
  const closing = pick(data.kind === "day"
    ? ["军师建议先去训练模式热热身。", "兵法有云，知耻而后勇。", "这样的操作，军师看了都替马脸红。"]
    : ["罚抄孙子兵法一遍，军师等着看长进。", "这一周的操作，军师建议先跟木桩谈谈心。", "败军之将不言勇，请拿出点真功夫。"], seed);
  return `${mention(member)}：${detail}。${closing}`;
}

/** Why nobody was crowned, so the field never looks broken. */
function noWinnerNote(data: ReportData, final: boolean): string {
  const ranked = data.members.filter((member) => member.qualified);
  if (ranked.length >= 2) return "大家的均分一模一样，军师分不出高下，这次不评。";
  const when = whenWord(data, final);
  if (ranked.length === 0) return `${when}还没有人满 ${data.minGames} 局，这次不评。`;
  const who = data.kind === "day" ? `${when}只有` : `${when}满 ${data.minGames} 局的只有`;
  return `${who} ${ranked.length} 位参评，至少要两位才分得出高下，这次不评。`;
}

/** Everyone who holds the highest value of a count, or nobody when it is below `minimum` or the whole field shares it. */
function leaders(data: ReportData, value: (member: MemberReport) => number, minimum: number, skipWhenAllShare: boolean): { members: MemberReport[]; value: number } | null {
  const best = Math.max(0, ...data.members.map(value));
  if (best < minimum) return null;
  const members = data.members.filter((member) => value(member) === best);
  if (skipWhenAllShare && members.length === data.members.length) return null;
  return { members, value: best };
}

/** How many horses were appraised: one per member per match, so a shared match adds one for each friend. */
function appraisalCount(data: ReportData): number {
  return HORSE_TIERS.reduce((sum, tier) => sum + data.tierTotals[tier], 0);
}

function summaryLines(data: ReportData): string[] {
  // The tier totals count horses, one per member per match, so this line says 匹 and leaves 局 to the distinct games.
  const lines = [`共鉴定 ${appraisalCount(data)} 匹马：${tierCounts(data.tierTotals)}`];
  if (data.kind !== "week") return lines;
  const busiest = leaders(data, (member) => member.games, 1, true);
  if (busiest) lines.push(`出勤最多：${mentions(busiest.members)}（${busiest.value} 局）`);
  const topStreak = leaders(data, (member) => member.topStreak, 2, false);
  if (topStreak) lines.push(`最长连续特等马：${mentions(topStreak.members)} ${topStreak.value} 局`);
  const noneStreak = leaders(data, (member) => member.noneStreak, 2, false);
  if (noneStreak) lines.push(`最长连续没有马：${mentions(noneStreak.members)} ${noneStreak.value} 局，军师替这${noneStreak.members.length > 1 ? "几" : ""}匹马捏了把汗`);
  return lines;
}

/** The 军师's closing remark on the whole period. */
function overallRemark(data: ReportData): string {
  const seed = `${data.kind}:${data.range.start}:all`;
  // The sample bar counts distinct games, so a match shared by three friends is one game and not three; the tier
  // rates read the horses themselves, which is what the remarks talk about.
  const rate = (tier: (typeof HORSE_TIERS)[number]) => data.tierTotals[tier] / appraisalCount(data);
  if (data.totalGames < 3) return pick(["才鉴定了几局，军师还看不出成色。", "样本太少，军师的羽扇还没摇起来。"], seed);
  if (rate("没有马") >= 0.4) return pick(["没有马扎堆出现，军师建议全员回营整训。", "马厩里冷清得很，好马都躲起来了。"], seed);
  if (rate("特等马") >= 0.4) return pick(["好马成群，军师脸上有光。", "马厩里群雄并起，军师甚慰。"], seed);
  return pick(["有高光也有翻车，军师继续观察。", "不上不下，稳稳当当，是马厩的常态。"], seed);
}

/**
 * The public 马报 of a period. Mock-mode reports are visibly labeled.
 * `final` is false for a period still running; a finished one is worded as that period, never as "today" or "this week".
 */
export function buildReportEmbed(data: ReportData, options: { final: boolean }): EmbedBuilder {
  const name = data.kind === "day" ? "每日马报" : "每周马报";
  const label = periodLabel(data);
  const when = whenWord(data, options.final);
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
    // Members whose printed averages are equal share the same place, as with 并列: 1, 1, 3.
    ...ranked.map((member) => memberLine(member, 1 + ranked.filter((other) => printedAverage(other) > printedAverage(member)).length)),
    ...unranked.map((member) => memberLine(member, null)),
  ];
  const notes: string[] = [];
  if (unranked.length > 0 && data.kind === "week") notes.push(`▫️ ${when}不满 ${data.minGames} 局的不参与评选。`);

  embed.setDescription(fit([`共 **${data.totalGames}** 局 · **${data.members.length}** 位出战`, ...notes], DESCRIPTION_LIMIT));
  embed.addFields({ name: data.kind === "day" ? `${when}战绩` : `${when}排行榜（按平均分）`, value: fit(board) });
  if (data.topHorses.length > 0 && data.noneHorses.length > 0) {
    embed.addFields(
      { name: `👑 ${when}特等马`, value: fit([topRemark(data, data.topHorses, options.final)]) },
      data.noneHorses.every(isRelativeBottom)
        ? { name: `🐢 ${when}垫底（相对）`, value: fit([noneRemark(data, data.noneHorses, options.final)]) }
        : { name: `🪦 ${when}没有马`, value: fit([noneRemark(data, data.noneHorses, options.final)]) },
    );
  } else {
    embed.addFields({ name: `${when}特等马 / 没有马`, value: noWinnerNote(data, options.final) });
  }
  if (data.bestGame && data.worstGame) {
    // With a single game the best and the worst are the same record, which is listed once.
    const only = data.bestGame.discordUserId === data.worstGame.discordUserId && data.bestGame.matchId === data.worstGame.matchId;
    embed.addFields({
      name: "单局之最",
      value: fit(only ? [gameLine("唯一一局", data.bestGame)] : [gameLine("👑 最佳", data.bestGame), gameLine("🪦 最差", data.worstGame)]),
    });
  }
  embed.addFields({ name: "军师总评", value: fit([...summaryLines(data), overallRemark(data)]) });
  return embed;
}
