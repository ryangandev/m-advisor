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

declare module "discord.js" {
  interface Client {
    commands: Collection<string, BotCommand>;
  }
}
