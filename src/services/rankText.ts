import type { RankedEntry } from "../types";
import type { RankRow } from "./rankTracker";
import { readableName, seededChooser } from "./announcementText";
import { spokenNames } from "./partyRanking";

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
 * never pings. A demotion shows the new rank and its LP but no change: the LP after the game is Riot's, but the ladder
 * distance is not the LP Riot actually took until a real demotion has been measured (orchestrator ruling of 2026-10-27).
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
      return name ? `${head} ${name} · ${state.after.leaguePoints} LP · 赛前段位没读到或中间隔了几局，本局变化算不出来` : null;
    }
    case "demoted": {
      const name = rankName(state.after);
      return name ? `${head} ${name} · ${state.after.leaguePoints} LP · 本局掉段` : null;
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

/** The title of the separate message about a promotion or demotion; mock mode puts `模拟数据 · ` in front. */
export const RANK_ANNOUNCEMENT_TITLE = "段位播报";
/** The spoken line of a mock 段位播报 starts with this, like `模拟锦囊，`. */
export const MOCK_RANK_VOICE_PREFIX = "模拟段位播报，";
/** The voice line speaks at most this many members, so it stays about 15 seconds; the text lists every one. */
export const MAX_SPOKEN_RANK_MOVES = 2;
/** The spoken names of one line share this many characters: with the longest phrases and the mock prefix, a line stays near 15 seconds. */
export const SPOKEN_NAME_BUDGET = 12;

/** A promotion or demotion of one bound member in one ranked match: what a 段位播报 is about. */
export interface RankMove {
  kind: "promoted" | "demoted";
  queueType: string;
  before: RankedEntry;
  after: RankedEntry;
}

/**
 * The promotion or demotion a row stands for, or null for every row that is never announced: a plain change (which
 * includes a move among MASTER, GRANDMASTER and CHALLENGER, made by cutoffs), placements, a gap of several games, and
 * pending, stale or unavailable rows. Also null when a rank or queue has no name.
 */
export function rankMoveOf(row: RankRow): RankMove | null {
  const { state } = row;
  if (state.kind !== "promoted" && state.kind !== "demoted") return null;
  if (!queueLabel(row.queueType) || !rankName(state.before) || !rankName(state.after)) return null;
  return { kind: state.kind, queueType: row.queueType, before: state.before, after: state.after };
}

/**
 * One line of the 段位播报 message. A promotion shows the new LP; a demotion shows the new rank and its LP but no change
 * number, for the same reason as the 段位变化 row (orchestrator ruling of 2026-10-27).
 */
export function rankMoveText(memberId: string, move: RankMove): string | null {
  const queue = queueLabel(move.queueType);
  const from = rankName(move.before);
  const to = rankName(move.after);
  if (!queue || !from || !to) return null;
  return `<@${memberId}> ${queue} ${move.kind === "promoted" ? "晋级" : "掉段"}：${from} → ${to} · ${move.after.leaguePoints} LP`;
}

type MovePhrase = (name: string, queue: string, rank: string) => string;

/** Play-only wording, no em dash. A demotion comforts, and the 军师 stays by the player. */
const PROMOTION_PHRASES: readonly MovePhrase[] = [
  (name, queue, rank) => `军师贺喜！${name}${queue}升到${rank}了。`,
  (name, queue, rank) => `${name}${queue}晋级${rank}，军师备好了新鞍。`,
  (name, queue, rank) => `恭喜${name}，${queue}升到${rank}，军师给你牵马。`,
];
const DEMOTION_PHRASES: readonly MovePhrase[] = [
  (name, queue, rank) => `${name}${queue}掉回${rank}，别急，军师陪你重新上马。`,
  (name, queue, rank) => `${name}${queue}退到${rank}，胜败乃兵家常事，别灰心。`,
  (name, queue, rank) => `${name}${queue}落到${rank}，不要紧，军师陪你再战。`,
];

export interface RankVoiceMove extends RankMove {
  puuid: string;
  /** The name the report shows for the player; sanitized here. */
  name: string;
  /** The champion the report shows, spoken in place of the names when members share one; none when it is unknown. */
  champion?: string;
}

/**
 * The one spoken line of a match's 段位播报: a sentence for each of the first MAX_SPOKEN_RANK_MOVES members, with tiers as
 * `黄金二`. Each sentence is chosen from a small pool, seeded by `rank:<matchId>:<puuid>`, so the same match always says
 * the same thing. Mock lines start with MOCK_RANK_VOICE_PREFIX. Empty when no member can be spoken.
 */
export function buildRankVoiceLine(input: { matchId: string; mock: boolean; moves: readonly RankVoiceMove[] }): string {
  const spoken: Array<{ move: RankVoiceMove; queue: string; rank: string }> = [];
  for (const move of input.moves) {
    if (spoken.length >= MAX_SPOKEN_RANK_MOVES) break;
    const queue = queueLabel(move.queueType);
    const rank = spokenRankName(move.after);
    if (queue && rank) spoken.push({ move, queue, rank });
  }
  if (spoken.length === 0) return "";
  // Long names share a speech budget, so two 16-letter names cannot stretch the line past about 15 seconds.
  // Two members must still sound different after trimming, so names that collide keep their ends instead,
  // and names that are the same fall back to the champions, as the 车队内战 sentence does.
  const names = spokenNames(
    spoken.map(({ move }) => readableName(move.name)), SPOKEN_NAME_BUDGET, spoken.map(({ move }) => readableName(move.champion ?? "")),
  );
  const sentences = spoken.map(({ move, queue, rank }, index) => {
    const choose = seededChooser(`rank:${input.matchId}:${move.puuid}`);
    const phrase = choose(move.kind === "promoted" ? PROMOTION_PHRASES : DEMOTION_PHRASES);
    return phrase(names[index], queue, rank);
  });
  return `${input.mock ? MOCK_RANK_VOICE_PREFIX : ""}${sentences.join("")}`;
}
