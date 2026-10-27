import type { MatchDetail, MatchParticipant, Position } from "../types";
import { logWarn } from "../utils/log";
import type { EpicMonster, MapPoint, MatchTimeline } from "../utils/matchTimeline";
import { getMatchTimeline } from "../utils/riotMatchApi";
import { RiotApiError } from "./riotData";

/** A death joins a fight when it is no more than this long after the fight's previous death. */
export const FIGHT_GAP_MS = 15_000;
/** A fight never spans longer than this from its first death. */
export const FIGHT_MAX_SPAN_MS = 60_000;
/** A death joins a fight when it is this close, in map units, to the fight's previous death or its centroid. */
export const FIGHT_RADIUS = 3_000;
/** A fight counts from this many deaths. */
export const FIGHT_MIN_DEATHS = 3;
/** An epic monster taken this soon after a fight or a death is tied to it. */
export const OBJECTIVE_WINDOW_MS = 45_000;
/** A fight or death is at a monster when it is this close to the monster's pit. */
export const PIT_RADIUS = 3_500;
export const MIN_MULTI_KILL = 3;
export const MIN_FIGHT_TAKEDOWNS = 3;
export const MIN_SHUTDOWN_BOUNTY = 400;
// The same bar as announcementText's MIN_RANKED_MINUTES: shorter games are not judged, so need no timeline.
const MIN_JUDGED_SECONDS = 10 * 60;
/** Fixed pit centers on Summoner's Rift; the herald spawns in the baron pit. */
export const MONSTER_PITS: Record<EpicMonster, MapPoint> = {
  BARON: { x: 5007, y: 10471 }, HERALD: { x: 5007, y: 10471 }, DRAGON: { x: 9866, y: 4414 }, ELDER: { x: 9866, y: 4414 },
};

/**
 * A concrete moment from the timeline about one teammate. An enemy appears only as a position, never as a
 * name, PUUID or champion, so a line built from it cannot identify them.
 */
export type MatchEvent = { puuid: string; timestamp: number } & (
  | { kind: "multiKill"; kills: number }
  | { kind: "wonFight"; takedowns: number; monster?: EpicMonster }
  | { kind: "shutdown"; bounty: number; enemy: Position | null }
  | { kind: "firstBlood"; solo: boolean; enemy: Position | null }
  | { kind: "lostFightFirstDeath"; monster?: EpicMonster }
  | { kind: "objectiveDeath"; monster: EpicMonster }
  | { kind: "shutdownGiven"; bounty: number; enemy: Position | null }
  | { kind: "firstBloodGiven"; enemy: Position | null }
);
export type MatchEventKind = MatchEvent["kind"];
export type EventTone = "praise" | "roast";

const MONSTER_WEIGHT: Record<EpicMonster, number> = { BARON: 4, ELDER: 3, DRAGON: 2, HERALD: 1 };

/** The tone a moment supports and its rank within that tone; lower ranks are stronger. */
function eventRank(event: MatchEvent): [tone: EventTone, rank: number] {
  switch (event.kind) {
    case "multiKill": return ["praise", 0];
    case "wonFight": return ["praise", event.monster ? 1 : 3];
    case "shutdown": return ["praise", 2];
    case "firstBlood": return ["praise", 4];
    case "lostFightFirstDeath": return ["roast", event.monster ? 0 : 2];
    case "objectiveDeath": return ["roast", 1];
    case "shutdownGiven": return ["roast", 3];
    case "firstBloodGiven": return ["roast", 4];
  }
}

export function eventTone(event: MatchEvent): EventTone {
  return eventRank(event)[0];
}

function magnitude(event: MatchEvent): number {
  if (event.kind === "multiKill") return event.kills;
  if (event.kind === "wonFight") return event.takedowns;
  if (event.kind === "shutdown" || event.kind === "shutdownGiven") return event.bounty;
  return 0;
}

const monsterWeight = (event: MatchEvent) => "monster" in event && event.monster ? MONSTER_WEIGHT[event.monster] : 0;

/** The one moment worth citing for a teammate in the given tone, or undefined when none qualifies. */
export function strongestEvent(events: readonly MatchEvent[] | null | undefined, puuid: string, tone: EventTone): MatchEvent | undefined {
  return (events ?? []).filter((event) => event.puuid === puuid && eventTone(event) === tone)
    .sort((a, b) => eventRank(a)[1] - eventRank(b)[1] || monsterWeight(b) - monsterWeight(a)
      || magnitude(b) - magnitude(a) || a.timestamp - b.timestamp)[0];
}

