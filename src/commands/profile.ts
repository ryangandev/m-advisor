import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { getAccountByRiotId, getRankedEntries, getSummonerByPuuid } from "../utils/riotApi";
import { buildErrorEmbed, buildProfileEmbed } from "../utils/embeds";
import { BotCommand } from "../types";

const profileCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Look up a League of Legends player profile")
    .addStringOption((option) =>
      option
        .setName("riotid")
        .setDescription("Riot ID (e.g. Faker#KR1)")
        .setRequired(true),
    ) as SlashCommandOptionsOnlyBuilder) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const riotId = interaction.options.getString("riotid", true).trim();
    const parts = riotId.split("#");

    if (
      parts.length !== 2 ||
      parts[0].trim().length === 0 ||
      parts[1].trim().length === 0
    ) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("Invalid Riot ID format. Use GameName#TAG (example: Faker#KR1).")],
      });
      return;
    }

    const [gameName, tagLine] = parts.map((part) => part.trim());

    try {
      const account = await getAccountByRiotId(gameName, tagLine);
      const summoner = await getSummonerByPuuid(account.puuid);
      const rankedEntries = await getRankedEntries(summoner.id);
      const profileEmbed = buildProfileEmbed(riotId, summoner, rankedEntries);

      await interaction.editReply({ embeds: [profileEmbed] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
    }
  },
};

export default profileCommand;
