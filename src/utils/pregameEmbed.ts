import { EmbedBuilder } from "discord.js";
import { formatScore } from "../services/announcementText";
import { COLD_START_LINE, NO_PICK_LINE, OTHER_SIDE_NOTE, isSnowflake, positionLabel } from "../services/pregameBrief";
import type { PregameBrief, PregameLine } from "../services/pregameBrief";
import { TIER_ICONS } from "./stableEmbed";

const TREND_ARROW = { up: "↑", down: "↓", flat: "→" } as const;
const FIELD_LIMIT = 1024;
const DESCRIPTION_LIMIT = 4096;

/** Real Discord user IDs only, once each; anything else could never be a bound member and is dropped. */
const snowflakes = (userIds: readonly string[]): string[] => [...new Set(userIds)].filter(isSnowflake);

/**
 * The only users a pregame message may notify: the bound members the caller names, nobody else.
 * Duplicates collapse, and no role, everyone or reply mention is ever allowed.
 */
export function pregameAllowedMentions(userIds: readonly string[]): { parse: []; roles: []; users: string[]; repliedUser: false } {
  return { parse: [], roles: [], users: snowflakes(userIds), repliedUser: false };
}

/** The message content that carries the mentions, so the members hear about the game. Empty without members. */
export function pregameMentionContent(userIds: readonly string[]): string {
  return snowflakes(userIds).map((id) => `<@${id}>`).join(" ");
}

function teammateLine(line: PregameLine): string {
  const who = `<@${line.memberId}>`;
  if (line.isNew) return `${who} · ${line.champion} · 🆕 新马，军师还没见过，不评`;
  const parts = [who, line.champion, line.recentTiers.map((tier) => TIER_ICONS[tier]).join(" ")];
  if (line.recentAverage !== null) {
    const trend = line.trend && line.previousAverage !== null
      ? ` ${TREND_ARROW[line.trend]}（前5局 ${formatScore(line.previousAverage)}）`
      : "";
    parts.push(`近${line.recentTiers.length}局均 ${formatScore(line.recentAverage)}${trend}`);
  }
  if (line.championRecord) {
    const { games, top, none } = line.championRecord;
    parts.push(`本英雄 ${games} 局：${TIER_ICONS["特等马"]}${top} ${TIER_ICONS["没有马"]}${none}`);
  }
  if (line.position) parts.push(positionLabel(line.position));
  if (line.hotStreak > 0) parts.push(`🔥 连${line.hotStreak}局特等马`);
  if (line.coldStreak > 0) parts.push(`🥶 连${line.coldStreak}局没有马`);
  return parts.join(" · ");
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * The text card of the 军师赛前锦囊. It rates the bound teammates only: strangers appear as a count,
 * enemies not at all, and mock briefs are visibly labeled in the title and the footer.
 */
export function buildPregameEmbed(brief: PregameBrief): EmbedBuilder {
  const strangers = brief.strangerCount > 0 ? `还有 ${brief.strangerCount} 位路人队友` : "没有路人队友";
  const embed = new EmbedBuilder()
    .setTitle(brief.mock ? "模拟数据 · 军师赛前锦囊" : "军师赛前锦囊")
    .setColor(brief.mock ? 0x95A5A6 : 0x1C7A6F)
    .setFooter({ text: [strangers, "对面不评", ...(brief.mock ? ["模拟数据 / Mock data"] : [])].join(" · ") });

  const description = [
    brief.coldStart ? COLD_START_LINE : "",
    ...brief.lines.map(teammateLine),
    brief.otherSideHasFriend ? OTHER_SIDE_NOTE : "",
  ].filter(Boolean).join("\n");
  embed.setDescription(clip(description, DESCRIPTION_LIMIT));

  const picked = brief.pick;
  embed.addFields(
    {
      name: "军师之选",
      value: picked
        ? `<@${picked.memberId}> · ${picked.reason}（近${picked.games}局均 ${formatScore(picked.average)}）`
        : brief.coldStart ? "暂无，军师还没看到谁的底细。" : NO_PICK_LINE,
    },
    { name: "军师指令", value: clip(brief.instruction.text, FIELD_LIMIT) },
  );
  return embed;
}
