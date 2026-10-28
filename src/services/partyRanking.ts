import type { HorseTier } from "./horseRanking";

/** A tracked member's account that played in the match. */
export interface PartyMember {
  memberId: string;
  puuid: string;
}

/** One horse of the perspective team, already labeled for display; the team arrives in ranking order. */
export interface PartyHorse {
  puuid: string;
  tier: HorseTier;
  /** The score as shown, one decimal place. */
  score: number;
  champion: string;
  /** Sanitized for speech and Discord text. */
  name: string;
}

export interface PartyEntry {
  memberId: string;
  puuid: string;
  name: string;
  champion: string;
  tier: HorseTier;
  score: number;
  /** The horse's 1-based place in its whole team's ranking, not in the party. */
  teamRank: number;
  teamSize: number;
}

/**
 * The 车队内战: bound friends on one team ranked among themselves. Derived from the team ranking and never stored.
 *
 * Ties are decided on the displayed score. The members sharing the top score are the 车队 MVP together, and the
 * members sharing the lowest score take the 背锅 together, which means nobody: a 背锅 is named only when exactly one
 * member has the lowest score. When everyone shares one score there is neither an MVP nor a 背锅.
 */
export interface PartyRanking {
  /** The party in team rank order, best first; at least two members. */
  entries: PartyEntry[];
  /** The members with the top score; every member when `tiedAll`. */
  best: PartyEntry[];
  /** The members with the lowest score, empty when `tiedAll`. One member is the 背锅; several are tied and nobody is. */
  worst: PartyEntry[];
  /** Every member has the same displayed score. */
  tiedAll: boolean;
  /** The best member is only 中等马 or lower, so the wording says relatively best instead of claiming the lead. */
  modest: boolean;
  /** The single 背锅 is still a 特等马 or 上等马, so the wording says the blame is only relative. */
  relative: boolean;
  /** The one spoken sentence appended to the report. */
  sentence: string;
  /** 军师 lines for the embed; they carry no name because the embed mentions the member. Empty when there is nothing to say. */
  bestLine: string;
  worstLine: string;
  mock: boolean;
}

export interface PartyInput {
  /** The perspective team's horses from best to worst. */
  team: readonly PartyHorse[];
  /** Bound members; entries whose account is not on the team are ignored, so a friend on the other team never enters. */
  party: readonly PartyMember[];
  mock: boolean;
  /** Deterministic choice, seeded by the match ID by the caller. */
  choose: <T>(options: readonly T[]) => T;
}

/** The sentence stays within this many characters unless the fixed words alone are longer. */
export const PARTY_SENTENCE_LIMIT = 29;
const MIN_SPOKEN_NAME = 2;

const SPOKEN_BEST = ["最好", "领跑", "夺魁"] as const;
const MODEST_BEST = "相对最好";
const TIED_BEST = "并列最好";
const TIED_MODEST_BEST = "并列靠前";
const BLAME = "背锅";
const RELATIVE_BLAME = ["今天只是相对背锅", "只是相对背锅"] as const;
const TIED_WORST = "并列垫底";

const MVP_LINES = [
  "领跑整个车队，这面旗军师交给你扛。",
  "车队里数你最稳，开黑的主心骨就是你。",
  "同行的朋友里，你这匹跑在最前面。",
] as const;
const MODEST_MVP_LINES = [
  "车队里你相对靠前，下把争取真领跑。",
  "同行的朋友里你跑得相对靠前，下把再往前冲一冲。",
] as const;
const TIED_BEST_LINES = [
  "几位并列靠前，谁也没甩开谁，下把分个高下。",
  "分数并列在前，军师不偏不倚，下把见真章。",
] as const;
const BLAME_LINES = [
  "车队里分数最低，这口锅先背着，下把打回来。",
  "军师翻了翻战绩，这把垫底的是你，别急，下把再来。",
  "车队里跑在最后，这口锅你认了，下把军师还骑你。",
] as const;
const RELATIVE_BLAME_LINES = [
  "你其实打得不差，只是车队里有人更强，这口锅只是相对的。",
  "分数不低，只是在车队里排最后，相对背锅，别往心里去。",
] as const;
const TIED_WORST_LINE = "几位并列垫底，这把没有谁单独背锅，下把一起打回来。";
const ALL_TIED_LINE = "分数一模一样，这把车队不分高下，没人背锅。";

