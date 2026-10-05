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
import { stopPolling } from "../services/gameMonitor";
import { clearBinding, getBinding } from "../store/bindingStore";
import { logInfo } from "../utils/log";

const unbindCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("unbind")
    .setDescription("Remove all LoL account bindings from a Discord member (Admin only)")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Discord member to unbind")
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

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
      });
      return;
    }

    const user = interaction.options.getUser("user", true);
    const binding = getBinding(guildId);

    if (!binding || binding.discordUserId !== user.id) {
      await interaction.editReply("No binding found for that member.");
      return;
    }

    stopPolling(guildId, "the binding was removed");
    clearBinding(guildId);
    logInfo(`Removed the binding of ${binding.accounts.map((account) => `${account.gameName}#${account.tagLine}`).join(", ")} `
      + `from Discord member ${user.username}.`);

    const successEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Binding Removed")
      .setDescription(`Removed all bindings for <@${user.id}>`);

    await interaction.editReply({ embeds: [successEmbed] });
  },
};

export default unbindCommand;
