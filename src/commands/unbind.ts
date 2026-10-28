import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { BotCommand } from "../types";
import { buildErrorEmbed, NO_MENTIONS } from "../utils/embeds";
import { isAdmin } from "../utils/permissions";
import { reconcileGuildMonitoring } from "../services/monitorLifecycle";
import { forgetMemberBaselines } from "../services/gameMonitor";
import { getTrackedMember, removeTrackedMember } from "../store/bindingStore";
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
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const user = interaction.options.getUser("user", true);
    const binding = getTrackedMember(guildId, user.id);

    if (!binding) {
      await interaction.editReply({ content: "No binding found for that member.", allowedMentions: NO_MENTIONS });
      return;
    }

    // Only this member leaves the session: a report speaking for them is cancelled, everyone else stays monitored.
    removeTrackedMember(guildId, user.id);
    forgetMemberBaselines(guildId, user.id);
    logInfo(`Removed the binding of ${binding.accounts.map((account) => `${account.gameName}#${account.tagLine}`).join(", ")} `
      + `from Discord member ${user.username}.`);
    await reconcileGuildMonitoring(interaction.client, guildId);

    const successEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Binding Removed")
      .setDescription(`Removed all bindings for <@${user.id}>`);

    await interaction.editReply({ embeds: [successEmbed], allowedMentions: NO_MENTIONS });
  },
};

export default unbindCommand;
