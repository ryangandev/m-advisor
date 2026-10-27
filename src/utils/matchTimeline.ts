import { RiotApiError, riotObject } from "../services/riotData";

/**
 * The parts of a match-v5 TimelineDto (`/lol/match/v5/matches/{matchId}/timeline`) used for match moments.
 * Riot timelines number participants 1-10; this keeps that numbering and maps it to PUUIDs.
 * All shape knowledge lives in this file, so an upstream change only needs this parser adjusted.
 */
export type EpicMonster = "BARON" | "ELDER" | "DRAGON" | "HERALD";
/** Summoner's Rift map coordinates, roughly 0 to 15000 on each axis. */
export interface MapPoint { x: number; y: number }

export interface TimelineKill {
  type: "kill";
  timestamp: number;
  /** 0 when a turret, minion or monster executed the victim. */
  killerId: number;
  victimId: number;
  assistIds: number[];
  /** Extra gold the killer earned for ending the victim's streak; 0 for an ordinary kill. */
  shutdownBounty: number;
  /** Where the victim died; null when Riot omits it, which keeps the death out of any fight. */
  position: MapPoint | null;
}
export interface TimelineMultiKill { type: "multiKill"; timestamp: number; killerId: number; length: number }
/** Riot's own first blood award, which skips executions. */
export interface TimelineFirstBlood { type: "firstBlood"; timestamp: number; killerId: number }
export interface TimelineMonster { type: "monster"; timestamp: number; killerId: number; teamId: number; monster: EpicMonster }
export type TimelineEvent = TimelineKill | TimelineMultiKill | TimelineFirstBlood | TimelineMonster;

export interface MatchTimeline {
  matchId: string;
  /** participantId (1-10) to PUUID. */
  participants: Map<number, string>;
  /** Supported events in game-time order; other event types are dropped. */
  events: TimelineEvent[];
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isParticipantId = (value: unknown): value is number => isCount(value) && value >= 1 && value <= 10;

function pointOf(value: unknown): MapPoint | null {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x, y } : null;
}

function monsterOf(event: Record<string, unknown>): EpicMonster | undefined {
  if (event.monsterType === "BARON_NASHOR") return "BARON";
  if (event.monsterType === "RIFTHERALD") return "HERALD";
  if (event.monsterType === "DRAGON") return event.monsterSubType === "ELDER_DRAGON" ? "ELDER" : "DRAGON";
  return undefined;
}

/** One event, or undefined for event types that are not used or that lack the fields a moment relies on. */
function parseEvent(value: unknown): TimelineEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const timestamp = event.timestamp;
  if (!isCount(timestamp)) return undefined;
  if (event.type === "CHAMPION_KILL") {
    if (!isParticipantId(event.victimId) || !isCount(event.killerId) || event.killerId > 10) return undefined;
    const assists = Array.isArray(event.assistingParticipantIds) ? event.assistingParticipantIds.filter(isParticipantId) : [];
    return {
      type: "kill", timestamp, killerId: event.killerId, victimId: event.victimId, assistIds: [...new Set(assists)].sort((a, b) => a - b),
      shutdownBounty: isCount(event.shutdownBounty) ? event.shutdownBounty : 0, position: pointOf(event.position),
    };
  }
  if (event.type === "CHAMPION_SPECIAL_KILL" && event.killType === "KILL_FIRST_BLOOD") {
    return isParticipantId(event.killerId) ? { type: "firstBlood", timestamp, killerId: event.killerId } : undefined;
  }
  if (event.type === "CHAMPION_SPECIAL_KILL" && event.killType === "KILL_MULTI") {
    if (!isParticipantId(event.killerId) || !isCount(event.multiKillLength) || event.multiKillLength < 2) return undefined;
    return { type: "multiKill", timestamp, killerId: event.killerId, length: Math.min(5, event.multiKillLength) };
  }
  if (event.type === "ELITE_MONSTER_KILL") {
    const monster = monsterOf(event);
    if (!monster || !isCount(event.killerId) || event.killerId > 10) return undefined;
    // killerTeamId names the team that took the monster even when no champion landed the last hit.
    const teamId = event.killerTeamId === 100 || event.killerTeamId === 200 ? event.killerTeamId : 0;
    return { type: "monster", timestamp, killerId: event.killerId, teamId, monster };
  }
  return undefined;
}

function parseParticipants(info: Record<string, unknown>, metadata: Record<string, unknown>): Map<number, string> {
  const participants = new Map<number, string>();
  if (Array.isArray(info.participants)) {
    for (const value of info.participants) {
      const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
      if (isParticipantId(entry.participantId) && typeof entry.puuid === "string" && entry.puuid) participants.set(entry.participantId, entry.puuid);
    }
  }
  // Older timelines omit info.participants; their metadata lists PUUIDs in participant ID order.
  if (participants.size === 0 && Array.isArray(metadata.participants)) {
    metadata.participants.slice(0, 10).forEach((puuid, index) => {
      if (typeof puuid === "string" && puuid) participants.set(index + 1, puuid);
    });
  }
  return participants;
}

/** Validates a match-v5 timeline body and keeps the events used for match moments. */
export function parseMatchTimeline(body: unknown, matchId: string): MatchTimeline {
  const raw = riotObject(body);
  const metadata = riotObject(raw.metadata);
  const info = riotObject(raw.info);
  if (metadata.matchId !== matchId) throw new RiotApiError("Riot API returned a mismatched timeline match ID.", "invalid_response");
  if (!Array.isArray(info.frames)) throw new RiotApiError("Riot API returned a timeline without frames.", "invalid_response");
  const participants = parseParticipants(info, metadata);
  if (participants.size === 0) throw new RiotApiError("Riot API returned a timeline without participants.", "invalid_response");
  const events: TimelineEvent[] = [];
  for (const frame of info.frames) {
    const frameEvents = frame && typeof frame === "object" ? (frame as Record<string, unknown>).events : undefined;
    if (!Array.isArray(frameEvents)) continue;
    for (const value of frameEvents) {
      const event = parseEvent(value);
      if (event) events.push(event);
    }
  }
  // A stable sort keeps Riot's order for events that share a timestamp.
  events.sort((a, b) => a.timestamp - b.timestamp);
  return { matchId, participants, events };
}
