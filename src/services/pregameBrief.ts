import { readableName, seededChooser } from "./announcementText";
import { DIMENSION_LABELS, RECENT_FORM_GAMES, summarizeHorseRecords } from "./horseProfile";
import type { HorseProfile } from "./horseProfile";
import type { HorseTier } from "./horseRanking";
import type { Position } from "../types";
import { championLabel } from "../utils/stableEmbed";
import type { HorseRecord } from "../store/horseRecordStore";

/** The spoken line is two sentences and about 15 seconds: at most this many characters, label included. */
export const MAX_PREGAME_SPEECH_CHARACTERS = 75;
export const MOCK_PREGAME_PREFIX = "模拟锦囊，";
export const COLD_START_LINE = "马厩里还没有各位的底细，军师掐指一算……";
export const OTHER_SIDE_NOTE = "对面也有自家人，军师两边不站";

/** Games of the recent form window that make up "the last five" and "the five before". */
const FORM_WINDOW = 5;
/** A form comparison needs this many games on both sides, or one lucky game would read as a trend. */
const MIN_TREND_GAMES = 3;
/** The last five must beat or trail the five before by this much (on the 0-10 score) to count as a trend. */
const TREND_STEP = 1.0;
const EPSILON = 1e-9;
/** A champion needs this many recorded games before its tier shares mean anything. */
const MIN_CHAMPION_GAMES = 3;
/** A champion is a bad one for a member when at least this share of its games, and two of them, were 没有马. */
const CHAMPION_NONE_SHARE = 0.3;
/** A champion is a regular 特等马 for a member at this share of its games. */
const CHAMPION_TOP_SHARE = 0.3;
/** The pick gains up to this many score points for being a 特等马 regularly on this champion. */
const CHAMPION_TOP_BONUS = 2;
/** A pick whose last-five average is below this is described as the best of a modest lot. */
const STRONG_FORM = 6.5;
/** Champion records in the line need at least this many games. */
const MIN_CHAMPION_LINE_GAMES = 2;

/** One bound member on the perspective team. Enemies, strangers and members on the other team never get here. */
export interface PregameTeammate {
  memberId: string;
  /** The stored Riot game name of the account that is in the game. */
  name: string;
  championId: number;
  /** Whether the player took Smite, which means jungle. */
  smite: boolean;
  /** The member's horse records of the current data mode, in any order. */
  records: readonly HorseRecord[];
}

export interface PregameBriefInput {
  matchId: string;
  mock: boolean;
  /** Bound members on the perspective team, in bind order. */
  teammates: readonly PregameTeammate[];
  /** Perspective-team players who are not bound members. Counted, never named. */
  strangerCount: number;
  /** A bound member is playing on the other team: acknowledged, never named or rated. */
  otherSideHasFriend: boolean;
}

export type PregameTrend = "up" | "down" | "flat";

export interface PregameLine {
  memberId: string;
  name: string;
  /** Chinese champion name. */
  champion: string;
  /** No records at all: unrated. */
  isNew: boolean;
  /** The last five tiers, newest first. */
  recentTiers: HorseTier[];
  /** Average score of the last five games, or null for a new horse. */
  recentAverage: number | null;
  /** Average of the five before those, or null without enough games to compare. */
  previousAverage: number | null;
  trend: PregameTrend | null;
  /** Games on the champion in the game, and how many of them were 特等马 and 没有马. Null below two games. */
  championRecord: { games: number; top: number; none: number } | null;
  position: Position | null;
  hotStreak: number;
  coldStreak: number;
}

export interface PregamePick {
  memberId: string;
  name: string;
  /** Why, in a short phrase that fits after the name. */
  reason: string;
  /** Average score of the pick's last games, and how many games that is. */
  average: number;
  games: number;
}

