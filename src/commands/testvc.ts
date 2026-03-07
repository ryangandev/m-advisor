import {
  ChatInputCommandInteraction,
  GuildMember,
  SlashCommandBuilder,
  VoiceChannel,
} from "discord.js";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import fs from "node:fs";
import { BotCommand } from "../types";
import { isAdmin } from "../utils/permissions";
import { generateTTS } from "../utils/tts";

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
    } catch (err) {
      await interaction.reply({ content: `❌ TTS generation failed: ${err instanceof Error ? err.message : err}`, ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Joining ${voiceChannel.name}...`, ephemeral: true });

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log("[testvc] Connection ready, starting playback immediately");

      const player = createAudioPlayer();
      connection.on("stateChange", (o, n) => {
        console.log(`[Connection] ${o.status} -> ${n.status}`);
      });
      player.on("stateChange", (o, n) => {
        console.log(`[Player] ${o.status} -> ${n.status}`);
      });
      player.on("error", (e) => {
        console.error("[Player error]", e.message, e.stack);
      });

      const resource = createAudioResource(ttsPath, {
        inputType: StreamType.Arbitrary,
      });
      connection.subscribe(player);
      player.play(resource);

      await entersState(player, AudioPlayerStatus.Idle, 30_000);
      await interaction.editReply({ content: "✅ Voice test complete!" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("testvc error:", msg);
      await interaction.editReply({ content: `❌ Failed: ${msg}` });
    } finally {
      connection.destroy();
      if (ttsPath && fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath);
    }
  },
};

export default testvcCommand;
