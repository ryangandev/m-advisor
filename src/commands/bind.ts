import {
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
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
      });
      return;
    }

    const user = interaction.options.getUser("user", true);
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

    let account;
    try {
      account = await getAccountByRiotId(gameName, tagLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      await interaction.editReply({ embeds: [buildErrorEmbed(message)] });
      return;
    }

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
          boundAccount.gameName.toLowerCase() === gameName.toLowerCase() &&
          boundAccount.tagLine.toLowerCase() === tagLine.toLowerCase(),
      );

      if (duplicate) {
        await interaction.editReply("This account is already bound.");
        return;
      }
    }

    const updatedAccounts = existingBinding
      ? [...existingBinding.accounts, account]
      : [account];

    setBinding(guildId, {
      discordUserId: user.id,
      accounts: updatedAccounts,
    });

    const normalizedRiotId = `${account.gameName}#${account.tagLine}`;
    const successEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Binding Updated")
      .setDescription(`Bound ${normalizedRiotId} to <@${user.id}>`);

    await interaction.editReply({ embeds: [successEmbed] });
  },
};

export default bindCommand;