export interface PregameBrief {
  matchId: string;
  mock: boolean;
  /** At most two sentences and 75 characters; starts with 模拟锦囊， in mock mode. */
  speech: string;
  /** Nobody on the team has a record yet. */
  coldStart: boolean;
  /** One line per bound teammate, in input order. */
  lines: PregameLine[];
  pick: PregamePick | null;
  /** The instruction as text for the card: it points at its member with a Discord mention. Null memberId for the generic one. */
  instruction: { memberId: string | null; text: string };
  strangerCount: number;
  otherSideHasFriend: boolean;
}

interface Analysis {
  teammate: PregameTeammate;
  champion: string;
  profile: HorseProfile;
  line: PregameLine;
  /** Share of 特等马 and 没有马 on this champion; zero below three games. */
  championTopShare: number;
  championNoneShare: number;
  championNoneCount: number;
}

const POSITION_LABEL: Record<Position, string> = { TOP: "上单", JUNGLE: "打野", MIDDLE: "中单", BOTTOM: "下路", UTILITY: "辅助" };
export const positionLabel = (position: Position): string => POSITION_LABEL[position];

const average = (records: readonly HorseRecord[]): number | null =>
  records.length > 0 ? records.reduce((total, record) => total + record.score, 0) / records.length : null;

function newestFirst(records: readonly HorseRecord[]): HorseRecord[] {
  return [...records].sort((a, b) => b.playedAt - a.playedAt || b.matchId.localeCompare(a.matchId));
}

function mostCommonPosition(records: readonly HorseRecord[]): Position | null {
  const counts = new Map<Position, number>();
  // Newest first, and a tie keeps the newer position because later entries need to beat it strictly.
  for (const record of records) if (record.position) counts.set(record.position, (counts.get(record.position) ?? 0) + 1);
  let best: Position | null = null;
  let bestCount = 0;
  for (const record of records) {
    const count = record.position ? counts.get(record.position)! : 0;
    if (count > bestCount) { best = record.position; bestCount = count; }
  }
  return best;
}

function analyze(teammate: PregameTeammate, mock: boolean): Analysis {
  for (const record of teammate.records) {
    if (record.mock !== mock) throw new Error("Mock and real horse records must not be mixed in one pregame brief.");
    if (record.discordUserId !== teammate.memberId) throw new Error("A pregame teammate may only carry their own horse records.");
  }
  const records = newestFirst(teammate.records);
  const form = records.slice(0, RECENT_FORM_GAMES);
  const profile = summarizeHorseRecords(form);
  const last = form.slice(0, FORM_WINDOW);
  const before = form.slice(FORM_WINDOW, FORM_WINDOW * 2);
  const recentAverage = average(last);
  const previousAverage = last.length >= MIN_TREND_GAMES && before.length >= MIN_TREND_GAMES ? average(before) : null;
  let trend: PregameTrend | null = null;
  if (recentAverage !== null && previousAverage !== null) {
    const change = recentAverage - previousAverage;
    trend = change >= TREND_STEP - EPSILON ? "up" : change <= -TREND_STEP + EPSILON ? "down" : "flat";
  }
  const onChampion = records.filter((record) => record.championId === teammate.championId);
  const top = onChampion.filter((record) => record.tier === "特等马").length;
  const none = onChampion.filter((record) => record.tier === "没有马").length;
  const enough = onChampion.length >= MIN_CHAMPION_GAMES;
  const position = teammate.smite ? "JUNGLE" : mostCommonPosition(onChampion);
  const champion = championLabel({ championId: teammate.championId, championName: readableName(onChampion[0]?.championName || "神秘英雄") });
  return {
    teammate,
    champion,
    profile,
    championTopShare: enough ? top / onChampion.length : 0,
    championNoneShare: enough ? none / onChampion.length : 0,
    championNoneCount: enough ? none : 0,
    line: {
      memberId: teammate.memberId,
      name: readableName(teammate.name),
      champion,
      isNew: records.length === 0,
      recentTiers: last.map((record) => record.tier),
      recentAverage,
      previousAverage,
      trend,
      championRecord: onChampion.length >= MIN_CHAMPION_LINE_GAMES ? { games: onChampion.length, top, none } : null,
      position,
      hotStreak: profile.streaks.top.current >= 2 ? profile.streaks.top.current : 0,
      coldStreak: profile.streaks.none.current >= 2 ? profile.streaks.none.current : 0,
    },
  };
}

