import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceChannel } from "discord.js";
import { AnnouncementCancelledError, PLAYBACK_TIMEOUT_MS, VoiceAnnouncementService } from "../src/services/voiceAnnouncements";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const channel = (guildId = "guild", id = "channel"): VoiceChannel => ({ id, guild: { id: guildId } }) as VoiceChannel;

test("a guild's automatic and manual announcements serialize generation and playback", async () => {
  const speech = deferred<string>();
  const audio = deferred<void>();
  const events: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async (text) => { events.push(`generate:${text}`); return text === "first" ? speech.promise : "second.wav"; },
    play: async (_target, path) => { events.push(`play:${path}`); if (path === "first.wav") await audio.promise; },
    cleanup: async (path) => { events.push(`cleanup:${path}`); },
  });
  const first = service.announce("guild", "first", "sweet", () => channel());
  const second = service.announce("guild", "second", "old", () => channel());
  await flush();
  assert.deepEqual(events, ["generate:first"]);
  speech.resolve("first.wav");
  await flush();
  assert.deepEqual(events, ["generate:first", "play:first.wav"]);
  audio.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["generate:first", "play:first.wav", "cleanup:first.wav", "generate:second", "play:second.wav", "cleanup:second.wav"]);
});

test("one guild's failure does not poison its queue or block another guild", async () => {
  const blocked = deferred<string>();
  const played: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async (text) => {
      if (text === "fail") throw new Error("generation failed");
      return text === "blocked" ? blocked.promise : `${text}.wav`;
    },
    play: async (target) => { played.push(target.guild.id); },
    cleanup: async () => undefined,
  });
  const failed = service.announce("guild", "fail", "sweet", () => channel());
  const afterFailure = service.announce("guild", "blocked", "sweet", () => channel());
  await assert.rejects(failed, /generation failed/);
  await service.announce("another", "parallel", "old", () => channel("another"));
  assert.deepEqual(played, ["another"]);
  blocked.resolve("unblocked.wav");
  await afterFailure;
  assert.deepEqual(played, ["another", "guild"]);
});

test("fixed channel eligibility changes after generation cancel before joining and clean audio", async () => {
  const speech = deferred<string>();
  let allowed = true;
  let played = false;
  const cleaned: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async () => speech.promise,
    play: async () => { played = true; },
    cleanup: async (path) => { cleaned.push(path); },
  });
  const result = service.announce("guild", "test", "sweet", () => channel(), () => allowed);
  await flush();
  allowed = false;
  speech.resolve("cancelled.wav");
  await assert.rejects(result, AnnouncementCancelledError);
  assert.equal(played, false);
  assert.deepEqual(cleaned, ["cancelled.wav"]);
});

test("automatic announcements resolve the member's new channel after generation", async () => {
  const speech = deferred<string>();
  let current = channel("guild", "old");
  let played: string | undefined;
  const service = new VoiceAnnouncementService({
    generate: async () => speech.promise,
    play: async (target) => { played = target.id; },
    cleanup: async () => undefined,
  });
  const result = service.announce("guild", "test", "old", () => current);
  await flush();
  current = channel("guild", "new");
  speech.resolve("moved.wav");
  assert.equal((await result).id, "new");
  assert.equal(played, "new");
});

test("playback allows a full-length five-horse report", async () => {
  let timeout = 0;
  const service = new VoiceAnnouncementService({
    generate: async () => "report.wav",
    play: async (_target, _path, timeoutMs) => { timeout = timeoutMs; },
    cleanup: async () => undefined,
  });
  await service.announce("guild", "report", "old", () => channel());
  // The local model caps speech near 170 seconds; reports must never be cut off by the transport timeout.
  assert.equal(timeout, PLAYBACK_TIMEOUT_MS);
  assert.ok(timeout >= 180_000);
});

test("cancelled queued jobs skip generation entirely", async () => {
  const speech = deferred<string>();
  const generated: string[] = [];
  const controller = new AbortController();
  const service = new VoiceAnnouncementService({
    generate: async (text) => { generated.push(text); return speech.promise; },
    play: async () => undefined,
    cleanup: async () => undefined,
  });
  const first = service.announce("guild", "first", "sweet", () => channel());
  const queued = service.announce("guild", "cancelled", "sweet", () => channel(), () => true, controller.signal);
  controller.abort();
  speech.resolve("first.wav");
  await first;
  await assert.rejects(queued, AnnouncementCancelledError);
  assert.deepEqual(generated, ["first"]);
});

test("a channel move during playback aborts transport and cleans the file", async () => {
  let current = channel("guild", "first");
  const playing = deferred<void>();
  const cleaned: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async () => "active.wav",
    play: async (_target, _path, _timeout, signal) => {
      playing.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    },
    cleanup: async (path) => { cleaned.push(path); },
  });
  const result = service.announce("guild", "test", "sweet", () => current);
  await playing.promise;
  current = channel("guild", "second");
  // Keep a referenced timer while the service's background channel watcher runs.
  const keepAlive = setTimeout(() => undefined, 500);
  try { await assert.rejects(result, AnnouncementCancelledError); }
  finally { clearTimeout(keepAlive); }
  assert.deepEqual(cleaned, ["active.wav"]);
});

test("queue capacity is bounded and rejects excess jobs", async () => {
  const speech = deferred<string>();
  const service = new VoiceAnnouncementService({
    generate: async () => speech.promise,
    play: async () => undefined,
    cleanup: async () => undefined,
  }, 1);
  const first = service.announce("guild", "first", "sweet", () => channel());
  await assert.rejects(service.announce("guild", "excess", "sweet", () => channel()), /queue is full/);
  speech.resolve("first.wav");
  await first;
  await service.announce("guild", "next", "sweet", () => channel());
});

test("cleanup failures are visible without repeating completed playback", async () => {
  let plays = 0;
  const cleanupErrors: unknown[] = [];
  const service = new VoiceAnnouncementService({
    generate: async () => "completed.wav",
    play: async () => { plays++; },
    cleanup: async () => { throw new Error("disk failure"); },
    logCleanupError: (error) => { cleanupErrors.push(error); },
  });
  await service.announce("guild", "test", "sweet", () => channel());
  assert.equal(plays, 1);
  assert.match(String(cleanupErrors[0]), /disk failure/);
});
