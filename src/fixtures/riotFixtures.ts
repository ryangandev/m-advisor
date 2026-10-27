import { createHash } from "node:crypto";
import type { PerformanceStat, Position, RankedEntry, RiotAccount, Summoner } from "../types";

export type MockOutcome = "win" | "loss";

export const MOCK_RIOT_IDS = [
  "MockWin#NA1", "MockLoss#NA1", "MockUnranked#NA1", "MockAlt#NA1",
  "MockRateLimit#NA1", "MockService#NA1", "MockAuth#NA1", "MockMissing#NA1", "MockNoTimeline#NA1",
] as const;

export interface MockProfile {
  account: RiotAccount;
  summoner: Summoner;
  ranked: RankedEntry[];
  outcome: MockOutcome;
  failureStatus?: number;
  /** Match timelines for this account fail with a simulated 404, while profiles and matches still work. */
  timelineMissing?: boolean;
}

export function buildMockProfile(gameName: string, tagLine: string): MockProfile {
  const normalizedId = `${gameName}#${tagLine}`.toLowerCase();
  const digest = createHash("sha256").update(normalizedId).digest("hex").slice(0, 24);
  const puuid = `MOCK-${digest}`;
  const name = gameName.toLowerCase();
  const account = { puuid, gameName, tagLine };
  const failureStatus = ({
    mockratelimit: 429, mockservice: 503, mockauth: 401, mockmissing: 404,
  } as Record<string, number>)[name];
  return {
    account,
    summoner: {
      id: `MOCK-SUMMONER-${digest}`, accountId: `MOCK-ACCOUNT-${digest}`, puuid,
      name: gameName, profileIconId: 29, summonerLevel: name === "mockalt" ? 88 : 245,
    },
    ranked: name === "mockunranked" ? [] : [
      { queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: 64, wins: 42, losses: 35 },
      { queueType: "RANKED_FLEX_SR", tier: "SILVER", rank: "I", leaguePoints: 28, wins: 17, losses: 12 },
    ],
    outcome: name === "mockloss" ? "loss" : "win",
    failureStatus,
    timelineMissing: name === "mocknotimeline" || undefined,
  };
}

/** A match-v5 response body, so mock matches exercise the same parser as real ones. */
export type RawMatch = { metadata: { matchId: string; participants: string[] }; info: Record<string, unknown> };
type RawStats = Partial<Record<PerformanceStat, number>>;

// Typical 30-minute values per position; each fixture player scales or overrides them.
const ROLE_BASE: Record<Position, RawStats> = {
  TOP: { goldEarned: 11400, totalMinionsKilled: 210, neutralMinionsKilled: 8, champExperience: 15500, totalDamageDealtToChampions: 17000, totalDamageTaken: 36000, damageSelfMitigated: 38000, damageDealtToBuildings: 4500, visionScore: 22, wardsKilled: 3, detectorWardsPlaced: 2, timeCCingOthers: 35, turretTakedowns: 3, enemyChampionImmobilizations: 14, maxCsAdvantageOnLaneOpponent: 15, soloKills: 1, riftHeraldTakedowns: 1, dragonTakedowns: 1 },
  JUNGLE: { goldEarned: 11100, totalMinionsKilled: 30, neutralMinionsKilled: 180, champExperience: 13500, totalDamageDealtToChampions: 18000, totalDamageTaken: 30000, damageSelfMitigated: 25000, damageDealtToBuildings: 2000, visionScore: 36, wardsKilled: 8, detectorWardsPlaced: 5, timeCCingOthers: 28, turretTakedowns: 2, enemyChampionImmobilizations: 12, maxCsAdvantageOnLaneOpponent: 12, dragonTakedowns: 3, baronTakedowns: 1, riftHeraldTakedowns: 1 },
  MIDDLE: { goldEarned: 12000, totalMinionsKilled: 225, neutralMinionsKilled: 10, champExperience: 15000, totalDamageDealtToChampions: 24000, totalDamageTaken: 20000, damageSelfMitigated: 9000, damageDealtToBuildings: 3500, visionScore: 24, wardsKilled: 4, detectorWardsPlaced: 2, timeCCingOthers: 22, turretTakedowns: 3, enemyChampionImmobilizations: 10, maxCsAdvantageOnLaneOpponent: 18, soloKills: 1, dragonTakedowns: 2 },
  BOTTOM: { goldEarned: 12800, totalMinionsKilled: 250, neutralMinionsKilled: 10, champExperience: 13000, totalDamageDealtToChampions: 25000, totalDamageTaken: 18000, damageSelfMitigated: 6000, damageDealtToBuildings: 6000, visionScore: 20, wardsKilled: 4, detectorWardsPlaced: 1, timeCCingOthers: 8, turretTakedowns: 4, enemyChampionImmobilizations: 3, maxCsAdvantageOnLaneOpponent: 20, dragonTakedowns: 2 },
  UTILITY: { goldEarned: 7800, totalMinionsKilled: 35, neutralMinionsKilled: 0, champExperience: 10500, totalDamageDealtToChampions: 8000, totalDamageTaken: 21000, damageSelfMitigated: 18000, damageDealtToBuildings: 800, visionScore: 70, wardsKilled: 10, detectorWardsPlaced: 7, timeCCingOthers: 45, totalHealsOnTeammates: 1500, totalDamageShieldedOnTeammates: 2500, effectiveHealAndShielding: 4000, turretTakedowns: 2, enemyChampionImmobilizations: 28, saveAllyFromDeath: 1, dragonTakedowns: 2 },
};

