import { Events, Interaction } from "discord.js";
import { buildErrorEmbed } from "../utils/embeds";

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
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      const payload = { embeds: [buildErrorEmbed(message)] };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    }
  },
};
