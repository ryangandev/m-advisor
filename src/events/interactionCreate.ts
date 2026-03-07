import { Events, Interaction } from "discord.js";
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
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Command execution failed for /${interaction.commandName}:`, error);
      const errorEmbed = buildErrorEmbed(getCommandUserErrorMessage(error));

      if (interaction.replied) {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  },
};
