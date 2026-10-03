import championNames from "../data/championNamesZh.json";
import type { MatchDetail, MatchParticipant } from "../types";
import { rankTeam } from "./horseRanking";
import type { Benchmarks, Dimension, HorseTier, RankedHorse } from "./horseRanking";

/** Games shorter than this are remakes or abandoned games whose statistics say nothing about play. */
export const MIN_RANKED_MINUTES = 10;

export interface HorseReportLine { tier: HorseTier; champion: string; name: string; score: number; kda: string; tracked: boolean }
export interface MatchReport {
  title: string;
  summary: string;
  lines: HorseReportLine[];
  praise?: string;
  roast?: string;
  mock: boolean;
}
export interface MatchAnnouncement { speech: string; report: MatchReport }

/** Keep names from turning into Discord mentions or spoken control-like text. */
function readableName(name: string): string {
  return (typeof name === "string" ? name : "").replace(/[@<>`*_~|\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 32) || "无名氏";
}

export function championLabel(participant: MatchParticipant): string {
  const names = (championNames as { names: Record<string, string> }).names;
  return names[String(participant.championId)] ?? readableName(participant.championName || "神秘英雄");
}

/** Deterministic per-match choices keep a report reproducible while varying between matches. */
function chooser(seed: string): <T>(options: readonly T[]) => T {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return (options) => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return options[((value ^ (value >>> 14)) >>> 0) % options.length];
  };
}

const percent = (value: number | undefined) => `百分之${Math.round((value ?? 0) * 100)}`;

interface LineContext { name: string; horse: RankedHorse; minutes: number }
type Line = (context: LineContext) => string;
/** A detail line returns undefined when its statistic would contradict the verdict, such as a lead of zero. */
type DetailLine = (context: LineContext) => string | undefined;

const PRAISE_OPENERS: readonly Line[] = [
  ({ name }) => `此马只应天上有，人间哪得几回闻！${name}，说的就是你。`,
  ({ name }) => `军师夜观天象，今晚的紫微星就落在${name}的头上。`,
  ({ name }) => `赤兔看了要让位，的卢看了要改名，这就是${name}。`,
  ({ name }) => `建议把${name}直接打包送去职业赛场，青训都不用过。`,
  ({ name }) => `军师把扇子都扇冒烟了，也挑不出${name}半点毛病。`,
  ({ name }) => `家人们谁懂啊，${name}这把直接把峡谷当成了自家后院。`,
];
// Dimension scores are relative to the position, but these lines quote absolute numbers, so each line also
// needs a number that sounds right out loud. The bars come from the reference sample's distributions.
const PRAISE_DETAILS: Record<Dimension, DetailLine> = {
  damage: ({ horse: { features: f } }) => (f.damageShare ?? 0) >= 0.25
    ? `一个人打出全队${percent(f.damageShare)}的伤害，这不是马，这是峡谷人形自走炮台。` : undefined,
  teamfight: ({ horse: { features: f } }) => (f.killParticipation ?? 0) >= 0.6
    ? `参团率${percent(f.killParticipation)}，哪里有架打哪里就有你，峡谷110都没你出警快。` : undefined,
  survival: ({ horse: { participant: p } }) => p.deaths <= 4 && p.kills + p.assists >= 4 * Math.max(1, p.deaths)
    ? `${p.kills}杀${p.deaths}死${p.assists}助攻，在刀尖上跳舞还不带掉血的。` : undefined,
  economy: ({ horse: { features: f } }) => (f.goldPerMinute ?? 0) >= 450
    ? `每分钟进账${Math.round(f.goldPerMinute!)}金币，峡谷首富，对面的钱包都是你的提款机。` : undefined,
  frontline: ({ horse: { features: f } }) => (f.damageTakenShare ?? 0) >= 0.25
    ? `替全队扛下${percent(f.damageTakenShare)}的伤害，人肉城墙，队友的安全感全是你给的。` : undefined,
  vision: ({ horse: { features: f, participant: p } }) => (f.visionPerMinute ?? 0) >= 1.5
    ? `视野得分${p.stats.visionScore ?? 0}，峡谷每一片草丛都得先向你报到。` : undefined,
  objectives: ({ horse: { features: f } }) => (f.turretShare ?? 0) >= 0.3 || (f.epicObjectiveShare ?? 0) >= 0.6
    ? `推塔拿龙一条龙服务，地图资源全被你安排得明明白白。` : undefined,
  utility: ({ horse: { participant: p } }) => {
    const healShield = Math.round(p.stats.effectiveHealAndShielding ?? 0);
    const crowdControl = Math.round(p.stats.timeCCingOthers ?? 0);
    if (healShield >= 3000) return `治疗加护盾${healShield}点，队友的血条是你一格一格续上的。`;
    return crowdControl >= 30 ? `控了对面${crowdControl}秒，对面全程站着看你表演。` : undefined;
  },
  matchup: ({ horse, minutes }) => {
    const lead = Math.round((horse.features.goldDiffPerMinute ?? 0) * minutes);
    return lead >= 500 ? `比对位多赚了${lead}经济，对面那位今晚怕是要失眠。` : undefined;
  },
};
const PRAISE_CLOSERS = ["军师宣布，此马封神。", "这匹马，军师亲自给你牵缰绳。", "今晚峡谷的月亮，为你而圆。", "下一把，军师还骑你。"] as const;
const PRAISE_GENERIC: Line = () => "矮子里拔将军，你就是那个将军。";

const ROAST_OPENERS: readonly Line[] = [
  ({ name }) => `接下来有请本局没有马，${name}。`,
  ({ name }) => `军师看完${name}的战绩，羽扇当场掉在了地上。`,
  ({ name }) => `${name}，你这不是马，你是峡谷观光团的团长。`,
  ({ name }) => `军师掐指一算，${name}今天出门没带手。`,
  ({ name }) => `${name}，军师翻遍了马厩，也没找到你的马。`,
  ({ name }) => `典中典之${name}，军师看完战绩直接绷不住了。`,
  ({ name }) => `${name}，你这波操作直接给军师整不会了。`,
];
const ROAST_DETAILS: Record<Dimension, DetailLine> = {
  damage: ({ horse: { features: f } }) => f.damageShare !== undefined && f.damageShare <= 0.15
    ? `伤害只占全队${percent(f.damageShare)}，刮痧师傅看了都要喊你一声师父。` : undefined,
  teamfight: ({ horse: { features: f } }) => f.killParticipation !== undefined && f.killParticipation <= 0.4
    ? `参团率${percent(f.killParticipation)}，队友在打团，你在峡谷里旅游采风。` : undefined,
  survival: ({ horse: { participant: p } }) => p.deaths >= 7
    ? `死了${p.deaths}次，泉水都要给你办年卡了，对面的经验全是你送的外卖。` : undefined,
  economy: ({ horse: { features: f, participant: p } }) => p.position !== "UTILITY" && f.csPerMinute !== undefined && f.csPerMinute <= 6
    ? `每分钟补刀${f.csPerMinute.toFixed(1)}个，兵线从你面前走过都不带回头的。` : undefined,
  frontline: ({ horse: { features: f } }) => f.damageTakenShare !== undefined && f.damageTakenShare <= 0.18
    ? `承伤只有全队${percent(f.damageTakenShare)}，前排看了你的血条都想转后排。` : undefined,
  vision: ({ horse: { features: f, participant: p } }) =>
    f.visionPerMinute !== undefined && f.visionPerMinute <= (p.position === "UTILITY" ? 1.5 : 0.6)
      ? `视野得分${p.stats.visionScore ?? 0}，地图在你眼里就是一张白纸，眼睛是租来的吗。` : undefined,
  objectives: ({ horse: { features: f } }) => (f.turretShare ?? 0) <= 0.1 && (f.epicObjectiveShare ?? 0) <= 0.2
    ? `推塔拿龙全程缺席，大龙小龙跟你不熟，防御塔也不认识你。` : undefined,
  utility: ({ horse: { participant: p } }) => (p.stats.effectiveHealAndShielding ?? 0) < 1500 && (p.stats.timeCCingOthers ?? 0) < 15
    ? `治疗护盾控制全都约等于零，你这是来峡谷蹭饭的吧。${p.position === "UTILITY" ? "辅助装备留着当传家宝吗。" : ""}` : undefined,
  matchup: ({ horse, minutes }) => {
    const deficit = Math.round(-(horse.features.goldDiffPerMinute ?? 0) * minutes);
    return deficit >= 500 ? `被对位多拿了${deficit}经济，对面拿你当提款机，还不收手续费。` : undefined;
  },
};
const ROAST_CLOSERS = [
  "建议转行当野怪，起码还能给队友送点经验。",
  "下把再这样，军师亲自把你的马厩拆了。",
  "人机看了都要说一句，兄弟你先别急。",
  "罚你今晚抄写孙子兵法一百遍。",
  "军师建议你先去训练模式，跟木桩谈谈心。",
  "急了急了，下把出门记得带上手。",
] as const;
const ROAST_GENERIC: Line = () => "五匹马里你跑在最后，马都嫌你慢。";

function praise(horse: RankedHorse, minutes: number, won: boolean, choose: ReturnType<typeof chooser>): string {
  const context = { name: displayName(horse), horse, minutes };
  // Cite the strongest dimension that is genuinely good for this position and whose number sounds good out loud.
  const detail = firstLine(horse.strengths.filter((dimension) => horse.dimensions[dimension]! >= 0.6), PRAISE_DETAILS, context);
  return [choose(PRAISE_OPENERS)(context), detail ?? PRAISE_GENERIC(context), won ? "" : "虽然输了，但这把锅跟你无关。", choose(PRAISE_CLOSERS)].join("");
}

function roast(horse: RankedHorse, minutes: number, won: boolean, choose: ReturnType<typeof chooser>): string {
  const context = { name: displayName(horse), horse, minutes };
  const weakest = [...horse.strengths].reverse().filter((dimension) => horse.dimensions[dimension]! <= 0.4);
  const detail = firstLine(weakest, ROAST_DETAILS, context);
  return [choose(ROAST_OPENERS)(context), detail ?? ROAST_GENERIC(context), won ? "这把能赢，纯属被队友抬进了终点。" : "", choose(ROAST_CLOSERS)].join("");
}

function firstLine(dimensions: Dimension[], lines: Record<Dimension, DetailLine>, context: LineContext): string | undefined {
  for (const dimension of dimensions) {
    const line = lines[dimension](context);
    if (line) return line;
  }
  return undefined;
}

function displayName(horse: RankedHorse): string {
  return readableName(horse.participant.riotIdGameName);
}

function validate(detail: MatchDetail): void {
  if (!Array.isArray(detail?.info?.participants) || detail.info.participants.length === 0) {
    throw new Error("The match does not contain valid participants.");
  }
  for (const participant of detail.info.participants) {
    if (!participant || typeof participant.puuid !== "string" || typeof participant.win !== "boolean" ||
      ![participant.kills, participant.deaths, participant.assists].every((stat) => Number.isSafeInteger(stat) && stat >= 0)) {
      throw new Error("The match contains invalid participant statistics.");
    }
  }
}

/**
 * Ranks the tracked player's five teammates from 特等马 to 没有马, praises the best and roasts the worst.
 * Speech and the channel report share the same ranking.
 */
export function buildMatchAnnouncement(detail: MatchDetail, trackedPuuid: string, mock: boolean, benchmarks?: Benchmarks): MatchAnnouncement {
  validate(detail);
  const ranking = rankTeam(detail, trackedPuuid, benchmarks);
  const tracked = ranking.horses.find((horse) => horse.participant.puuid === trackedPuuid)!;
  const minutes = Math.max(1, Math.round(ranking.durationMinutes));
  const prefix = mock ? "模拟战报。" : "";
  const result = ranking.won ? "赢了" : "输了";
  const title = `${mock ? "模拟战报 · " : ""}策马军师 · 本局马匹鉴定`;
  const lines = ranking.horses.map((horse) => ({
    tier: horse.tier,
    champion: championLabel(horse.participant),
    name: displayName(horse),
    score: Math.round(horse.score * 10) / 10,
    kda: `${horse.participant.kills}/${horse.participant.deaths}/${horse.participant.assists}`,
    tracked: horse === tracked,
  }));

  if (ranking.aborted) {
    const summary = `${displayName(tracked)}这局被系统中止，没分胜负，马场临时关门，军师不予鉴定。`;
    return { speech: `${prefix}${summary}`, report: { title, summary, lines: [], mock } };
  }
  if (ranking.remake || ranking.durationMinutes < MIN_RANKED_MINUTES) {
    const summary = `${displayName(tracked)}这局${minutes}分钟就结束了，马还没出马厩，军师不予鉴定。`;
    return { speech: `${prefix}${summary}`, report: { title, summary, lines: [], mock } };
  }

  const choose = chooser(ranking.matchId);
  const best = ranking.horses[0];
  const worst = ranking.horses.at(-1)!;
  const summary = `${displayName(tracked)}这局${result}，打了${minutes}分钟。军师羽扇一挥，本局马匹鉴定如下。`;
  const roll = lines.map((line) => `${line.tier}，${line.champion}，${line.name}，${line.score.toFixed(1)}分。`).join("");
  let praiseText = praise(best, ranking.durationMinutes, ranking.won, choose);
  let roastText = worst === best ? "" : roast(worst, ranking.durationMinutes, ranking.won, choose);
  if (best === tracked) praiseText += "召唤军师的人自己就是特等马，军师怀疑你在刷存在感。";
  if (worst === tracked && worst !== best) roastText += "最离谱的是，这匹没有马，正是召唤军师的本人。";
  const speech = [prefix, summary, roll, praiseText, roastText].join("");
  return { speech, report: { title, summary, lines, praise: praiseText, roast: roastText || undefined, mock } };
}

