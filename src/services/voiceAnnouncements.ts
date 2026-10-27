import { rm } from "node:fs/promises";
import type { VoiceChannel } from "discord.js";
import type { VoiceStyle } from "../store/announcerStore";
import { splitSpeech } from "../utils/speechChunks";
import { generateTTS } from "../utils/tts";
import { playAudioInVoiceChannel } from "../utils/voicePlayback";
import { logError } from "../utils/log";

// Five-horse reports run 60-100 seconds; the speech model caps output near 170 seconds.
export const PLAYBACK_TIMEOUT_MS = 240_000;
/** One announcement, from its first request to the end of playback, including a cold model start. */
export const ANNOUNCEMENT_TIMEOUT_MS = 360_000;
/** A failed chunk is retried once before the announcement fails. */
const CHUNK_ATTEMPTS = 2;

export class AnnouncementCancelledError extends Error {
  constructor() {
    super("Announcement cancelled because its monitoring session or voice channel changed.");
    this.name = "AnnouncementCancelledError";
  }
}

/** The server already has as many announcements waiting as the queue allows; nothing was attempted. */
export class AnnouncementQueueFullError extends Error {
  constructor() {
    super("This server's voice announcement queue is full. Try again shortly.");
    this.name = "AnnouncementQueueFullError";
  }
}

export interface VoiceAnnouncementDependencies {
  /** Generates one chunk of speech and returns its audio file; an aborted signal should cancel the request. */
  generate: (text: string, style: VoiceStyle, signal: AbortSignal) => Promise<string>;
  /** Plays chunk files in order as they become available and resolves after the last one finishes. */
  play: (channel: VoiceChannel, audio: AsyncIterable<string>, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
  cleanup: (path: string) => Promise<void>;
  logCleanupError?: (error: unknown) => void;
  /** Splits speech into ordered chunks; defaults to sentence chunks. */
  split?: (text: string) => string[];
}

/**
 * Generates an announcement's chunks strictly in order, one request at a time, without waiting for playback.
 * A chunk starts only while the announcement is still allowed, a failed chunk is retried once,
 * and a final failure stops every later chunk.
 */
class ChunkedSpeech implements AsyncIterable<string> {
  private readonly chunks: Promise<string>[] = [];
  private readonly files: string[] = [];
  private readonly stopping = new AbortController();

  constructor(
    texts: string[],
    private readonly generate: (text: string, signal: AbortSignal) => Promise<string>,
    allowed: () => boolean,
    signal: AbortSignal,
    private readonly discard: (file: string) => void,
  ) {
    if (texts.length === 0) throw new Error("TTS text cannot be empty.");
    const generation = AbortSignal.any([signal, this.stopping.signal]);
    let previous: Promise<unknown> = Promise.resolve();
    for (const text of texts) {
      const chunk = previous.then(async () => {
        for (let attempt = 1; ; attempt++) {
          if (generation.aborted || !allowed()) throw new AnnouncementCancelledError();
          try {
            return await this.attempt(text, generation);
          } catch (error) {
            // One inline retry absorbs a transient worker failure before the announcement is given up.
            if (attempt >= CHUNK_ATTEMPTS || generation.aborted) throw error;
          }
        }
      });
      chunk.catch(() => undefined);
      this.chunks.push(chunk);
      previous = chunk;
    }
  }

  private attempt(text: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      // The announcement never waits for a request after an abort; audio that still arrives is removed.
      this.generate(text, signal).then((file) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          this.discard(file);
          return;
        }
        this.files.push(file);
        resolve(file);
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  /**
   * Resolves once the first two chunks exist, or the only chunk.
   * An early chunk that keeps failing is therefore never heard as a partial report.
   */
  async ready(): Promise<void> {
    await Promise.all(this.chunks.slice(0, 2));
  }

  /** Calls the listener with the first failure; later chunks share that failure. */
  onFailure(listener: (error: unknown) => void): void {
    this.chunks.at(-1)!.catch(listener);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (const chunk of this.chunks) yield await chunk;
  }

  /** Cancels the request in progress and every later chunk, then resolves with every generated file. */
  async stop(): Promise<string[]> {
    this.stopping.abort(new AnnouncementCancelledError());
    await Promise.allSettled(this.chunks);
    return this.files;
  }
}

/** A guild has one queue shared by automatic announcements and manual voice tests. */
export class VoiceAnnouncementService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly depths = new Map<string, number>();

  constructor(
    private readonly dependencies: VoiceAnnouncementDependencies,
    private readonly queueLimit = 8,
    private readonly timeoutMs = ANNOUNCEMENT_TIMEOUT_MS,
  ) {}

  announce(
    guildId: string,
    text: string,
    style: VoiceStyle,
    resolveChannel: () => VoiceChannel | null,
    canPlay: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<VoiceChannel> {
    if ((this.depths.get(guildId) ?? 0) >= this.queueLimit) {
      return Promise.reject(new AnnouncementQueueFullError());
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
      const texts = (this.dependencies.split ?? splitSpeech)(text);
      // One deadline covers every request and the whole playback of this announcement.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(
        new Error(`Voice announcement timed out after ${Math.round(this.timeoutMs / 1000)} seconds.`)), this.timeoutMs);
      const announcement = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const speech = new ChunkedSpeech(texts, (chunk, chunkSignal) => this.dependencies.generate(chunk, style, chunkSignal),
        allowed, announcement, (file) => void this.cleanup([file]));
      const playback = new AbortController();
      let channelWatch: NodeJS.Timeout | undefined;
      try {
        // Join once the first two chunks are ready; later chunks keep generating during playback.
        await speech.ready();
        assertAllowed();
        // Automatic announcements follow the member's current channel at that point.
        const channel = resolveChannel();
        if (!channel || channel.guild.id !== guildId) throw new AnnouncementCancelledError();
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
        await this.dependencies.play(channel, speech, PLAYBACK_TIMEOUT_MS, AbortSignal.any([announcement, playback.signal]));
        assertAllowed();
        if (playback.signal.aborted || resolveChannel()?.id !== channel.id) throw new AnnouncementCancelledError();
        return channel;
      } catch (error) {
        // Generation and transport report aborts in their own words; keep the reason that stopped the announcement.
        if (deadline.signal.aborted) throw deadline.signal.reason;
        if (playback.signal.aborted) throw playback.signal.reason;
        if (signal?.aborted) throw new AnnouncementCancelledError();
        throw error;
      } finally {
        clearTimeout(timer);
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