interface Death {
  timestamp: number;
  victim: MatchParticipant;
  /** Undefined when a turret, minion or monster executed the victim. */
  killer?: MatchParticipant;
  assisters: MatchParticipant[];
  shutdownBounty: number;
  position: MapPoint | null;
}
interface Objective { timestamp: number; teamId: number; monster: EpicMonster }

const distance = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const nearPit = (point: MapPoint, monster: EpicMonster) => distance(point, MONSTER_PITS[monster]) <= PIT_RADIUS;
const MONSTER_ORDER = (a: Objective, b: Objective) => MONSTER_WEIGHT[b.monster] - MONSTER_WEIGHT[a.monster] || a.timestamp - b.timestamp;
const withMonster = (monster: EpicMonster | undefined) => monster ? { monster } : {};

function centroid(deaths: Death[]): MapPoint {
  const points = deaths.map((death) => death.position!);
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}

/**
 * Groups deaths into fights by time and place, so deaths in different lanes never chain into one teamfight.
 * A death without a position never joins a fight.
 */
function fights(deaths: Death[]): Death[][] {
  const groups: Death[][] = [];
  for (const death of deaths) {
    if (!death.position) continue;
    const reach = (group: Death[]) => Math.min(distance(death.position!, group.at(-1)!.position!), distance(death.position!, centroid(group)));
    const open = groups.filter((group) => death.timestamp - group.at(-1)!.timestamp <= FIGHT_GAP_MS
      && death.timestamp - group[0].timestamp <= FIGHT_MAX_SPAN_MS && reach(group) <= FIGHT_RADIUS);
    const nearest = open.sort((a, b) => reach(a) - reach(b))[0];
    if (nearest) nearest.push(death);
    else groups.push([death]);
  }
  return groups.filter((group) => group.length >= FIGHT_MIN_DEATHS);
}

function fightEvents(fight: Death[], objectives: Objective[], players: MatchParticipant[]): MatchEvent[] {
  const events: MatchEvent[] = [];
  const start = fight[0].timestamp;
  const until = fight.at(-1)!.timestamp + OBJECTIVE_WINDOW_MS;
  const center = centroid(fight);
  // A fight is named after a monster only when it happened at that monster's pit and the team took it.
  const monsterFor = (teamId: number) => objectives.filter((objective) => objective.teamId === teamId
    && objective.timestamp >= start && objective.timestamp <= until && nearPit(center, objective.monster)).sort(MONSTER_ORDER)[0]?.monster;
  const deathsOf = (teamId: number) => fight.filter((death) => death.victim.teamId === teamId).length;
  const enemyTeam = (teamId: number) => players.find((player) => player.teamId !== teamId)?.teamId ?? -1;
  // The first to fall in a fight their team did not win.
  const first = fight[0].victim;
  if (deathsOf(first.teamId) >= deathsOf(enemyTeam(first.teamId))) {
    events.push({ puuid: first.puuid, timestamp: start, kind: "lostFightFirstDeath", ...withMonster(monsterFor(enemyTeam(first.teamId))) });
  }
  // A survivor of a won fight who took part in most of its kills.
  for (const player of players) {
    const enemy = enemyTeam(player.teamId);
    if (deathsOf(enemy) <= deathsOf(player.teamId) || fight.some((death) => death.victim === player)) continue;
    const takedowns = fight.filter((death) => death.victim.teamId === enemy
      && (death.killer === player || death.assisters.includes(player))).length;
    if (takedowns >= MIN_FIGHT_TAKEDOWNS) {
      events.push({ puuid: player.puuid, timestamp: start, kind: "wonFight", takedowns, ...withMonster(monsterFor(player.teamId)) });
    }
  }
  return events;
}

/**
 * For each epic monster, the first teammate on the other team to die at its pit in the window before it was taken.
 * Nobody on that team may have died at the pit in the window before them, so "you fell first" is always true.
 */
function objectiveDeaths(deaths: Death[], objectives: Objective[]): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (const objective of objectives) {
    const atPit = deaths.filter((death) => death.victim.teamId !== objective.teamId && death.position && nearPit(death.position, objective.monster));
    const index = atPit.findIndex((death) => death.timestamp >= objective.timestamp - OBJECTIVE_WINDOW_MS && death.timestamp <= objective.timestamp);
    const first = atPit[index];
    if (!first || atPit.slice(0, index).some((death) => death.timestamp >= first.timestamp - OBJECTIVE_WINDOW_MS)) continue;
    events.push({ puuid: first.victim.puuid, timestamp: first.timestamp, kind: "objectiveDeath", monster: objective.monster });
  }
  return events;
}

