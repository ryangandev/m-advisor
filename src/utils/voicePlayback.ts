import { createReadStream } from "node:fs";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import ffmpegStatic from "ffmpeg-static";
import { VoiceChannel } from "discord.js";

if (ffmpegStatic) {
  process.env.FFMPEG_PATH ??= ffmpegStatic;
}

export async function playMp3InVoiceChannel(
  channel: VoiceChannel,
  audioPath: string,
  idleTimeoutMs: number,
): Promise<void> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer();
  const audioStream = createReadStream(audioPath);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const playbackError = new Promise<never>((_, reject) => {
      player.once("error", (error) => {
        reject(new Error(`Audio playback failed: ${error.message}`));
      });
    });
    const streamError = new Promise<never>((_, reject) => {
      audioStream.once("error", (error) => {
        reject(new Error(`Audio stream failed: ${error.message}`));
      });
    });

    connection.subscribe(player);
    player.play(
      createAudioResource(audioStream, {
        inputType: StreamType.Arbitrary,
      }),
    );

    await Promise.race([
      entersState(player, AudioPlayerStatus.Idle, idleTimeoutMs),
      playbackError,
      streamError,
    ]);
  } finally {
    player.stop(true);
    audioStream.destroy();
    connection.destroy();
  }
}
