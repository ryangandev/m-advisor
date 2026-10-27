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

/** The 车队内战: bound friends on one team ranked among themselves. Derived from the team ranking and never stored. */
export interface PartyRanking {
  /** The party in team rank order, best first; at least two members. */
  entries: PartyEntry[];
  /** 车队 MVP: the party's best horse. */
  mvp: PartyEntry;
  /** 本局背锅: the party's lowest score, even when that horse is good, so the joke is only relative. */
  scapegoat: PartyEntry;
  /** The scapegoat is still a 特等马 or 上等马, so the wording says the blame is only relative. */
  relative: boolean;
  /** The one spoken sentence appended to the report. */
  sentence: string;
  /** 军师 lines for the embed; they carry no name because the embed mentions the member. */
  mvpLine: string;
  scapegoatLine: string;
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
const MIN_SPOKEN_NAME = 3;

const SPOKEN_BEST = ["最好", "领跑", "夺魁"] as const;
const BLAME = "背锅";
const RELATIVE_BLAME = ["今天只是相对背锅", "只是相对背锅"] as const;

const MVP_LINES = [
  "领跑整个车队，这面旗军师交给你扛。",
  "车队里数你最稳，开黑的主心骨就是你。",
  "同行的朋友里，你这匹跑在最前面。",
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

/** Shortens two names to fit `budget` characters together, trimming the longer one first and never below a few characters. */
function fitNames(first: string, second: string, budget: number): [string, string] {
  const a = Array.from(first);
  const b = Array.from(second);
  if (a.length + b.length <= budget) return [first, second];
  const cap = Math.max(MIN_SPOKEN_NAME, Math.floor(budget / 2));
  let keepA = cap;
  let keepB = cap;
  if (a.length <= cap) { keepA = a.length; keepB = Math.max(MIN_SPOKEN_NAME, budget - a.length); }
  else if (b.length <= cap) { keepB = b.length; keepA = Math.max(MIN_SPOKEN_NAME, budget - b.length); }
  return [a.slice(0, keepA).join(""), b.slice(0, keepB).join("")];
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

  const mvp = entries[0];
  const scapegoat = entries[entries.length - 1];
  const relative = scapegoat.tier === "特等马" || scapegoat.tier === "上等马";
  const best = choose(SPOKEN_BEST);
  const blame = relative ? choose(RELATIVE_BLAME) : BLAME;
  // The words around the two names decide how many characters the names may take.
  const fixed = `车队内战，${best}，${blame}。`.length;
  const [bestName, blameName] = fitNames(mvp.name, scapegoat.name, PARTY_SENTENCE_LIMIT - fixed);
  return {
    entries, mvp, scapegoat, relative,
    sentence: `车队内战，${bestName}${best}，${blameName}${blame}。`,
    mvpLine: choose(MVP_LINES),
    scapegoatLine: choose(relative ? RELATIVE_BLAME_LINES : BLAME_LINES),
    mock,
  };
}