/**
 * Every qualifying moment for every player in the match, deterministic for a given match and timeline.
 * Callers cite only allies, and an enemy is reduced to a position.
 */
export function extractMatchEvents(detail: MatchDetail, timeline: MatchTimeline): MatchEvent[] {
  if (timeline.matchId !== detail.metadata.matchId) return [];
  const players = detail.info.participants;
  const byPuuid = new Map(players.map((player) => [player.puuid, player]));
  const player = (participantId: number) => {
    const puuid = timeline.participants.get(participantId);
    return puuid === undefined ? undefined : byPuuid.get(puuid);
  };
  const deaths: Death[] = [];
  const objectives: Objective[] = [];
  const events: MatchEvent[] = [];
  let firstBlood: { timestamp: number; killer: MatchParticipant } | undefined;
  for (const event of timeline.events) {
    if (event.type === "kill") {
      const victim = player(event.victimId);
      if (!victim) continue;
      const killer = player(event.killerId);
      // A kill credited to the victim's own team (such as an execution) is not a champion kill.
      const enemyKiller = killer && killer.teamId !== victim.teamId ? killer : undefined;
      const assisters = enemyKiller
        ? event.assistIds.map(player).filter((ally): ally is MatchParticipant => ally?.teamId === enemyKiller.teamId) : [];
      deaths.push({ timestamp: event.timestamp, victim, killer: enemyKiller, assisters, shutdownBounty: event.shutdownBounty, position: event.position });
    } else if (event.type === "monster") {
      const teamId = event.teamId || player(event.killerId)?.teamId;
      if (teamId) objectives.push({ timestamp: event.timestamp, teamId, monster: event.monster });
    } else if (event.type === "firstBlood") {
      const killer = player(event.killerId);
      if (killer && !firstBlood) firstBlood = { timestamp: event.timestamp, killer };
    } else if (event.length >= MIN_MULTI_KILL) {
      const killer = player(event.killerId);
      if (killer) events.push({ puuid: killer.puuid, timestamp: event.timestamp, kind: "multiKill", kills: event.length });
    }
  }

  // Riot's first blood award; the victim comes from the champion kill it was awarded for.
  if (firstBlood) {
    const { killer, timestamp } = firstBlood;
    const kill = deaths.find((death) => death.killer === killer && Math.abs(death.timestamp - timestamp) <= 1_000);
    events.push({ puuid: killer.puuid, timestamp, kind: "firstBlood", solo: kill ? kill.assisters.length === 0 : false, enemy: kill?.victim.position ?? null });
    if (kill) events.push({ puuid: kill.victim.puuid, timestamp: kill.timestamp, kind: "firstBloodGiven", enemy: killer.position });
  }
  for (const { killer, victim, timestamp, shutdownBounty } of deaths) {
    if (killer && shutdownBounty >= MIN_SHUTDOWN_BOUNTY) {
      events.push({ puuid: killer.puuid, timestamp, kind: "shutdown", bounty: shutdownBounty, enemy: victim.position });
      events.push({ puuid: victim.puuid, timestamp, kind: "shutdownGiven", bounty: shutdownBounty, enemy: killer.position });
    }
  }
  events.push(...objectiveDeaths(deaths, objectives));
  for (const fight of fights(deaths)) events.push(...fightEvents(fight, objectives, players));
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

export interface FetchMatchEventsOptions {
  timeline?: (matchId: string) => Promise<MatchTimeline>;
  warn?: (message: string) => void;
}

/**
 * Timeline moments for an announcement, or null when the timeline is unavailable. It never throws, and the
 * timeline request itself is aborted after TIMELINE_TIMEOUT_MS, so a missing or slow timeline only means the
 * report falls back to its statistics.
 */
export async function fetchMatchEvents(matchId: string, detail: MatchDetail, options: FetchMatchEventsOptions = {}): Promise<MatchEvent[] | null> {
  const { info } = detail;
  if (info.aborted || info.earlySurrender || info.gameDuration < MIN_JUDGED_SECONDS) return null;
  try {
    return extractMatchEvents(detail, await (options.timeline ?? getMatchTimeline)(matchId));
  } catch (error) {
    const reason = error instanceof RiotApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "unknown error";
    (options.warn ?? logWarn)(`Timeline for match ${matchId} is unavailable (${reason}); the report uses end-of-game statistics only.`);
    return null;
  }
}
