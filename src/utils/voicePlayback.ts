import { execFile } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
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

/** Discord voice consumes 48 kHz, stereo, 16-bit little-endian PCM in 20 ms Opus frames. */
const PCM_BYTES_PER_MILLISECOND = 48 * 2 * 2;
export const PCM_FRAME_BYTES = 20 * PCM_BYTES_PER_MILLISECOND;
/** Silence inserted between sentence chunks, matching the model's own pauses at full stops. */
export const SENTENCE_PAUSE_MS = 350;
/** A short ramp at each chunk edge prevents a click if a chunk starts or ends away from zero. */
const FADE_FRAMES = 120;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** How long a voice resume or server change may keep the connection out of Ready before the announcement fails. */
export const RECONNECT_GRACE_MS = 5_000;

const execFileAsync = promisify(execFile);

/** Decodes one speech file to Discord's raw PCM format with FFmpeg's resampler. */
export async function decodeSpeechFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  if (!ffmpegStatic) throw new Error("FFmpeg is unavailable.");
  const { stdout } = await execFileAsync(ffmpegStatic, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path,
    "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "pipe:1",
  ], { encoding: "buffer", maxBuffer: MAX_DECODED_BYTES, signal, windowsHide: true });
  return stdout;
}

/**
 * Prepares one decoded chunk for the continuous stream: an optional leading pause, faded edges,
 * and silence up to a whole 20 ms frame so no partial frame waits inside the encoder for the next chunk.
 */