type PhraseContext = { champion: string; dimension: string | null };
type Phrase = (who: string, context: PhraseContext) => string;

/** All instructions talk about play only. */
const CHAMPION_BAD: readonly Phrase[] = [
  (who, { champion }) => `${who}的${champion}一向翻车，这把稳着点，先保命再说。`,
  (who, { champion }) => `${who}这匹${champion}总是跑不动，这把别硬拼，跟着队友走。`,
];
const COLD_STREAK: readonly Phrase[] = [
  (who) => `${who}连着没跑出来，这把先稳住，少送人头。`,
  (who) => `${who}这几把状态低迷，这把求稳，别急着换命。`,
  (who, { dimension }) => `${who}连着没跑出来，${dimension}是短板，这把多留意${dimension}。`,
];
const DOWN_TREND: readonly Phrase[] = [
  (who) => `${who}近几把走下坡路，这把打稳点，别急。`,
  (who) => `${who}状态有点下滑，这把先找回节奏。`,
];
const PICK_HOT: readonly Phrase[] = [
  (who) => `${who}手感正热，这把大胆去抓。`,
  (who) => `${who}正在兴头上，这把继续带队打节奏。`,
];
const PICK_ORDER: readonly Phrase[] = [
  (who) => `${who}这把就看你了，别让军师白押。`,
  (who) => `${who}扛起旗来，这把带着队友打出节奏。`,
];
const GENERIC_ORDER: readonly string[] = [
  "这把大家先稳住，别急着送。",
  "这把先打稳，赢一把再说。",
];

/** Speech names lose characters that would end a sentence, so the line stays two sentences. */
function speechName(name: string, limit: number): string {
  const clean = readableName(name).replace(/[。！？；…!?;.]/g, " ").replace(/\s+/g, " ").trim() || "无名氏";
  return Array.from(clean).slice(0, limit).join("").trim() || "无";
}

/** Longest names first; the form phrase goes before the names are cut further. */
const NAME_LIMITS = [32, 10, 6, 4, 2, 1] as const;

interface PickCandidate { analysis: Analysis; score: number; bonus: number }

function pickReason(candidate: PickCandidate): string {
  const { line } = candidate.analysis;
  if (candidate.analysis.championTopShare >= CHAMPION_TOP_SHARE) return "这英雄是看家马";
  if (line.hotStreak > 0) return `连着${line.hotStreak}局特等马`;
  if ((line.recentAverage ?? 0) >= STRONG_FORM) return "近况最旺";
  return "矮子里拔将军";
}

/**
 * The 军师赛前锦囊 for the bound members of one team: a short spoken line and the data for the text card.
 * It reads only the teammates it is given, so enemies, strangers and a friend on the other side are never named or rated.
 * Phrase choices are seeded by the game ID, so the same game always gets the same brief.
 */
