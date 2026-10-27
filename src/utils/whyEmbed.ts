import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { formatScore } from "../services/announcementText";
import { DIMENSION_LABELS } from "../services/horseProfile";
import { appealRuling, dimensionEvidence, everyItem, formatGap, verdictSummary } from "../services/horseVerdict";
import type { DimensionImpact, Verdict } from "../services/horseVerdict";
import type { HorseRecord } from "../store/horseRecordStore";
import { TIER_ICONS } from "./stableEmbed";
import { TIER_COLORS } from "./whyRadar";

/** Buttons whose custom ID starts with this prefix and a colon are appeals; the interaction handler routes them here. */
export const APPEAL_PREFIX = "why-appeal";
export const RADAR_FILE_NAME = "why-verdict.png";
/** Discord's limit for a component custom ID. */
const CUSTOM_ID_LIMIT = 100;
const APPEAL_ID = /^why-appeal:([mr]):([\w-]{1,32}):([A-Za-z0-9_-]{1,40})$/;
const MOCK_FOOTER = "模拟数据 / Mock data • 策马军师";
const MOCK_COLOR = 0x95A5A6;

const percent = (value: number) => `${Math.round(value * 100)}%`;
const timestamp = (milliseconds: number) => `<t:${Math.floor(milliseconds / 1000)}:R>`;
const hexColor = (color: string) => Number.parseInt(color.slice(1), 16);

export interface AppealTarget {
  mock: boolean;
  memberId: string;
  matchId: string;
}

/** The appeal button names the match, the member and the data kind, so nothing has to be stored to answer it. */
export function appealCustomId(record: Pick<HorseRecord, "mock" | "discordUserId" | "matchId">): string | null {
  const id = `${APPEAL_PREFIX}:${record.mock ? "m" : "r"}:${record.discordUserId}:${record.matchId}`;
  return id.length <= CUSTOM_ID_LIMIT && APPEAL_ID.test(id) ? id : null;
}

export function parseAppealCustomId(customId: string): AppealTarget | null {
  const match = APPEAL_ID.exec(customId);
  return match ? { mock: match[1] === "m", memberId: match[2], matchId: match[3] } : null;
}