/** "A", "A和B", "A、B和C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join("、")}和${names[names.length - 1]}`;
}

/** Shortens names to `budget` characters together, trimming the longest first and never below a few characters, from the front or the back. */
export function fitNames(names: readonly string[], budget: number, fromEnd = false): string[] {
  const parts = names.map((name) => Array.from(name));
  const keep = parts.map((part) => part.length);
  const total = () => keep.reduce((sum, length) => sum + length, 0);
  while (total() > budget) {
    let longest = 0;
    keep.forEach((length, index) => { if (length > keep[longest]) longest = index; });
    if (keep[longest] <= MIN_SPOKEN_NAME) break;
    keep[longest]--;
  }
  return parts.map((part, index) => keep[index] === part.length ? part.join("")
    : (fromEnd ? part.slice(part.length - keep[index]) : part.slice(0, keep[index])).join(""));
}

const distinct = (names: readonly string[]) => new Set(names).size === names.length;

/**
 * The names as they are spoken: whole, or trimmed to the budget. Two members must never sound the same,
 * so names that collide after trimming keep their ends instead, and then fall back to `fallbacks` (the champions).
 */
export function spokenNames(names: readonly string[], budget: number, fallbacks?: readonly string[]): string[] {
  const fromFront = fitNames(names, budget, false);
  if (distinct(fromFront)) return fromFront;
  const fromEnd = fitNames(names, budget, true);
  if (distinct(fromEnd)) return fromEnd;
  const other = fallbacks ? fitNames(fallbacks, budget, false) : undefined;
  return other && distinct(other) ? other : fromFront;
}

/**
 * Ranks the bound members of one team among themselves, in the order the team ranking already gave.
 * Returns undefined for fewer than two members, so a lone friend changes nothing.
 * Enemies never enter: only horses of the given team can be members of the party.
 */
export function buildPartyRanking(input: PartyInput): PartyRanking | undefined {
  const { team, party, mock, choose } = input;
  const seen = new Set<string>();
  const entries: PartyEntry[] = [];
  team.forEach((horse, index) => {
    const member = party.find((candidate) => candidate.puuid === horse.puuid);
    // One entry per member, the best-ranked account first.
    if (!member || seen.has(member.memberId)) return;
    seen.add(member.memberId);
    entries.push({
      memberId: member.memberId, puuid: horse.puuid, name: horse.name, champion: horse.champion,
      tier: horse.tier, score: horse.score, teamRank: index + 1, teamSize: team.length,
    });
  });
  if (entries.length < 2) return undefined;

  const top = entries[0].score;
  const bottom = entries[entries.length - 1].score;
  const tiedAll = top === bottom;
  const best = tiedAll ? entries : entries.filter((entry) => entry.score === top);
  const worst = tiedAll ? [] : entries.filter((entry) => entry.score === bottom);
  const modest = !tiedAll && best[0].tier !== "特等马" && best[0].tier !== "上等马";
  const single = worst.length === 1;
  const relative = single && (worst[0].tier === "特等马" || worst[0].tier === "上等马");

  // Words are drawn in a fixed order, so the same match always gets the same sentence.
  const bestWord = best.length > 1 ? (modest ? TIED_MODEST_BEST : TIED_BEST) : modest ? MODEST_BEST : choose(SPOKEN_BEST);
  const blameWord = relative ? choose(RELATIVE_BLAME) : BLAME;
  const say = (names: readonly string[]) => {
    if (tiedAll) return `车队内战，${joinNames(names)}并列。`;
    const leaders = joinNames(names.slice(0, best.length));
    const laggards = joinNames(names.slice(best.length));
    return `车队内战，${leaders}${bestWord}，${laggards}${single ? blameWord : TIED_WORST}。`;
  };
  const spoken = [...best, ...worst];
  // The words around the names decide how many characters the names may take.
  const fixed = say(spoken.map(() => "")).length;
  const sentence = say(spokenNames(spoken.map((entry) => entry.name), PARTY_SENTENCE_LIMIT - fixed, spoken.map((entry) => entry.champion)));

  return {
    entries, best, worst, tiedAll, modest, relative, sentence,
    bestLine: tiedAll ? ALL_TIED_LINE : choose(best.length > 1 ? TIED_BEST_LINES : modest ? MODEST_MVP_LINES : MVP_LINES),
    worstLine: tiedAll ? "" : !single ? TIED_WORST_LINE : choose(relative ? RELATIVE_BLAME_LINES : BLAME_LINES),
    mock,
  };
}
