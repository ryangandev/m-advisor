import {
  ChatInputCommandInteraction,
  GuildMember,
  SlashCommandBuilder,
  VoiceChannel,
} from "discord.js";
import { existsSync, unlinkSync } from "node:fs";
import { BotCommand } from "../types";
import { buildErrorEmbed } from "../utils/embeds";
import { isAdmin } from "../utils/permissions";
import { generateTTS } from "../utils/tts";
import { getTtsUserErrorMessage } from "../utils/userFacingErrors";
import { playMp3InVoiceChannel } from "../utils/voicePlayback";

const testvcCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("testvc")
    .setDescription("Test voice announcement (Admin only)"),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "Admin only.", ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || !(voiceChannel instanceof VoiceChannel)) {
      await interaction.reply({ content: "You need to be in a voice channel first.", ephemeral: true });
      return;
    }

    // Generate TTS before joining VC so the connection is only opened when audio is ready.
    const text = "Victory! Best player: not ry, with 8 kills, 2 deaths, and 5 assists. Worst player: Some Guy, with 1 kill, 12 deaths, and 0 assists.";
    let ttsPath: string | null = null;
    try {
      ttsPath = await generateTTS(text, "sweet");
    } catch (error) {
      console.error("testvc TTS generation failed:", error);
      await interaction.reply({
        embeds: [buildErrorEmbed(getTtsUserErrorMessage(error))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: `Joining ${voiceChannel.name}...`, ephemeral: true });

    try {
      await playMp3InVoiceChannel(voiceChannel, ttsPath, 30_000);
      await interaction.editReply({ content: "✅ Voice test complete!" });
    } catch (error) {
      console.error("testvc playback failed:", error);
      await interaction.editReply({
        embeds: [buildErrorEmbed("Voice playback failed. Check bot voice permissions and ffmpeg availability.")],
      });
    } finally {
      if (ttsPath && existsSync(ttsPath)) {
        try {
          unlinkSync(ttsPath);
        } catch (error) {
          console.error("testvc cleanup failed:", error);
        }
      }
    }
  },
};

export default testvcCommand;