/** The 上诉 button, or a disabled 本案已结 once the member has appealed. Null when the IDs do not fit a custom ID. */
export function buildAppealRow(record: HorseRecord, closed: boolean): ActionRowBuilder<ButtonBuilder> | null {
  const customId = appealCustomId(record);
  if (!customId) return null;
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setEmoji("⚖️")
    .setLabel(closed ? "本案已结 · 维持原判" : "上诉")
    .setDisabled(closed);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function dragLine(verdict: Verdict, entry: DimensionImpact): string {
  const evidence = dimensionEvidence(entry.dimension, verdict.record);
  return [
    `**${DIMENSION_LABELS[entry.dimension]}** 超过 ${percent(entry.percentile)} 的同位置玩家`,
    `占这局${verdict.positionLabel}评分 ${percent(entry.share)}`,
    ...evidence,
  ].join(" · ");
}

function gapLines(verdict: Verdict): string[] {
  const { above, below } = verdict;
  return [
    above
      ? `⬆️ 离上一名${above.sameTier ? "" : `（${above.tier}）`}差 **${formatGap(above.gap)}** 分${above.close ? "，惜败" : ""}`
      : "⬆️ 队内第一，上面没有更高的档位了",
    below
      ? `⬇️ 领先下一名${below.sameTier ? "" : `（${below.tier}）`}**${formatGap(below.gap)}** 分${below.close ? "，险胜" : ""}`
      : "⬇️ 队内最后一名，后面没有退路了",
  ];
}

export interface WhyView {
  verdict: Verdict;
  /** Whether the caller is the member, so the summary can say 你 instead of naming them. */
  self: boolean;
  /** Champion name as shown to players. */
  champion: string;
  /** Whether the radar is attached; false when rendering it failed, so the verdict still goes out. */
  image: boolean;
}

/** The public 判决书. The radar is attached as RADAR_FILE_NAME. Mock verdicts are visibly labeled. */
export function buildWhyEmbed(view: WhyView): EmbedBuilder {
  const { verdict } = view;
  const { record } = verdict;
  const embed = new EmbedBuilder()
    .setTitle(record.mock ? "模拟数据 · 判决书" : "判决书 · 策马军师")
    .setColor(record.mock ? MOCK_COLOR : hexColor(TIER_COLORS[record.tier]))
    .setDescription([
      `<@${record.discordUserId}> · ${view.champion} · ${verdict.positionLabel} · ${record.won ? "胜" : "负"} · ${timestamp(record.playedAt)}`,
      `${TIER_ICONS[record.tier]} **${record.tier}** · **${formatScore(record.score)}** 分 · 队内第 ${record.teamRank}/${record.teamSize}`,
    ].join("\n"))
    .setFooter({ text: record.mock ? MOCK_FOOTER : `对局 ${record.matchId} • 策马军师` });

  if (view.image) embed.setImage(`attachment://${RADAR_FILE_NAME}`);

  const reasons = verdict.drags.length > 0
    ? verdict.drags.map((entry) => dragLine(verdict, entry))
    : [`${everyItem(verdict)}都不低于同位置中位数。`];
  if (verdict.best) {
    reasons.push(`亮点：**${DIMENSION_LABELS[verdict.best.dimension]}** 超过 ${percent(verdict.best.percentile)} 的同位置玩家`);
  }
  embed.addFields(
    { name: verdict.drags.length > 0 ? "拖后腿的维度" : "判决依据", value: reasons.join("\n").slice(0, 1024) },
    { name: "离上下一档", value: gapLines(verdict).join("\n") },
  );
  if (record.commentary) {
    embed.addFields({ name: record.commentaryTone === "praise" ? "播报时的夸奖" : "播报时的吐槽", value: `> ${record.commentary}`.slice(0, 1024) });
  }
  embed.addFields({ name: "军师判词", value: verdictSummary(verdict, view.self) });
  return embed;
}

export interface WhyEmptyView {
  mock: boolean;
  memberId: string;
  tracked: boolean;
  /** The match the caller asked for, when it was not found. */
  matchId: string | null;
  /** Records of the other data mode, so an empty answer can explain where the games went. */
  otherModeGames: number;
}

/** Why there is no verdict to show. */
export function buildWhyEmptyEmbed(view: WhyEmptyView): EmbedBuilder {
  const lines: string[] = [];
  if (view.matchId) {
    lines.push(`<@${view.memberId}> 的马厩里没有 ${view.matchId} 这一局${view.mock ? "的模拟记录" : ""}。`, "从 match 选项的候选列表里挑一局，或者不填，默认看最近一局。");
  } else {
    lines.push(`<@${view.memberId}> 还没有可以宣判的对局。`);
    lines.push(view.tracked
      ? "每播报一局对局，军师就会记一笔，打完第一把再来问为什么。"
      : "这位还没有被绑定，军师不替没登记的人判案。让管理员用 /bind 绑定后，之后播报的对局才会入档。");
  }
  if (view.otherModeGames > 0) {
    lines.push(view.mock
      ? `ℹ️ 另有 ${view.otherModeGames} 局真实对局的档案，模拟模式下不显示。`
      : `ℹ️ 另有 ${view.otherModeGames} 局模拟数据的记录，不计入真实档案。`);
  }
  return new EmbedBuilder()
    .setTitle(view.mock ? "模拟数据 · 判决书" : "判决书 · 策马军师")
    .setColor(view.mock ? MOCK_COLOR : 0x1C7A6F)
    .setDescription(lines.join("\n"))
    .setFooter({ text: view.mock ? MOCK_FOOTER : "马厩档案 • 策马军师" });
}

/** The public ruling on an appeal: always 维持原判. */
export function buildAppealEmbed(verdict: Verdict): EmbedBuilder {
  const { record } = verdict;
  return new EmbedBuilder()
    .setTitle(record.mock ? "模拟数据 · 上诉裁定 · 维持原判" : "上诉裁定 · 维持原判")
    .setColor(record.mock ? MOCK_COLOR : hexColor(TIER_COLORS[record.tier]))
    .setDescription(appealRuling(verdict))
    .setFooter({ text: record.mock ? MOCK_FOOTER : `对局 ${record.matchId} • 策马军师` });
}
