import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { BotCommand } from "../types";
import { buildErrorEmbed } from "../utils/embeds";
import { setVoiceStyle } from "../store/announcerStore";

const announcerCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("announcer")
    .setDescription("Change the announcer voice style")
    .addStringOption((option) =>
      option
        .setName("style")
        .setDescription("Announcer voice style")
        .setRequired(true)
        .addChoices(
          { name: "Sweet Girl", value: "sweet" },
          { name: "Old Man", value: "old" },
        ),
    ) as SlashCommandOptionsOnlyBuilder) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
        ephemeral: true,
      });
      return;
    }

    const style = interaction.options.getString("style", true) as "sweet" | "old";
    setVoiceStyle(guildId, style);

    const label = style === "sweet" ? "Sweet Girl" : "Old Man";
    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Announcer Updated")
      .setDescription(`Announcer voice set to ${label}`);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default announcerCommand;