interface FixturePlayer {
  puuid: string; name: string; championId: number; championName: string; position: Position;
  kda: [number, number, number]; scale?: number; stats?: RawStats;
}

function rawParticipant(player: FixturePlayer, teamId: number, win: boolean): Record<string, unknown> {
  const stats: RawStats = {};
  for (const [key, value] of Object.entries(ROLE_BASE[player.position]) as [PerformanceStat, number][]) {
    stats[key] = Math.round(value * (player.scale ?? 1));
  }
  Object.assign(stats, player.stats);
  stats.controlWardsPlaced = stats.detectorWardsPlaced;
  stats.wardTakedowns = stats.wardsKilled;
  const { effectiveHealAndShielding, enemyChampionImmobilizations, saveAllyFromDeath, dragonTakedowns, baronTakedowns,
    riftHeraldTakedowns, maxCsAdvantageOnLaneOpponent, soloKills, controlWardsPlaced, wardTakedowns, ...top } = stats;
  const [kills, deaths, assists] = player.kda;
  return {
    puuid: player.puuid, riotIdGameName: player.name, championId: player.championId, championName: player.championName,
    teamPosition: player.position, individualPosition: player.position, teamId, win, kills, deaths, assists,
    totalTimeSpentDead: deaths * 25, ...top,
    challenges: { effectiveHealAndShielding, enemyChampionImmobilizations, saveAllyFromDeath, dragonTakedowns, baronTakedowns,
      riftHeraldTakedowns, maxCsAdvantageOnLaneOpponent, soloKills, controlWardsPlaced, wardTakedowns },
  };
}

