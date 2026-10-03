import { rm } from "node:fs/promises";
import type { VoiceChannel } from "discord.js";
import type { VoiceStyle } from "../store/announcerStore";
import { generateTTS } from "../utils/tts";
import { playAudioInVoiceChannel } from "../utils/voicePlayback";

// Five-horse reports run 60-100 seconds; the speech model caps output near 170 seconds.
export const PLAYBACK_TIMEOUT_MS = 240_000;

export class AnnouncementCancelledError extends Error {
  constructor() {
    super("Announcement cancelled because its monitoring session or voice channel changed.");
    this.name = "AnnouncementCancelledError";
  }
}

export interface VoiceAnnouncementDependencies {
  generate: (text: string, style: VoiceStyle) => Promise<string>;
  play: (channel: VoiceChannel, path: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
  cleanup: (path: string) => Promise<void>;
  logCleanupError?: (error: unknown) => void;
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
      const assertAllowed = () => {
        if (signal?.aborted || !canPlay()) throw new AnnouncementCancelledError();
      };
      assertAllowed();
      if (!resolveChannel()) throw new AnnouncementCancelledError();
      let output: string | undefined;
      let channelWatch: NodeJS.Timeout | undefined;
      try {
        output = await this.dependencies.generate(text, style);
        assertAllowed();
        // Automatic announcements follow the member's current channel after generation.
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
        await this.dependencies.play(channel, output, PLAYBACK_TIMEOUT_MS, playbackSignal);
        assertAllowed();
        if (playback.signal.aborted || resolveChannel()?.id !== channel.id) throw new AnnouncementCancelledError();
        return channel;
      } finally {
        if (channelWatch) clearInterval(channelWatch);
        if (output) {
          try { await this.dependencies.cleanup(output); }
          catch (error) {
            // Cleanup cannot turn completed playback into a retry and duplicate spoken audio.
            if (this.dependencies.logCleanupError) this.dependencies.logCleanupError(error);
            else console.error("Announcement audio cleanup failed:", error instanceof Error ? error.message : "Unknown error");
          }
        }
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
}

const announcements = new VoiceAnnouncementService({
  generate: generateTTS,
  play: playAudioInVoiceChannel,
  cleanup: async (path: string) => {
    await Promise.all([path, `${path}.json`, path.replace(/\.(wav|mp3)$/i, ".json")].map((file) => rm(file, { force: true })));
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
