import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { BotCommand } from "../types";
import { buildErrorEmbed } from "../utils/embeds";
import { isAdmin } from "../utils/permissions";
import { getBinding, setBinding } from "../store/bindingStore";
import { getAccountByRiotId } from "../utils/riotApi";
import { INVALID_RIOT_ID_MESSAGE, parseRiotId } from "../utils/riotId";
import { reconcileGuildMonitoring } from "../services/monitorLifecycle";
import { getRiotDataLabel } from "../services/riotData";
import { mergeBoundAccount } from "../utils/bindingAccounts";
import { getRiotUserErrorMessage } from "../utils/userFacingErrors";
import { assertRunning } from "../services/shutdownState";

const bindCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("bind")
    .setDescription("Bind a LoL account to a Discord member (Admin only)")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Discord member to bind")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("riotid")
        .setDescription("Riot ID (e.g. Faker#KR1)")
        .setRequired(true),
    ) as SlashCommandOptionsOnlyBuilder) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: "You need Administrator permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    assertRunning();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
      });
      return;
    }

    const user = interaction.options.getUser("user", true);
    const riotId = interaction.options.getString("riotid", true).trim();
    const parsedRiotId = parseRiotId(riotId);

    if (!parsedRiotId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(INVALID_RIOT_ID_MESSAGE)],
      });
      return;
    }

    const { gameName, tagLine } = parsedRiotId;

    let account;
    try {
      account = await getAccountByRiotId(gameName, tagLine);
    } catch (error) {
      await interaction.editReply({ embeds: [buildErrorEmbed(getRiotUserErrorMessage(error))] });
      return;
    }

    assertRunning();
    const existingBinding = getBinding(guildId);
    if (existingBinding && existingBinding.discordUserId !== user.id) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `This server already has a binding for <@${existingBinding.discordUserId}>. Use /unbind first.`,
          ),
        ],
      });
      return;
    }

    if (existingBinding) {
      const duplicate = existingBinding.accounts.some(
        (boundAccount) =>
          boundAccount.puuid === account.puuid &&
          boundAccount.gameName.toLowerCase() === account.gameName.toLowerCase() &&
          boundAccount.tagLine.toLowerCase() === account.tagLine.toLowerCase(),
      );

      if (duplicate) {
        await interaction.editReply("This account is already bound.");
        return;
      }
    }

    const updatedAccounts = mergeBoundAccount(existingBinding?.accounts || [], account);

    setBinding(guildId, {
      discordUserId: user.id,
      accounts: updatedAccounts,
    });

    await reconcileGuildMonitoring(interaction.client, guildId);
    assertRunning();

    const normalizedRiotId = `${account.gameName}#${account.tagLine}`;
    const successEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Binding Updated")
      .setFooter({ text: getRiotDataLabel() })
      .setDescription(`Bound ${normalizedRiotId} to <@${user.id}>`);

    await interaction.editReply({ embeds: [successEmbed] });
  },
};

export default bindCommand;