export function buildMockMatch(profile: MockProfile, matchId: string, outcome: MockOutcome, endedAt = Date.now()): RawMatch {
  const won = outcome === "win";
  // Each player's takedowns stay within their team's kills, and each team's kills equal the other team's deaths.
  const allies: FixturePlayer[] = [
    { puuid: profile.account.puuid, name: profile.account.gameName, championId: 103, championName: "Ahri", position: "MIDDLE",
      kda: won ? [8, 2, 7] : [2, 7, 4], scale: won ? 1.15 : 0.8 },
    { puuid: "MOCK-ALLY-1", name: "模拟队友一", championId: 516, championName: "Ornn", position: "TOP",
      kda: won ? [2, 3, 9] : [2, 3, 6], scale: 1.05 },
    { puuid: "MOCK-ALLY-2", name: "模拟队友二", championId: 64, championName: "LeeSin", position: "JUNGLE",
      kda: won ? [6, 3, 9] : [6, 3, 3] },
    // A feeding carry with low damage, so ranking cannot simply follow kills.
    { puuid: "MOCK-ALLY-3", name: "模拟队友三", championId: 222, championName: "Jinx", position: "BOTTOM", kda: [1, 9, 2], scale: 0.6,
      stats: { visionScore: 8, maxCsAdvantageOnLaneOpponent: 0 } },
    // A support with no kills but excellent vision and protection.
    { puuid: "MOCK-ALLY-4", name: "模拟队友四", championId: 412, championName: "Thresh", position: "UTILITY",
      kda: won ? [0, 4, 16] : [0, 4, 9], scale: 1.25 },
  ];
  const enemies: FixturePlayer[] = [
    { puuid: "MOCK-ENEMY-1", name: "模拟对手一", championId: 238, championName: "Zed", position: "MIDDLE",
      // Deliberately give an enemy the top KDA in a loss fixture to catch incorrect victory inference.
      kda: won ? [6, 4, 8] : [14, 1, 8], scale: won ? 0.85 : 1.3 },
    { puuid: "MOCK-ENEMY-2", name: "模拟对手二", championId: 122, championName: "Darius", position: "TOP", kda: won ? [4, 3, 8] : [4, 3, 9] },
    { puuid: "MOCK-ENEMY-3", name: "模拟对手三", championId: 121, championName: "Khazix", position: "JUNGLE",
      kda: won ? [3, 4, 9] : [3, 3, 12], scale: 0.9 },
    { puuid: "MOCK-ENEMY-4", name: "模拟对手四", championId: 51, championName: "Caitlyn", position: "BOTTOM", kda: won ? [7, 3, 6] : [4, 2, 10] },
    { puuid: "MOCK-ENEMY-5", name: "模拟对手五", championId: 89, championName: "Leona", position: "UTILITY",
      kda: won ? [1, 3, 13] : [1, 2, 16], scale: 0.9 },
  ];
  const participants = [
    ...allies.map((player) => rawParticipant(player, 100, won)),
    ...enemies.map((player) => rawParticipant(player, 200, !won)),
  ];
  const team = (teamId: number, ahead: boolean) => ({
    teamId, win: teamId === 100 ? won : !won,
    objectives: { dragon: { kills: ahead ? 3 : 1 }, baron: { kills: ahead ? 1 : 0 }, riftHerald: { kills: ahead ? 1 : 0 }, tower: { kills: ahead ? 9 : 3 } },
  });
  return {
    metadata: { matchId, participants: participants.map((participant) => participant.puuid as string) },
    info: {
      queueId: 420, gameDuration: 1800, gameCreation: endedAt - 1_800_000, gameEndTimestamp: endedAt, endOfGameResult: "GameComplete",
      teams: [team(100, won), team(200, !won)], participants,
    },
  };
}

/** A match-v5 TimelineDto body, so mock timelines exercise the same parser as real ones. */
export type RawTimeline = { metadata: { dataVersion: string; matchId: string; participants: string[] }; info: Record<string, unknown> };

// Timeline slots: A is the tracked player's team, E the enemy team; T, J, M, B and S are the positions.
type Slot = `${"A" | "E"}${"T" | "J" | "M" | "B" | "S"}`;
type ScriptedKill = [seconds: number, killer: Slot, victim: Slot, assists: Slot[], shutdownBounty?: number];
type ScriptedMonster = [seconds: number, killer: Slot, monster: "DRAGON" | "BARON_NASHOR" | "RIFTHERALD"];
interface TimelineScript { kills: ScriptedKill[]; monsters: ScriptedMonster[] }

const SLOT_POSITIONS: Record<string, Position> = { T: "TOP", J: "JUNGLE", M: "MIDDLE", B: "BOTTOM", S: "UTILITY" };
const BARON_PIT = { x: 5007, y: 10471 };
const DRAGON_PIT = { x: 9866, y: 4414 };
// Lane spots where filler deaths happen, each more than 3500 units from both pits.
const LANE_SPOTS: Record<Position, { x: number; y: number }> = {
  TOP: { x: 1500, y: 12500 }, JUNGLE: { x: 7400, y: 7400 }, MIDDLE: { x: 7400, y: 7400 }, BOTTOM: { x: 13000, y: 1800 }, UTILITY: { x: 13000, y: 1800 },
};