export function prepareSpeechPcm(pcm: Buffer, pauseMs = 0): Buffer {
  if (pcm.length === 0 || pcm.length % 4 !== 0) throw new Error("Announcement audio decoded to invalid PCM.");
  const pause = pauseMs * PCM_BYTES_PER_MILLISECOND;
  const length = Math.ceil((pause + pcm.length) / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
  const output = Buffer.alloc(length);
  pcm.copy(output, pause);
  const frames = pcm.length / 4;
  const fade = Math.min(FADE_FRAMES, Math.floor(frames / 2));
  for (let frame = 0; frame < fade; frame++) {
    const gain = frame / fade;
    for (const offset of [pause + frame * 4, pause + (frames - 1 - frame) * 4]) {
      output.writeInt16LE(Math.round(output.readInt16LE(offset) * gain), offset);
      output.writeInt16LE(Math.round(output.readInt16LE(offset + 2) * gain), offset + 2);
    }
  }
  return output;
}

export interface VoicePlaybackDependencies {
  join: typeof joinVoiceChannel;
  createPlayer: typeof createAudioPlayer;
  createResource: typeof createAudioResource;
  enter: typeof entersState;
  decode: (path: string, signal: AbortSignal) => Promise<Buffer>;
  /** Overrides RECONNECT_GRACE_MS, for tests. */
  reconnectGraceMs?: number;
}

/**
 * Plays ordered speech chunks as one continuous stream through one player and one resource.
 * Chunks are appended as soon as they are generated, so playback starts with the first sentence.
 * If generation falls behind, the player sends Opus silence until the next chunk arrives.
 * Injectable transport boundary for lifecycle tests without connecting to Discord.
 */
export function createVoicePlayback(dependencies: VoicePlaybackDependencies) {
  return async function play(
    channel: VoiceChannel,
    audio: AsyncIterable<string>,
    playbackTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(playbackTimeoutMs) || playbackTimeoutMs < 1) throw new Error("Voice playback timeout must be a positive integer.");
    const operation = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
    let connection: VoiceConnection | undefined;
    let player: AudioPlayer | undefined;
    let resource: AudioResource | undefined;
    const source = new PassThrough({ highWaterMark: 50 * PCM_FRAME_BYTES });
    let fed = false;
    let closing = false;
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // Listeners may fire before the first entersState call starts awaiting.
    void failure.catch(() => undefined);
    const failWith = (reason: Error) => {
      if (closing || operationSignal.aborted) return;
      rejectFailure(reason);
      operation.abort(reason);
    };
    const fail = (message: string, error?: Error) => failWith(new Error(message, { cause: error }));
    // A voice WebSocket resume or server change briefly leaves Ready for Signalling or Connecting.
    // The paused player keeps its place meanwhile, but the pause must stay bounded.
    const reconnectGraceMs = dependencies.reconnectGraceMs ?? RECONNECT_GRACE_MS;
    let wasReady = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const clearGrace = () => {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    };
    const onConnectionState = (_old: VoiceConnectionState, next: VoiceConnectionState) => {
      switch (next.status) {
        case VoiceConnectionStatus.Disconnected:
        case VoiceConnectionStatus.Destroyed:
          clearGrace();
          fail("Discord voice connection ended before playback completed.");
          break;
        case VoiceConnectionStatus.Signalling:
        case VoiceConnectionStatus.Connecting:
          // Joining is bounded by its own 15 second wait; the grace only covers a connection that was already Ready.
          if (wasReady && !graceTimer) graceTimer = setTimeout(() => fail("Discord voice connection did not recover in time."), reconnectGraceMs);
          break;
        case VoiceConnectionStatus.Ready:
          wasReady = true;
          clearGrace();
          // Never continue an announcement in a channel the bot was moved to.
          if (connection && connection.joinConfig.channelId !== channel.id) fail("Discord voice connection moved to another channel.");
          break;
      }
    };
    const wait = async (target: VoiceConnection | AudioPlayer, status: VoiceConnectionStatus | AudioPlayerStatus, timeoutMs: number) => {
      const timeoutSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(timeoutMs)]);
      const entered = target === connection
        ? dependencies.enter(target as VoiceConnection, status as VoiceConnectionStatus, timeoutSignal)
        : dependencies.enter(target as AudioPlayer, status as AudioPlayerStatus, timeoutSignal);
      await Promise.race([entered, failure]);
    };
    const chunks = audio[Symbol.asyncIterator]();
    // Waiting for a chunk that is still generating must not outlive an abort.
    const next = () => new Promise<IteratorResult<string>>((resolve, reject) => {
      const onAbort = () => reject(operationSignal.reason);
      operationSignal.addEventListener("abort", onAbort, { once: true });
      chunks.next().then(resolve, reject).finally(() => operationSignal.removeEventListener("abort", onAbort));
    });
    const decodeChunk = async (path: string, pauseMs: number) => {
      const pcm = prepareSpeechPcm(await dependencies.decode(path, operationSignal), pauseMs);
      operationSignal.throwIfAborted();
      return pcm;
    };
    const feedRest = async () => {
      for (let chunk = await next(); !chunk.done; chunk = await next()) {
        if (!source.write(await decodeChunk(chunk.value, SENTENCE_PAUSE_MS))) await once(source, "drain", { signal: operationSignal });
      }
      fed = true;
      source.end();
    };

    try {
      source.on("error", (error: Error) => fail("Could not stream the announcement audio.", error));
      // The first chunk is decoded before joining, so unreadable audio never causes a brief join.
      const first = await next();
      if (first.done) throw new Error("No announcement audio was generated.");
      source.write(await decodeChunk(first.value, 0));
      // Generation and speech failures keep their own error, such as a cancellation, for the caller.
      void feedRest().catch((error: unknown) => failWith(error instanceof Error ? error : new Error("Could not read the announcement audio.")));
      connection = dependencies.join({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      connection.on("error", (error: Error) => fail("Discord voice connection failed.", error));
      connection.on("stateChange", onConnectionState);
      // A gap while the next sentence is generated must not end playback, so missed frames never stop the player.
      // Pause keeps the stream through a brief reconnect; the grace, the playback timeout and cleanup bound the pause.
      player = dependencies.createPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: Infinity } });
      player.on("error", (error: Error) => fail("Discord audio playback failed.", error));

      await wait(connection, VoiceConnectionStatus.Ready, 15_000);
      wasReady = true;
      operationSignal.throwIfAborted();
      if (!connection.subscribe(player)) throw new Error("Discord voice connection could not subscribe to audio.");
      resource = dependencies.createResource(source, { inputType: StreamType.Raw });
      resource.playStream.on("error", (error: Error) => fail("Could not encode the announcement audio.", error));
      const started = wait(player, AudioPlayerStatus.Playing, Math.min(playbackTimeoutMs, 15_000));
      void started.catch(() => undefined);
      player.play(resource);
      await started;
      // Waiting for Idle before observing Playing can treat the initial Idle state as success.
      await wait(player, AudioPlayerStatus.Idle, playbackTimeoutMs);
      operationSignal.throwIfAborted();
      if (!fed) throw new Error("Announcement audio stopped before every sentence was played.");
    } finally {
      closing = true;
      clearGrace();
      operation.abort(new Error("Voice playback finished."));
      player?.stop(true);
      resource?.playStream.destroy();
      source.destroy();
      void chunks.return?.()?.catch(() => undefined);
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      connection?.off("stateChange", onConnectionState);
      // Error handlers remain on disposed streams to absorb late encoder shutdown events.
    }
  };
}

export const playAudioInVoiceChannel = createVoicePlayback({
  join: joinVoiceChannel,
  createPlayer: createAudioPlayer,
  createResource: createAudioResource,
  enter: entersState,
  decode: decodeSpeechFile,
});
