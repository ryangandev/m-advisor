import {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Collection,
  SlashCommandBuilder,
} from "discord.js";

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

/** One Discord member whose Riot accounts the bot watches, with accounts in bind order. */
export interface TrackedMember {
  discordUserId: string;
  accounts: RiotAccount[];
}

/** Every tracked member of one server, in the order they were bound. */
export interface GuildTracking {
  guildId: string;
  members: TrackedMember[];
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

/** The two ranked queues whose league-v4 entries carry LP: queue 420 is solo/duo and queue 440 is flex. */
export const RANKED_QUEUE_TYPES = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"] as const;
export type RankedQueueType = (typeof RANKED_QUEUE_TYPES)[number];

export interface BotCommand {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** Suggests values for an option marked with autocomplete while the user types. */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  /** Buttons whose custom ID is this prefix followed by a colon are routed to handleButton. */
  componentPrefix?: string;
  handleButton?: (interaction: ButtonInteraction) => Promise<void>;
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
    /** Riot's game version string such as "16.19.123.4567", when the match data has one. */
    gameVersion?: string;
    gameDuration: number;
    /** Unix milliseconds when the game ended, or null when the match data omits it. */
    gameEndTimestamp: number | null;
    /** A remake: the game ended through the early-surrender vote. */
    earlySurrender: boolean;
    /** The game was stopped without a result, for example by an anti-cheat exit, so neither team won. */
    aborted: boolean;
    teams: TeamObjectives[];
    participants: MatchParticipant[];
  };
}

/**
 * One player of a game in progress, from spectator-v5. Riot's `riotId` is deliberately not kept: the bot only ever
 * shows names from stored bindings. `puuid` is null when the participant has no usable account: a bot, or a human
 * whose PUUID Riot omitted. A champion or spell Riot omitted is 0.
 */
export interface ActiveGameParticipant {
  puuid: string | null;
  teamId: number;
  championId: number;
  /** Summoner spell IDs; Smite is 11. */
  spell1Id: number;
  spell2Id: number;
  bot: boolean;
}

/** A game in progress (or loading) from spectator-v5, reduced to the fields the game-start watcher relies on. */
export interface ActiveGame {
  /** The numeric part of the match-v5 ID `NA1_<gameId>`. */
  gameId: number;
  /** Unix milliseconds when the game started; 0 while it is still loading. */
  gameStartTime: number;
  /** Seconds the game has run. */
  gameLength: number;
  /** Null when Riot omitted it or sent something unusable (custom games, Practice Tool); see `isAnnouncedGame`. */
  gameQueueConfigId: number | null;
  mapId: number | null;
  platformId: string | null;
  /** Only participants that could be placed on team 100 or 200. */
  participants: ActiveGameParticipant[];
  /** Simulated data: the game came from the mock provider and its match ID is `mockMatchId`. */
  mock: boolean;
  mockMatchId?: string;
}

declare module "discord.js" {
  interface Client {
    commands: Collection<string, BotCommand>;
  }
}