// Hand-written key moments that respect every player's K/D/A in the fixture match; the remaining kills are
// filled in between them. In both games the support carries a won fight before an objective, and the feeding
// ADC falls first in a lost objective fight.
const TIMELINE_SCRIPTS: Record<MockOutcome, TimelineScript> = {
  win: {
    kills: [
      [185, "EJ", "AB", ["ES"]],
      [390, "AJ", "EM", ["AM", "AS"]],
      // A lost fight at the enemy's only dragon; the ADC falls first.
      [850, "EB", "AB", ["ES", "EJ"]], [858, "EM", "AS", ["EJ"]], [862, "AM", "EJ", ["AT", "AJ"]], [867, "ET", "AT", ["EM"]],
      // The baron fight: a mid triple kill with the support in on every takedown.
      [1470, "AM", "EB", ["AS", "AJ"]], [1476, "AM", "EM", ["AS"]], [1481, "AM", "ES", ["AS", "AT"]],
      [1485, "ET", "AB", []], [1490, "AJ", "ET", ["AS", "AT"]],
    ],
    monsters: [[480, "AJ", "DRAGON"], [620, "AJ", "RIFTHERALD"], [885, "EM", "DRAGON"], [1140, "AJ", "DRAGON"], [1520, "AJ", "BARON_NASHOR"], [1620, "AJ", "DRAGON"]],
  },
  loss: {
    kills: [
      [170, "EM", "AM", []],
      [570, "AJ", "ET", ["AT", "AS"]],
      // A won dragon fight with the support in on all three kills.
      [730, "AJ", "EB", ["AS", "AB", "AT"]], [736, "AB", "ES", ["AS", "AJ"]], [742, "EM", "AT", ["EJ"]], [747, "AJ", "EJ", ["AS", "AM"]],
      // The lost baron fight; the ADC falls first.
      [1360, "EJ", "AB", ["EM", "ES"]], [1366, "EM", "AS", ["ES"]], [1371, "EM", "AM", ["EJ"]], [1378, "EB", "AJ", ["ES", "ET"]],
      [1383, "AT", "ES", []],
      [1570, "AJ", "EM", ["AS"], 700],
    ],
    monsters: [[460, "EJ", "DRAGON"], [600, "EJ", "RIFTHERALD"], [770, "AJ", "DRAGON"], [1020, "EJ", "DRAGON"], [1410, "EJ", "BARON_NASHOR"], [1620, "EJ", "DRAGON"]],
  },
};

interface TimelineKillDraft { seconds: number; killerId: number; victimId: number; assists: number[]; shutdownBounty: number; scripted: boolean }
type Budget = { kills: number; deaths: number; assists: number };

/**
 * A deterministic timeline for a fixture match: scripted moments plus filler kills spaced far enough apart that
 * they never form a fight, so every participant's kills, deaths and assists match the match detail.
 */