export function buildPregameBrief(input: PregameBriefInput): PregameBrief {
  const { matchId, mock, teammates } = input;
  if (typeof matchId !== "string" || matchId.trim().length === 0) throw new TypeError("A pregame brief needs a match ID.");
  if (teammates.length === 0) throw new TypeError("A pregame brief needs at least one bound teammate.");
  if (!Number.isSafeInteger(input.strangerCount) || input.strangerCount < 0) throw new TypeError("strangerCount must be a non-negative integer.");

  const analyses = teammates.map((teammate) => analyze(teammate, mock));
  const rated = analyses.filter((analysis) => !analysis.line.isNew);
  const coldStart = rated.length === 0;
  const choose = seededChooser(`pregame:${matchId}`);
  const prefix = mock ? MOCK_PREGAME_PREFIX : "";

  // 军师之选: best recent form, plus a bonus for being a regular 特等马 on this champion. Bind order breaks ties.
  let pick: PickCandidate | null = null;
  for (const analysis of rated) {
    const bonus = analysis.championTopShare * CHAMPION_TOP_BONUS;
    const score = (analysis.line.recentAverage ?? 0) + bonus;
    if (!pick || score > pick.score + EPSILON) pick = { analysis, score, bonus };
  }

  // 军师指令: the strongest negative signal in the team, a champion first, then a cold run, then a falling form.
  let target: { analysis: Analysis; weight: number; phrases: readonly Phrase[] } | null = null;
  const consider = (analysis: Analysis, weight: number, phrases: readonly Phrase[]) => {
    if (!target || weight > target.weight + EPSILON) target = { analysis, weight, phrases };
  };
  for (const analysis of rated) {
    const { line } = analysis;
    if (analysis.championNoneCount >= 2 && analysis.championNoneShare >= CHAMPION_NONE_SHARE - EPSILON) {
      consider(analysis, 300 + analysis.championNoneShare, CHAMPION_BAD);
    } else if (line.coldStreak > 0) {
      consider(analysis, 200 + line.coldStreak, COLD_STREAK);
    } else if (line.trend === "down") {
      consider(analysis, 100 + (line.previousAverage! - line.recentAverage!), DOWN_TREND);
    }
  }

  const openers = [
    (name: string) => `军师之选是${name}`,
    (name: string) => `这把军师押${name}`,
  ];
  let instruction: { memberId: string | null; text: string };
  let render: (nameLimit: number, withForm: boolean) => string;
  let pickForm = "";

  if (coldStart) {
    const generic = choose(GENERIC_ORDER);
    instruction = { memberId: null, text: generic };
    render = () => `${COLD_START_LINE}${generic}`;
  } else {
    const picked = pick!;
    pickForm = pickReason(picked);
    const opener = choose(openers);
    let phrase: Phrase;
    let subject: Analysis;
    // An order to the pick follows the sentence that just named them, so the speech does not repeat the name.
    let nameSecondTime = true;
    if (target) {
      const chosen = target as { analysis: Analysis; phrases: readonly Phrase[] };
      subject = chosen.analysis;
      // The dimension variant needs a named weak spot.
      phrase = choose(subject.profile.weakest ? chosen.phrases : chosen.phrases.filter((candidate) => candidate !== COLD_STREAK[2]));
    } else {
      subject = picked.analysis;
      phrase = choose(picked.analysis.line.hotStreak > 0 ? PICK_HOT : PICK_ORDER);
      nameSecondTime = false;
    }
    const context: PhraseContext = {
      champion: subject.champion,
      dimension: subject.profile.weakest ? DIMENSION_LABELS[subject.profile.weakest.dimension] : null,
    };
    instruction = { memberId: subject.teammate.memberId, text: phrase(`<@${subject.teammate.memberId}>`, context) };
    render = (nameLimit, withForm) => {
      const first = `${opener(speechName(picked.analysis.teammate.name, nameLimit))}${withForm ? `，${pickForm}` : ""}。`;
      return `${first}${phrase(nameSecondTime ? speechName(subject.teammate.name, nameLimit) : "", context)}`;
    };
  }

  let speech: string | null = null;
  fit: for (const nameLimit of NAME_LIMITS) {
    for (const withForm of [true, false]) {
      const candidate = `${prefix}${render(nameLimit, withForm)}`;
      if (candidate.length <= MAX_PREGAME_SPEECH_CHARACTERS) { speech = candidate; break fit; }
    }
  }
  if (speech === null) throw new Error("The pregame speech cannot fit in the length limit.");

  return {
    matchId,
    mock,
    speech,
    coldStart,
    lines: analyses.map((analysis) => analysis.line),
    pick: pick
      ? { memberId: pick.analysis.teammate.memberId, name: pick.analysis.line.name, reason: pickForm, average: pick.analysis.line.recentAverage!, games: pick.analysis.line.recentTiers.length }
      : null,
    instruction,
    strangerCount: input.strangerCount,
    otherSideHasFriend: input.otherSideHasFriend,
  };
}
