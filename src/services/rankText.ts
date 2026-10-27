import type { RankedEntry } from "../types";
import type { RankRow } from "./rankTracker";

/**
 * Chinese names for league-v4 ranks and queues. rankMath.ts keeps Riot's enums; every display name lives here.
 * Ryan's decision (2026-10-27): `黄金 II` in text and `黄金二` in voice, and flex is shown as 灵活组排.
 */
const TIER_NAMES: Readonly<Record<string, string>> = {
  IRON: "黑铁",
  BRONZE: "青铜",
  SILVER: "白银",
  GOLD: "黄金",
  PLATINUM: "铂金",
  EMERALD: "翡翠",
  DIAMOND: "钻石",
  MASTER: "大师",
  GRANDMASTER: "宗师",
  CHALLENGER: "王者",
};
/** These tiers have no divisions: their `rank` string from Riot means nothing and is never shown. */
const APEX_TIERS = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);
const TEXT_DIVISIONS = new Set(["I", "II", "III", "IV"]);
const SPOKEN_DIVISIONS: Readonly<Record<string, string>> = { I: "一", II: "二", III: "三", IV: "四" };
const QUEUE_LABELS: Readonly<Record<string, string>> = { RANKED_SOLO_5x5: "单双排", RANKED_FLEX_SR: "灵活组排" };

/** The 段位变化 field of the finished report. */
export const RANK_FIELD_NAME = "段位变化";

/** `单双排` or `灵活组排`, or null for a queue without LP. */
export function queueLabel(queueType: string): string | null {
  return QUEUE_LABELS[queueType] ?? null;
}

/** `黄金 II` for text, `大师` for an apex tier; null for a tier or division this code does not know. */
export function rankName(entry: Pick<RankedEntry, "tier" | "rank">): string | null {
  const tier = TIER_NAMES[entry.tier];
  if (!tier) return null;
  if (APEX_TIERS.has(entry.tier)) return tier;
  return TEXT_DIVISIONS.has(entry.rank) ? `${tier} ${entry.rank}` : null;
}

/** `黄金二` for speech, `大师` for an apex tier; null for a tier or division this code does not know. */
export function spokenRankName(entry: Pick<RankedEntry, "tier" | "rank">): string | null {
  const tier = TIER_NAMES[entry.tier];
  if (!tier) return null;
  if (APEX_TIERS.has(entry.tier)) return tier;
  const division = SPOKEN_DIVISIONS[entry.rank];
  return division ? `${tier}${division}` : null;
}

/** `+22`, `-19`, or `±0` when a game moved nothing. */
function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
}

/**
 * One row of the 段位变化 field, or null when the row would show nothing. The member is a mention, which an embed
 * never pings. A demotion shows the new rank without an LP number: the ladder distance is not the LP Riot actually
 * took until a real demotion has been measured (orchestrator ruling of 2026-10-27).
 */
export function rankRowText(memberId: string, row: RankRow): string | null {
  const queue = queueLabel(row.queueType);
  if (!queue) return null;
  const head = `<@${memberId}> ${queue}`;
  const { state } = row;
  switch (state.kind) {
    case "pending":
      return `${head} · 段位还没更新，稍后补上`;
    case "stale":
      return `${head} · 段位一直没更新，本局变化算不出来`;
    case "unavailable":
      return `${head} · 段位暂时查不到`;
    case "placed": {
      const name = rankName(state.after);
      return name ? `${head} · 定级完成：${name}` : null;
    }
    case "unattributable": {
      const name = rankName(state.after);
      return name ? `${head} ${name} · ${state.after.leaguePoints} LP · 中间隔了几局，本局变化算不出来` : null;
    }
    case "demoted": {
      const name = rankName(state.after);
      return name ? `${head} ${name} · 本局掉段` : null;
    }
    case "change":
    case "promoted": {
      const name = rankName(state.after);
      if (!name) return null;
      const line = `${head} ${name} · ${state.after.leaguePoints} LP · 本局 ${signed(state.delta)}`;
      return state.kind === "promoted" ? `${line} · 晋级！` : line;
    }
  }
}