export function buildMockTimeline(match: RawMatch): RawTimeline {
  const participants = match.info.participants as Array<Record<string, unknown>>;
  const ids = participants.map((_, index) => index + 1);
  const teamOf = (id: number) => participants[id - 1].teamId as number;
  const allyTeam = teamOf(1);
  const enemyTeam = 300 - allyTeam;
  const script = TIMELINE_SCRIPTS[participants[0].win === true ? "win" : "loss"];
  const slotId = (slot: Slot) => {
    const team = slot[0] === "A" ? allyTeam : enemyTeam;
    const index = participants.findIndex((player) => player.teamId === team && player.teamPosition === SLOT_POSITIONS[slot[1]]);
    if (index < 0) throw new Error(`The fixture match has no player for timeline slot ${slot}.`);
    return index + 1;
  };
  const remaining = new Map<number, Budget>(ids.map((id) => {
    const player = participants[id - 1];
    return [id, { kills: player.kills as number, deaths: player.deaths as number, assists: player.assists as number }];
  }));
  const spend = (kill: TimelineKillDraft) => {
    remaining.get(kill.killerId)!.kills--;
    remaining.get(kill.victimId)!.deaths--;
    for (const id of kill.assists) remaining.get(id)!.assists--;
  };
  const kills: TimelineKillDraft[] = script.kills.map(([seconds, killer, victim, assists, shutdownBounty = 0]) => {
    const kill = { seconds, killerId: slotId(killer), victimId: slotId(victim), assists: assists.map(slotId), shutdownBounty, scripted: true };
    spend(kill);
    return kill;
  });
  if ([...remaining.values()].some((left) => left.kills < 0 || left.deaths < 0 || left.assists < 0)) {
    throw new Error("The timeline script exceeds the fixture match statistics.");
  }

  // Filler kills sit at least 40 seconds from every scripted event and 29 seconds from each other.
  const scripted = [...script.kills.map(([seconds]) => seconds), ...script.monsters.map(([seconds]) => seconds)];
  const slots: number[] = [];
  for (let seconds = 240; seconds < 1780; seconds += 29) {
    if (scripted.every((time) => Math.abs(time - seconds) >= 40)) slots.push(seconds);
  }
  // Round-robin over a team's players, so one player's kills or deaths spread across the game.
  const queue = (team: number, field: "kills" | "deaths") => {
    const left = ids.filter((id) => teamOf(id) === team).map((id) => [id, remaining.get(id)![field]]);
    const order: number[] = [];
    while (left.some(([, count]) => count > 0)) {
      for (const entry of left) if (entry[1] > 0) { order.push(entry[0]); entry[1]--; }
    }
    return order;
  };
  const pairs = (team: number, other: number) => {
    const victims = queue(other, "deaths");
    return queue(team, "kills").map((killerId, index) => [killerId, victims[index]] as const);
  };
  const allyKills = pairs(allyTeam, enemyTeam);
  const enemyKills = pairs(enemyTeam, allyTeam);
  // Interleave both teams' kills in proportion, so neither team's kills bunch at one end of the game.
  const filler: Array<readonly [number, number]> = [];
  for (let a = 0, e = 0; a < allyKills.length || e < enemyKills.length;) {
    const takeAlly = e >= enemyKills.length || (a < allyKills.length && a * enemyKills.length <= e * allyKills.length);
    filler.push(takeAlly ? allyKills[a++] : enemyKills[e++]);
  }
  if (filler.length > slots.length) throw new Error("The mock timeline has too few free slots for its filler kills.");
  filler.forEach(([killerId, victimId], index) => {
    const team = teamOf(killerId);
    const teamKills = filler.slice(index).filter(([id]) => teamOf(id) === team);
    // Slack is how many of the team's remaining kills a teammate can still skip; zero means they must assist.
    const slack = (id: number) => teamKills.filter(([killer]) => killer !== id).length - remaining.get(id)!.assists;
    const mates = ids.filter((id) => teamOf(id) === team && id !== killerId && remaining.get(id)!.assists > 0)
      .sort((a, b) => slack(a) - slack(b) || a - b);
    const assistsLeft = mates.reduce((total, id) => total + remaining.get(id)!.assists, 0);
    const count = Math.max(Math.ceil(assistsLeft / teamKills.length), mates.filter((id) => slack(id) <= 0).length);
    const assists = mates.slice(0, Math.min(4, count)).sort((a, b) => a - b);
    const kill = { seconds: slots[index], killerId, victimId, assists, shutdownBounty: 0, scripted: false };
    spend(kill);
    kills.push(kill);
  });
  if ([...remaining.values()].some((left) => left.kills !== 0 || left.deaths !== 0 || left.assists !== 0)) {
    throw new Error("The mock timeline does not account for every kill, death and assist.");
  }
  kills.sort((a, b) => a.seconds - b.seconds);

  const events: Array<Record<string, unknown> & { timestamp: number }> = [{ type: "PAUSE_END", timestamp: 0, realTimestamp: 0 }];
  let streak = { killerId: 0, length: 0, at: -Infinity };
  kills.forEach((kill, index) => {
    const timestamp = kill.seconds * 1000;
    // Scripted kills near an objective happen around its pit; everything else happens in the victim's lane.
    const pit = kill.scripted ? script.monsters.find(([seconds]) => Math.abs(seconds - kill.seconds) <= 60) : undefined;
    const center = pit ? (pit[2] === "DRAGON" ? DRAGON_PIT : BARON_PIT) : LANE_SPOTS[participants[kill.victimId - 1].teamPosition as Position];
    const position = pit ? { x: center.x + ((index % 3) - 1) * 250, y: center.y + (index % 2) * 250 } : center;
    events.push({
      type: "CHAMPION_KILL", timestamp, killerId: kill.killerId, victimId: kill.victimId,
      ...(kill.assists.length ? { assistingParticipantIds: kill.assists } : {}),
      bounty: index === 0 ? 400 : 300, shutdownBounty: kill.shutdownBounty, killStreakLength: 0, position,
    });
    if (index === 0) events.push({ type: "CHAMPION_SPECIAL_KILL", timestamp, killType: "KILL_FIRST_BLOOD", killerId: kill.killerId, position });
    // A multi-kill continues while each kill follows the killer's previous one within 10 seconds.
    const continues = streak.killerId === kill.killerId && kill.seconds - streak.at <= 10;
    streak = { killerId: kill.killerId, length: continues ? streak.length + 1 : 1, at: kill.seconds };
    if (streak.length >= 2) {
      events.push({ type: "CHAMPION_SPECIAL_KILL", timestamp, killType: "KILL_MULTI", killerId: kill.killerId, multiKillLength: streak.length, position });
    }
  });
  for (const [seconds, killer, monster] of script.monsters) {
    const killerId = slotId(killer);
    events.push({
      type: "ELITE_MONSTER_KILL", timestamp: seconds * 1000 + 500, killerId, killerTeamId: teamOf(killerId), bounty: 0,
      monsterType: monster, ...(monster === "DRAGON" ? { monsterSubType: "FIRE_DRAGON" } : {}),
      position: monster === "DRAGON" ? DRAGON_PIT : BARON_PIT,
    });
  }
  // Towers follow the match's team objective counts; a tower event's teamId is the team that lost the tower.
  const winningTeam = participants.find((player) => player.win === true)?.teamId ?? 0;
  const towerTimes = [610, 790, 960, 1150, 1310, 1530, 1560, 1700, 1760, 1000, 1250, 700];
  for (const team of match.info.teams as Array<{ teamId: number; objectives: { tower: { kills: number } } }>) {
    const killers = ids.filter((id) => teamOf(id) === team.teamId);
    const offset = team.teamId === winningTeam ? 0 : 9;
    for (let index = 0; index < team.objectives.tower.kills; index++) {
      events.push({
        type: "BUILDING_KILL", timestamp: towerTimes[(offset + index) % towerTimes.length] * 1000 + 250, buildingType: "TOWER_BUILDING",
        killerId: killers[index % killers.length], teamId: 300 - team.teamId, laneType: ["BOT_LANE", "TOP_LANE", "MID_LANE"][index % 3],
        towerType: index < 3 ? "OUTER_TURRET" : index < 6 ? "INNER_TURRET" : "BASE_TURRET", bounty: 250, position: { x: 10504, y: 1029 },
      });
    }
  }
  const duration = (match.info.gameDuration as number) * 1000;
  events.push({ type: "GAME_END", timestamp: duration, realTimestamp: match.info.gameEndTimestamp, gameId: 0, winningTeam });
  events.sort((a, b) => a.timestamp - b.timestamp);

  // Each frame holds the events since the previous frame; per-participant frame statistics are not used.
  const frames = [];
  for (let start = -1, end = 0; start < duration; start = end, end = Math.min(end + 60_000, duration)) {
    frames.push({ timestamp: end, participantFrames: {}, events: events.filter((event) => event.timestamp > start && event.timestamp <= end) });
  }
  return {
    metadata: { dataVersion: "2", matchId: match.metadata.matchId, participants: [...match.metadata.participants] },
    info: {
      endOfGameResult: match.info.endOfGameResult, frameInterval: 60_000, gameId: 0, frames,
      participants: participants.map((player, index) => ({ participantId: index + 1, puuid: player.puuid })),
    },
  };
}
