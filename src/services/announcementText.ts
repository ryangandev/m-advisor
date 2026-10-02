import type { MatchDetail, ParticipantStats } from "../types";
import { getBestAndWorst } from "../utils/riotMatchApi";

/** Keep names from turning into Discord mentions or spoken control-like text. */
function readableName(name: string): string {
  return (typeof name === "string" ? name : "").replace(/[@<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "未知玩家";
}

export function buildMatchAnnouncement(detail: MatchDetail, trackedPuuid: string, mock: boolean): string {
  if (!Array.isArray(detail?.info?.participants) || detail.info.participants.length === 0) {
    throw new Error("The match does not contain valid participants.");
  }
  for (const participant of detail.info.participants) {
    if (!participant || typeof participant.puuid !== "string" || typeof participant.win !== "boolean" ||
      ![participant.kills, participant.deaths, participant.assists].every((stat) => Number.isSafeInteger(stat) && stat >= 0)) {
      throw new Error("The match contains invalid participant statistics.");
    }
  }
  const participants: ParticipantStats[] = detail.info.participants.map((participant) => ({
    ...participant,
    summonerName: readableName(participant.riotIdGameName),
  }));
  const tracked = participants.find((participant) => participant.puuid === trackedPuuid);
  if (!tracked) throw new Error("The tracked Riot account is missing from the match participants.");
  const { best, worst } = getBestAndWorst(participants);
  return [
    mock ? "模拟战报。" : "",
    `${tracked.summonerName}，本局${tracked.win ? "胜利" : "失利"}。`,
    `你的战绩是${tracked.kills}杀，${tracked.deaths}死，${tracked.assists}助攻。`,
    `全场表现最佳的是${best.summonerName}，${best.kills}杀，${best.deaths}死，${best.assists}助攻。`,
    `需要复盘的是${worst.summonerName}，${worst.kills}杀，${worst.deaths}死，${worst.assists}助攻。`,
    tracked.win ? "再接再厉，下一局继续拿下。" : "稳住，军师陪你下一局找回场子。",
  ].join("");
}
