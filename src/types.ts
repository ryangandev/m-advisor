import {
  ChatInputCommandInteraction,
  Collection,
  SlashCommandBuilder,
} from "discord.js";

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface ServerBinding {
  discordUserId: string;
  accounts: RiotAccount[];
}

export interface Summoner {
  id: string;
  accountId: string;
  puuid: string;
  name: string;
  profileIconId: number;
  summonerLevel: number;
}

export interface RankedEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface BotCommand {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void> | void;
}

export const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
export type Position = (typeof POSITIONS)[number];

/** Riot statistic names kept for scoring; each is optional because Riot omits fields in some games. */
export const PERFORMANCE_STATS = [
  "goldEarned", "totalMinionsKilled", "neutralMinionsKilled", "champExperience",
  "totalDamageDealtToChampions", "totalDamageTaken", "damageSelfMitigated",
  "damageDealtToBuildings", "visionScore", "wardsKilled", "detectorWardsPlaced",
  "timeCCingOthers", "totalHealsOnTeammates", "totalDamageShieldedOnTeammates",
  "turretTakedowns", "totalTimeSpentDead",
] as const;
/** Values that only exist in the participant's `challenges` object. */
export const CHALLENGE_STATS = [
  "effectiveHealAndShielding", "enemyChampionImmobilizations", "saveAllyFromDeath",
  "dragonTakedowns", "baronTakedowns", "riftHeraldTakedowns", "maxCsAdvantageOnLaneOpponent",
  "soloKills", "controlWardsPlaced", "wardTakedowns",
] as const;
export type PerformanceStat = (typeof PERFORMANCE_STATS)[number] | (typeof CHALLENGE_STATS)[number];
export type ParticipantPerformance = Partial<Record<PerformanceStat, number>>;

export interface MatchParticipant {
  puuid: string;
  riotIdGameName: string;
  championId: number;
  championName: string;
  /** Assigned team position, or null when Riot could not determine one. */
  position: Position | null;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  teamId: number;
  stats: ParticipantPerformance;
}

export interface TeamObjectives {
  teamId: number;
  dragon: number;
  baron: number;
  riftHerald: number;
  tower: number;
}

export interface MatchDetail {
  metadata: { matchId: string; participants: string[] };
  info: {
    queueId: number;
    gameDuration: number;
    /** A remake: the game ended through the early-surrender vote. */
    earlySurrender: boolean;
    /** The game was stopped without a result, for example by an anti-cheat exit, so neither team won. */
    aborted: boolean;
    teams: TeamObjectives[];
    participants: MatchParticipant[];
  };
}

declare module "discord.js" {
  interface Client {
    commands: Collection<string, BotCommand>;
  }
}
