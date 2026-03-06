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

export interface ParticipantStats {
  puuid: string;
  summonerName: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  teamId: number;
}

export interface MatchDetail {
  metadata: { matchId: string; participants: string[] };
  info: {
    queueId: number;
    gameDuration: number;
    participants: Array<{
      puuid: string;
      riotIdGameName: string;
      kills: number;
      deaths: number;
      assists: number;
      win: boolean;
      teamId: number;
    }>;
  };
}

declare module "discord.js" {
  interface Client {
    commands: Collection<string, BotCommand>;
  }
}
