import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { getAccountByRiotId, getRankedEntries, getSummonerByPuuid } from "../utils/riotApi";
import { buildErrorEmbed, buildProfileEmbed } from "../utils/embeds";
import { BotCommand } from "../types";
import { INVALID_RIOT_ID_MESSAGE, parseRiotId } from "../utils/riotId";
import { getRiotUserErrorMessage } from "../utils/userFacingErrors";

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
    const parsedRiotId = parseRiotId(riotId);

    if (!parsedRiotId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(INVALID_RIOT_ID_MESSAGE)],
      });
      return;
    }

    const { gameName, tagLine } = parsedRiotId;

    try {
      const account = await getAccountByRiotId(gameName, tagLine);
      const summoner = await getSummonerByPuuid(account.puuid);
      const rankedEntries = await getRankedEntries(account.puuid);
      const profileEmbed = buildProfileEmbed(`${account.gameName}#${account.tagLine}`, summoner, rankedEntries);

      await interaction.editReply({ embeds: [profileEmbed] });
    } catch (error) {
      await interaction.editReply({ embeds: [buildErrorEmbed(getRiotUserErrorMessage(error))] });
    }
  },
};

export default profileCommand;
