import {
  MessageFlags,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { BotCommand } from "../types";
import { buildErrorEmbed } from "../utils/embeds";
import { getAnnouncerState, getPregameVoiceEnabled, setPregameVoiceEnabled, setVoiceStyle } from "../store/announcerStore";

const announcerCommand: BotCommand = {
  data: (new SlashCommandBuilder()
    .setName("announcer")
    .setDescription("Change the announcer voice style or the pre-game voice line")
    .addStringOption((option) =>
      option
        .setName("style")
        .setDescription("Announcer voice style")
        .setRequired(false)
        .addChoices(
          { name: "Sweet Girl", value: "sweet" },
          { name: "Old Man", value: "old" },
        ),
    )
    .addBooleanOption((option) =>
      option
        .setName("pregame_voice")
        .setDescription("Speak the pre-game line in voice (the text is always posted)")
        .setRequired(false),
    ) as SlashCommandOptionsOnlyBuilder) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildErrorEmbed("This command can only be used in a server.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const style = interaction.options.getString("style") as "sweet" | "old" | null;
    const pregameVoice = interaction.options.getBoolean("pregame_voice");
    if (style === null && pregameVoice === null) {
      await interaction.reply({
        embeds: [buildErrorEmbed("Choose at least one setting: style or pregame_voice.")],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (style !== null) setVoiceStyle(guildId, style);
    if (pregameVoice !== null) setPregameVoiceEnabled(guildId, pregameVoice);

    const label = getAnnouncerState(guildId).voiceStyle === "sweet" ? "Sweet Girl" : "Old Man";
    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("Announcer Updated")
      .setDescription([
        `Announcer voice: ${label}`,
        `Pre-game voice line: ${getPregameVoiceEnabled(guildId) ? "on" : "off (text only)"}`,
      ].join("\n"));

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

export default announcerCommand;
