import { rm } from "node:fs/promises";
import type { VoiceChannel } from "discord.js";
import type { VoiceStyle } from "../store/announcerStore";
import { splitSpeech } from "../utils/speechChunks";
import { generateTTS } from "../utils/tts";
import { playAudioInVoiceChannel } from "../utils/voicePlayback";
import { logError } from "../utils/log";

// Five-horse reports run 60-100 seconds; the speech model caps output near 170 seconds.
export const PLAYBACK_TIMEOUT_MS = 240_000;

export class AnnouncementCancelledError extends Error {
  constructor() {
    super("Announcement cancelled because its monitoring session or voice channel changed.");
    this.name = "AnnouncementCancelledError";
  }
}

export interface VoiceAnnouncementDependencies {
  /** Generates one chunk of speech and returns its audio file. */
  generate: (text: string, style: VoiceStyle) => Promise<string>;
  /** Plays chunk files in order as they become available and resolves after the last one finishes. */
  play: (channel: VoiceChannel, audio: AsyncIterable<string>, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
  cleanup: (path: string) => Promise<void>;
  logCleanupError?: (error: unknown) => void;
  /** Splits speech into ordered chunks; defaults to sentence chunks. */
  split?: (text: string) => string[];
}

/**
 * Generates an announcement's chunks strictly in order, one request at a time, without waiting for playback.
 * A chunk starts only while the announcement is still allowed, and a failure stops every later chunk.
 */
class ChunkedSpeech implements AsyncIterable<string> {
  private readonly chunks: Promise<string>[] = [];
  private readonly files: string[] = [];
  private stopped = false;

  constructor(texts: string[], generate: (text: string) => Promise<string>, allowed: () => boolean) {
    if (texts.length === 0) throw new Error("TTS text cannot be empty.");
    let previous: Promise<unknown> = Promise.resolve();
    for (const text of texts) {
      const chunk = previous.then(async () => {
        if (this.stopped || !allowed()) throw new AnnouncementCancelledError();
        const file = await generate(text);
        // Record every completed file, even after cancellation, so cleanup can remove it.
        this.files.push(file);
        return file;
      });
      chunk.catch(() => undefined);
      this.chunks.push(chunk);
      previous = chunk;
    }
  }

  first(): Promise<string> {
    return this.chunks[0];
  }

  /** Calls the listener with the first failure; later chunks share that failure. */
  onFailure(listener: (error: unknown) => void): void {
    this.chunks.at(-1)!.catch(listener);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (const chunk of this.chunks) yield await chunk;
  }

  /** Prevents new chunks and resolves with every generated file once the request in progress settles. */
  async stop(): Promise<string[]> {
    this.stopped = true;
    await Promise.allSettled(this.chunks);
    return this.files;
  }
}

/** A guild has one queue shared by automatic announcements and manual voice tests. */
export class VoiceAnnouncementService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly depths = new Map<string, number>();

  constructor(private readonly dependencies: VoiceAnnouncementDependencies, private readonly queueLimit = 8) {}

  announce(
    guildId: string,
    text: string,
    style: VoiceStyle,
    resolveChannel: () => VoiceChannel | null,
    canPlay: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<VoiceChannel> {
    if ((this.depths.get(guildId) ?? 0) >= this.queueLimit) {
      return Promise.reject(new Error("This server's voice announcement queue is full. Try again shortly."));
    }
    this.depths.set(guildId, (this.depths.get(guildId) ?? 0) + 1);
    const previous = this.queues.get(guildId) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(async () => {
      const allowed = () => !signal?.aborted && canPlay();
      const assertAllowed = () => {
        if (!allowed()) throw new AnnouncementCancelledError();
      };
      assertAllowed();
      if (!resolveChannel()) throw new AnnouncementCancelledError();
      const speech = new ChunkedSpeech((this.dependencies.split ?? splitSpeech)(text),
        (chunk) => this.dependencies.generate(chunk, style), allowed);
      let channelWatch: NodeJS.Timeout | undefined;
      try {
        // Join as soon as the first chunk is ready; later chunks keep generating during playback.
        await speech.first();
        assertAllowed();
        // Automatic announcements follow the member's current channel after the first chunk.
        const channel = resolveChannel();
        if (!channel || channel.guild.id !== guildId) throw new AnnouncementCancelledError();
        const playback = new AbortController();
        const playbackSignal = signal ? AbortSignal.any([signal, playback.signal]) : playback.signal;
        channelWatch = setInterval(() => {
          try {
            const current = resolveChannel();
            if (!canPlay() || !current || current.id !== channel.id) playback.abort(new AnnouncementCancelledError());
          } catch (error) {
            playback.abort(error);
          }
        }, 100);
        channelWatch.unref();
        // A later chunk's failure stops playback at once; the match stays eligible for a full retry.
        speech.onFailure((error) => playback.abort(error));
        try {
          await this.dependencies.play(channel, speech, PLAYBACK_TIMEOUT_MS, playbackSignal);
        } catch (error) {
          // The transport reports an abort in its own words; keep the reason that stopped playback.
          if (playback.signal.aborted) throw playback.signal.reason;
          if (signal?.aborted) throw new AnnouncementCancelledError();
          throw error;
        }
        assertAllowed();
        if (playback.signal.aborted || resolveChannel()?.id !== channel.id) throw new AnnouncementCancelledError();
        return channel;
      } finally {
        if (channelWatch) clearInterval(channelWatch);
        await this.cleanup(await speech.stop());
      }
    });
    this.queues.set(guildId, job);
    void job.finally(() => {
      this.depths.set(guildId, (this.depths.get(guildId) ?? 1) - 1);
      if (this.queues.get(guildId) === job) {
        this.queues.delete(guildId);
        this.depths.delete(guildId);
      }
    }).catch(() => undefined);
    return job;
  }

  private async cleanup(files: string[]): Promise<void> {
    const results = await Promise.allSettled(files.map((file) => this.dependencies.cleanup(file)));
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      // Cleanup cannot turn completed playback into a retry and duplicate spoken audio.
      if (this.dependencies.logCleanupError) this.dependencies.logCleanupError(result.reason);
      else logError(`Announcement audio cleanup failed: ${result.reason instanceof Error ? result.reason.message : "Unknown error"}`);
    }
  }
}

const announcements = new VoiceAnnouncementService({
  generate: generateTTS,
  play: playAudioInVoiceChannel,
  cleanup: async (path: string) => {
    await Promise.all([path, `${path}.json`, path.replace(/\.wav$/i, ".json")].map((file) => rm(file, { force: true })));
  },
});

export async function announceTextInVoiceChannel(
  channel: VoiceChannel,
  text: string,
  style: VoiceStyle,
  canPlay?: () => boolean,
): Promise<void> {
  await announcements.announce(channel.guild.id, text, style, () => channel, canPlay);
}

export function announceTextToCurrentChannel(
  guildId: string,
  text: string,
  style: VoiceStyle,
  resolveChannel: () => VoiceChannel | null,
  canPlay?: () => boolean,
  signal?: AbortSignal,
): Promise<VoiceChannel> {
  return announcements.announce(guildId, text, style, resolveChannel, canPlay, signal);
}
