import type { MatchDetail, MatchParticipant, Position } from "../types";
import { logWarn } from "../utils/log";
import type { EpicMonster, MatchTimeline } from "../utils/matchTimeline";
import { getMatchTimeline } from "../utils/riotMatchApi";
import { RiotApiError } from "./riotData";

/** Deaths no more than this far apart belong to the same fight. */
export const FIGHT_GAP_MS = 15_000;
/** A run of deaths counts as a teamfight from this many deaths. */
export const FIGHT_MIN_DEATHS = 3;
/** An epic monster taken this soon after a fight or a death is tied to it. */
export const OBJECTIVE_WINDOW_MS = 45_000;
export const MIN_MULTI_KILL = 3;
export const MIN_FIGHT_TAKEDOWNS = 3;
export const MIN_SHUTDOWN_BOUNTY = 400;
/** A timeline that has not arrived by then is skipped, so it never holds up the announcement. */
export const TIMELINE_TIMEOUT_MS = 5_000;
// The same bar as announcementText's MIN_RANKED_MINUTES: shorter games are not judged, so need no timeline.
const MIN_JUDGED_SECONDS = 10 * 60;

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
}
interface Objective { timestamp: number; teamId: number; monster: EpicMonster }

/** The strongest epic monster the team took in the window, if any. */
function objectiveIn(objectives: Objective[], teamId: number, from: number, to: number): EpicMonster | undefined {
  return objectives.filter((objective) => objective.teamId === teamId && objective.timestamp >= from && objective.timestamp <= to)
    .sort((a, b) => MONSTER_WEIGHT[b.monster] - MONSTER_WEIGHT[a.monster] || a.timestamp - b.timestamp)[0]?.monster;
}

const withMonster = (monster: EpicMonster | undefined) => monster ? { monster } : {};

/** Splits deaths into runs whose consecutive deaths are at most FIGHT_GAP_MS apart. */
function fights(deaths: Death[]): Death[][] {
  const runs: Death[][] = [];
  for (const death of deaths) {
    const run = runs.at(-1);
    if (run && death.timestamp - run.at(-1)!.timestamp <= FIGHT_GAP_MS) run.push(death);
    else runs.push([death]);
  }
  return runs.filter((run) => run.length >= FIGHT_MIN_DEATHS);
}

function fightEvents(fight: Death[], objectives: Objective[], players: MatchParticipant[]): MatchEvent[] {
  const events: MatchEvent[] = [];
  const start = fight[0].timestamp;
  const until = fight.at(-1)!.timestamp + OBJECTIVE_WINDOW_MS;
  const deathsOf = (teamId: number) => fight.filter((death) => death.victim.teamId === teamId).length;
  const enemyTeam = (teamId: number) => players.find((player) => player.teamId !== teamId)?.teamId ?? -1;
  // The first to fall in a fight their team did not win.
  const first = fight[0].victim;
  if (deathsOf(first.teamId) >= deathsOf(enemyTeam(first.teamId))) {
    events.push({ puuid: first.puuid, timestamp: start, kind: "lostFightFirstDeath",
      ...withMonster(objectiveIn(objectives, enemyTeam(first.teamId), start, until)) });
  }
  // A survivor of a won fight who took part in most of its kills.
  for (const player of players) {
    const enemy = enemyTeam(player.teamId);
    if (deathsOf(enemy) <= deathsOf(player.teamId) || fight.some((death) => death.victim === player)) continue;
    const takedowns = fight.filter((death) => death.victim.teamId === enemy
      && (death.killer === player || death.assisters.includes(player))).length;
    if (takedowns >= MIN_FIGHT_TAKEDOWNS) {
      events.push({ puuid: player.puuid, timestamp: start, kind: "wonFight", takedowns,
        ...withMonster(objectiveIn(objectives, player.teamId, start, until)) });
    }
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
  for (const event of timeline.events) {
    if (event.type === "kill") {
      const victim = player(event.victimId);
      if (!victim) continue;
      const killer = player(event.killerId);
      // A kill credited to the victim's own team (such as an execution) is not a champion kill.
      const enemyKiller = killer && killer.teamId !== victim.teamId ? killer : undefined;
      const assisters = enemyKiller
        ? event.assistIds.map(player).filter((ally): ally is MatchParticipant => ally?.teamId === enemyKiller.teamId) : [];
      deaths.push({ timestamp: event.timestamp, victim, killer: enemyKiller, assisters, shutdownBounty: event.shutdownBounty });
    } else if (event.type === "monster") {
      const teamId = event.teamId || player(event.killerId)?.teamId;
      if (teamId) objectives.push({ timestamp: event.timestamp, teamId, monster: event.monster });
    } else if (event.length >= MIN_MULTI_KILL) {
      const killer = player(event.killerId);
      if (killer) events.push({ puuid: killer.puuid, timestamp: event.timestamp, kind: "multiKill", kills: event.length });
    }
  }

  const firstDeath = deaths[0];
  if (firstDeath?.killer) {
    const { killer, victim, timestamp } = firstDeath;
    events.push({ puuid: killer.puuid, timestamp, kind: "firstBlood", solo: firstDeath.assisters.length === 0, enemy: victim.position });
    events.push({ puuid: victim.puuid, timestamp, kind: "firstBloodGiven", enemy: killer.position });
  }
  for (const { killer, victim, timestamp, shutdownBounty } of deaths) {
    if (killer && shutdownBounty >= MIN_SHUTDOWN_BOUNTY) {
      events.push({ puuid: killer.puuid, timestamp, kind: "shutdown", bounty: shutdownBounty, enemy: victim.position });
      events.push({ puuid: victim.puuid, timestamp, kind: "shutdownGiven", bounty: shutdownBounty, enemy: killer.position });
    }
  }
  // Any death, including an execution, that the enemy turned into an epic monster.
  for (const { victim, timestamp } of deaths) {
    const enemy = players.find((other) => other.teamId !== victim.teamId)?.teamId;
    const monster = enemy === undefined ? undefined : objectiveIn(objectives, enemy, timestamp, timestamp + OBJECTIVE_WINDOW_MS);
    if (monster) events.push({ puuid: victim.puuid, timestamp, kind: "objectiveDeath", monster });
  }
  for (const fight of fights(deaths)) events.push(...fightEvents(fight, objectives, players));
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

export interface FetchMatchEventsOptions {
  timeline?: (matchId: string) => Promise<MatchTimeline>;
  warn?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Timeline moments for an announcement, or null when the timeline is unavailable. It never throws and gives up
 * after TIMELINE_TIMEOUT_MS, so a missing or slow timeline only means the report falls back to its statistics.
 */
export async function fetchMatchEvents(matchId: string, detail: MatchDetail, options: FetchMatchEventsOptions = {}): Promise<MatchEvent[] | null> {
  const { info } = detail;
  if (info.aborted || info.earlySurrender || info.gameDuration < MIN_JUDGED_SECONDS) return null;
  const warn = options.warn ?? logWarn;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RiotApiError("Riot API timeline request timed out.", "timeout")), options.timeoutMs ?? TIMELINE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const timeline = await Promise.race([(options.timeline ?? getMatchTimeline)(matchId), timeout]);
    return extractMatchEvents(detail, timeline);
  } catch (error) {
    const reason = error instanceof RiotApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "unknown error";
    warn(`Timeline for match ${matchId} is unavailable (${reason}); the report uses end-of-game statistics only.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
