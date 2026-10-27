import { EmbedBuilder } from "discord.js";
import championNames from "../data/championNamesZh.json";
import { DIMENSION_LABELS, MIN_DIMENSION_GAMES, RECENT_FORM_GAMES } from "../services/horseProfile";
import type { HorseProfile } from "../services/horseProfile";
import { HORSE_TIERS } from "../services/horseRanking";
import type { HorseTier } from "../services/horseRanking";
import type { HorseRecord } from "../store/horseRecordStore";

export const TIER_ICONS: Record<HorseTier, string> = { 特等马: "👑", 上等马: "🐎", 中等马: "🐴", 下等马: "🫏", 没有马: "🪦" };

export interface StableView {
  /** Whether the bot is running on mock data; the profile then holds mock records only. */
  mock: boolean;
  memberId: string;
  /** Whether the member is still tracked. History outlives /unbind but no new games are added. */
  tracked: boolean;
  profile: HorseProfile;
  /** Records of the other data mode, so an empty profile can explain where the games went. */
  otherModeGames: number;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const timestamp = (milliseconds: number) => `<t:${Math.floor(milliseconds / 1000)}:R>`;

function championLabel(record: HorseRecord): string {
  const names = (championNames as { names: Record<string, string> }).names;
  return names[String(record.championId)] ?? record.championName;
}

/** Deterministic, so the same profile always reads the same. */
function pick<T>(options: readonly T[], seed: string): T {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return options[(state >>> 0) % options.length];
}

/** The 军师's remark about the profile. It talks about play only. */
function remark(view: StableView): string {
  const { profile } = view;
  const seed = `${view.memberId}:${profile.games}`;
  const top = profile.tiers["特等马"];
  const none = profile.tiers["没有马"];
  if (profile.games < 3) return pick(["才鉴定了几局，军师还看不出这匹马的成色，多打几把再来。", "样本太少，军师的羽扇还没摇起来。"], seed);
  if (profile.streaks.none.current >= 3) {
    return `已经连着${profile.streaks.none.current}局没有马了，军师替你捏了一把汗，下把稳着点。`;
  }
  if (profile.streaks.top.current >= 3) return `连着${profile.streaks.top.current}局特等马，军师的缰绳都快牵不住了。`;
  if (none.count >= 2 && none.rate >= 0.3) {
    const weakest = profile.weakest && profile.weakest.average <= 0.4 ? `${DIMENSION_LABELS[profile.weakest.dimension]}常年垫底，` : "";
    return `没有马率${percent(none.rate)}，${weakest}${pick(["军师建议先去训练模式，跟木桩谈谈心。", "罚你今晚抄写孙子兵法一遍。"], seed)}`;
  }
  if (top.count >= 2 && top.rate >= 0.3) {
    const strongest = profile.strongest && profile.strongest.average >= 0.6 ? `${DIMENSION_LABELS[profile.strongest.dimension]}是看家本领，` : "";
    return `特等马率${percent(top.rate)}，${strongest}${pick(["马厩里的头牌非你莫属。", "别的马见了都得让道。"], seed)}`;
  }
  return pick(["不上不下，稳稳当当，是马厩里的中流砥柱。", "有高光也有翻车，军师继续观察。"], seed);
}

function gameLine(record: HorseRecord): string {
  return [
    `${TIER_ICONS[record.tier]} ${record.tier}`,
    championLabel(record),
    `${record.kills}/${record.deaths}/${record.assists}`,
    `${record.score.toFixed(1)} 分`,
    record.won ? "✅ 胜" : "❌ 负",
    timestamp(record.playedAt),
  ].join(" · ");
}

function dimensionLine(label: string, stat: { dimension: keyof typeof DIMENSION_LABELS; average: number; games: number }): string {
  return `${label}：${DIMENSION_LABELS[stat.dimension]}，平均超过 ${percent(stat.average)} 的同位置玩家（${stat.games} 局）`;
}

/** The public 马厩 profile of one tracked member. Mock-mode profiles are visibly labeled. */
export function buildStableEmbed(view: StableView): EmbedBuilder {
  const { profile, mock } = view;
  const embed = new EmbedBuilder()
    .setTitle(mock ? "模拟数据 · 马厩档案" : "马厩档案 · 策马军师")
    .setColor(mock ? 0x95A5A6 : 0x1C7A6F)
    .setFooter({ text: mock ? "模拟数据 / Mock data • 策马军师" : "Riot 实时数据 • 策马军师" });

  const notes: string[] = [];
  if (!view.tracked) {
    notes.push(profile.games > 0
      ? "ℹ️ 这位已经解除绑定，军师不再记录新对局，旧档案还留在马厩里。管理员可以用 /stable-erase 清除。"
      : "ℹ️ 这位还没有被绑定，军师不替没登记的人记马厩。让管理员用 /bind 绑定后，之后播报的对局才会入档。");
  }
  if (view.otherModeGames > 0) {
    notes.push(mock
      ? `ℹ️ 另有 ${view.otherModeGames} 局真实对局的档案，模拟模式下不显示。`
      : `ℹ️ 另有 ${view.otherModeGames} 局模拟数据的记录，不计入真实档案。`);
  }

  if (profile.games === 0) {
    embed.setDescription([`<@${view.memberId}> 的马厩还是空的。`,
      view.tracked ? "每播报一局对局，军师就会把这位的马匹鉴定记进档案，打完第一把就有了。" : "", ...notes].filter(Boolean).join("\n"));
    return embed;
  }

  const losses = profile.games - profile.wins;
  embed.setDescription([
    `<@${view.memberId}> · 共鉴定 **${profile.games}** 局 · ${profile.wins} 胜 ${losses} 负 · 平均 **${profile.averageScore!.toFixed(1)}** 分`,
    ...notes,
  ].join("\n"));
  embed.addFields(
    {
      name: "马匹分布",
      value: HORSE_TIERS.map((tier) => `${TIER_ICONS[tier]} ${tier} ${profile.tiers[tier].count} 次 (${percent(profile.tiers[tier].rate)})`).join("\n"),
    },
    {
      name: "连续纪录",
      value: [
        `👑 特等马：当前连续 ${profile.streaks.top.current} 局，最长 ${profile.streaks.top.best} 局`,
        `🪦 没有马：当前连续 ${profile.streaks.none.current} 局，最长 ${profile.streaks.none.best} 局`,
      ].join("\n"),
    },
    {
      name: `近 ${Math.min(profile.games, RECENT_FORM_GAMES)} 局（新到旧）`,
      value: profile.recentForm.map((tier) => TIER_ICONS[tier]).join(" "),
    },
    {
      name: "强弱项",
      value: profile.strongest && profile.weakest
        ? [dimensionLine("最强", profile.strongest), dimensionLine("最弱", profile.weakest)].join("\n")
        : `局数还不够，每个维度至少要 ${MIN_DIMENSION_GAMES} 局才能分出强弱。`,
    },
    { name: "军师批注", value: remark(view) },
    { name: `最近 ${profile.recent.length} 局`, value: profile.recent.map(gameLine).join("\n").slice(0, 1024) },
  );
  return embed;
}
