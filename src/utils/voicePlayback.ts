import { createReadStream, type ReadStream } from "node:fs";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
  type VoiceConnectionState,
} from "@discordjs/voice";
import ffmpegStatic from "ffmpeg-static";
import type { VoiceChannel } from "discord.js";

if (ffmpegStatic) process.env.FFMPEG_PATH ??= ffmpegStatic;

export interface VoicePlaybackDependencies {
  join: typeof joinVoiceChannel;
  createPlayer: typeof createAudioPlayer;
  createResource: typeof createAudioResource;
  enter: typeof entersState;
  read: (path: string) => ReadStream;
}

/** Injectable transport boundary for lifecycle tests without connecting to Discord. */
export function createVoicePlayback(dependencies: VoicePlaybackDependencies) {
  return async function play(
    channel: VoiceChannel,
    audioPath: string,
    playbackTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(playbackTimeoutMs) || playbackTimeoutMs < 1) throw new Error("Voice playback timeout must be a positive integer.");
    const operation = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
    let connection: VoiceConnection | undefined;
    let player: AudioPlayer | undefined;
    let audioStream: ReadStream | undefined;
    let resource: AudioResource | undefined;
    let closing = false;
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // Listeners may fire before the first entersState call starts awaiting.
    void failure.catch(() => undefined);
    const fail = (message: string, error?: Error) => {
      if (closing || operation.signal.aborted) return;
      const reason = new Error(message, { cause: error });
      rejectFailure(reason);
      operation.abort(reason);
    };
    const onConnectionState = (_old: VoiceConnectionState, next: VoiceConnectionState) => {
      if (next.status === VoiceConnectionStatus.Disconnected || next.status === VoiceConnectionStatus.Destroyed) {
        fail("Discord voice connection ended before playback completed.");
      }
    };
    const wait = async (target: VoiceConnection | AudioPlayer, status: VoiceConnectionStatus | AudioPlayerStatus, timeoutMs: number) => {
      const timeoutSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(timeoutMs)]);
      const entered = target === connection
        ? dependencies.enter(target as VoiceConnection, status as VoiceConnectionStatus, timeoutSignal)
        : dependencies.enter(target as AudioPlayer, status as AudioPlayerStatus, timeoutSignal);
      await Promise.race([entered, failure]);
    };

    try {
      connection = dependencies.join({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      connection.on("error", (error: Error) => fail("Discord voice connection failed.", error));
      connection.on("stateChange", onConnectionState);
      player = dependencies.createPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
      player.on("error", (error: Error) => fail("Discord audio playback failed.", error));
      audioStream = dependencies.read(audioPath);
      audioStream.on("error", (error: Error) => fail("Could not read the announcement audio.", error));

      await wait(connection, VoiceConnectionStatus.Ready, 15_000);
      operationSignal.throwIfAborted();
      if (!connection.subscribe(player)) throw new Error("Discord voice connection could not subscribe to audio.");
      resource = dependencies.createResource(audioStream, { inputType: StreamType.Arbitrary });
      resource.playStream.on("error", (error: Error) => fail("Could not decode the announcement audio.", error));
      const started = wait(player, AudioPlayerStatus.Playing, Math.min(playbackTimeoutMs, 15_000));
      void started.catch(() => undefined);
      player.play(resource);
      await started;
      // Waiting for Idle before observing Playing can treat the initial Idle state as success.
      await wait(player, AudioPlayerStatus.Idle, playbackTimeoutMs);
      operationSignal.throwIfAborted();
    } finally {
      closing = true;
      operation.abort(new Error("Voice playback finished."));
      player?.stop(true);
      resource?.playStream.destroy();
      audioStream?.destroy();
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      connection?.off("stateChange", onConnectionState);
      // Error handlers remain on disposed streams to absorb late decoder shutdown events.
    }
  };
}

export const playAudioInVoiceChannel = createVoicePlayback({
  join: joinVoiceChannel,
  createPlayer: createAudioPlayer,
  createResource: createAudioResource,
  enter: entersState,
  read: createReadStream,
});

