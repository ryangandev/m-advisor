import { Events, Interaction, MessageFlags } from "discord.js";
import { buildErrorEmbed } from "../utils/embeds";
import { getCommandUserErrorMessage } from "../utils/userFacingErrors";

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      const content = interaction.commandName === "testvc"
        ? "旧的 /testvc 已停用。请让管理员更新此服务器的 Bot 命令，然后使用 /testvoice 测试语音。"
        : "这个命令当前不可用。请让管理员更新此服务器的 Bot 命令后再试。";
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      // DiscordAPIError carries interaction-token URLs and request bodies.
      // Retain only the error class in logs; the reply uses the safe mapper below.
      console.error(`Command execution failed for /${interaction.commandName}:`, error instanceof Error ? error.name : "unknown error");
      const errorEmbed = buildErrorEmbed(getCommandUserErrorMessage(error));

      if (interaction.replied) {
        await interaction.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
      }
    }
  },
};
