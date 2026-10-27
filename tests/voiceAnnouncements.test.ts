import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceChannel } from "discord.js";
import { AnnouncementCancelledError, PLAYBACK_TIMEOUT_MS, VoiceAnnouncementService } from "../src/services/voiceAnnouncements";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const channel = (guildId = "guild", id = "channel"): VoiceChannel => ({ id, guild: { id: guildId } }) as VoiceChannel;
/** A fake transport that plays each chunk as soon as the service makes it available. */
const playEach = (onChunk: (path: string, target: VoiceChannel) => unknown = () => undefined) =>
  async (target: VoiceChannel, audio: AsyncIterable<string>) => {
    for await (const path of audio) await onChunk(path, target);
  };
const bars = (text: string) => text.split("|");

test("a guild's automatic and manual announcements serialize generation and playback", async () => {
  const speech = deferred<string>();
  const audio = deferred<void>();
  const events: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async (text) => { events.push(`generate:${text}`); return text === "first" ? speech.promise : "second.wav"; },
    play: playEach(async (path) => { events.push(`play:${path}`); if (path === "first.wav") await audio.promise; }),
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

test("speech is split into sentences by default and every chunk keeps the announcement's voice", async () => {
  const requests: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async (text, style) => { requests.push(`${style}:${text}`); return `${requests.length}.wav`; },
    play: playEach(),
    cleanup: async () => undefined,
  });
  await service.announce("guild", "军师羽扇一挥，本局马匹鉴定如下。特等马，锤石，模拟队友四，9.9分。", "sweet", () => channel());
  assert.deepEqual(requests, ["sweet:军师羽扇一挥，本局马匹鉴定如下。", "sweet:特等马，锤石，模拟队友四，9.9分。"]);
});

test("playback starts with the first chunk while later chunks generate in order, one at a time", async () => {
  const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
  const events: string[] = [];
  let active = 0;
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async (text) => {
      events.push(`generate:${text}`);
      active++;
      assert.equal(active, 1, "chunks never generate in parallel");
      try { return await pending[Number(text)].promise; } finally { active--; }
    },
    play: playEach((path) => { events.push(`play:${path}`); }),
    cleanup: async (path) => { events.push(`cleanup:${path}`); },
  });
  const result = service.announce("guild", "0|1|2", "old", () => channel());
  await flush();
  assert.deepEqual(events, ["generate:0"]);
  pending[0].resolve("0.wav");
  await flush();
  // Audio starts before the second chunk exists, and the second chunk starts without waiting for playback.
  assert.deepEqual([...events].sort(), ["generate:0", "generate:1", "play:0.wav"]);
  // A chunk that finishes early still plays after the one before it.
  pending[2].resolve("2.wav");
  await flush();
  assert.deepEqual([...events].sort(), ["generate:0", "generate:1", "play:0.wav"]);
  pending[1].resolve("1.wav");
  await result;
  assert.deepEqual(events.filter((event) => event.startsWith("play")), ["play:0.wav", "play:1.wav", "play:2.wav"]);
  assert.deepEqual(events.slice(-3), ["cleanup:0.wav", "cleanup:1.wav", "cleanup:2.wav"]);
});

test("a mid-stream generation failure stops playback, skips later chunks and cleans every chunk", async () => {
  const second = deferred<string>();
  const generated: string[] = [];
  const cleaned: string[] = [];
  let aborted: unknown;
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async (text) => {
      generated.push(text);
      if (text === "1") return second.promise;
      return `${text}.wav`;
    },
    play: async (_target, audio, _timeout, signal) => {
      signal!.addEventListener("abort", () => { aborted = signal!.reason; }, { once: true });
      for await (const path of audio) {
        // The first chunk is still playing when the second fails.
        if (path === "0.wav") await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        });
      }
    },
    cleanup: async (path) => { cleaned.push(path); },
  });
  const result = service.announce("guild", "0|1|2", "old", () => channel());
  await flush();
  second.reject(new Error("Local TTS worker exited."));
  await assert.rejects(result, /worker exited/);
  assert.match(String(aborted), /worker exited/, "playback is stopped instead of waiting for the current chunk");
  assert.deepEqual(generated, ["0", "1"]);
  assert.deepEqual(cleaned, ["0.wav"]);
});

test("a failed first chunk never joins a channel", async () => {
  let played = false;
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async () => { throw new Error("generation failed"); },
    play: async () => { played = true; },
    cleanup: async () => undefined,
  });
  await assert.rejects(service.announce("guild", "0|1", "old", () => channel()), /generation failed/);
  assert.equal(played, false);
});

test("eligibility is checked before each chunk, cancelling between chunks", async () => {
  let allowed = true;
  const generated: string[] = [];
  const cleaned: string[] = [];
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async (text) => {
      generated.push(text);
      // The member leaves while the first chunk is being generated and played.
      if (text === "0") allowed = false;
      return `${text}.wav`;
    },
    play: playEach(),
    cleanup: async (path) => { cleaned.push(path); },
  });
  const result = service.announce("guild", "0|1|2", "old", () => channel(), () => allowed);
  await assert.rejects(result, AnnouncementCancelledError);
  assert.deepEqual(generated, ["0"]);
  assert.deepEqual(cleaned, ["0.wav"]);
});

test("cancellation during playback waits for the chunk in progress and removes every chunk file", async () => {
  const controller = new AbortController();
  const second = deferred<string>();
  const generated: string[] = [];
  const cleaned: string[] = [];
  const playing = deferred<void>();
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async (text) => { generated.push(text); return text === "1" ? second.promise : `${text}.wav`; },
    play: async (_target, audio, _timeout, signal) => {
      for await (const _path of audio) {
        playing.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        });
      }
    },
    cleanup: async (path) => { cleaned.push(path); },
  });
  const result = service.announce("guild", "0|1|2", "old", () => channel(), () => true, controller.signal);
  const settled = result.then(() => "resolved", (error: unknown) => error);
  await playing.promise;
  controller.abort(new AnnouncementCancelledError());
  await flush();
  assert.deepEqual(cleaned, [], "the job waits for the generation request in progress");
  second.resolve("1.wav");
  assert.ok(await settled instanceof AnnouncementCancelledError);
  assert.deepEqual(generated, ["0", "1"], "no chunk starts after cancellation");
  assert.deepEqual(cleaned, ["0.wav", "1.wav"]);
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

test("automatic announcements resolve the member's new channel after the first chunk", async () => {
  const speech = deferred<string>();
  let current = channel("guild", "old");
  let played: string | undefined;
  const service = new VoiceAnnouncementService({
    generate: async () => speech.promise,
    play: playEach((_path, target) => { played = target.id; }),
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
    play: async (_target, _audio, timeoutMs) => { timeout = timeoutMs; },
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
    play: playEach(),
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

test("a channel move during playback aborts transport with a cancellation and cleans the file", async () => {
  let current = channel("guild", "first");
  const playing = deferred<void>();
  const cleaned: string[] = [];
  const service = new VoiceAnnouncementService({
    generate: async () => "active.wav",
    play: async (_target, _audio, _timeout, signal) => {
      playing.resolve();
      await new Promise<void>((_resolve, reject) => {
        // A real transport reports the abort with its own error.
        signal!.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true });
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
    play: playEach(),
    cleanup: async () => undefined,
  }, 1);
  const first = service.announce("guild", "first", "sweet", () => channel());
  await assert.rejects(service.announce("guild", "excess", "sweet", () => channel()), /queue is full/);
  speech.resolve("first.wav");
  await first;
  await service.announce("guild", "next", "sweet", () => channel());
});

test("cleanup failures are visible for each chunk without repeating completed playback", async () => {
  let plays = 0;
  const cleanupErrors: unknown[] = [];
  const service = new VoiceAnnouncementService({
    split: bars,
    generate: async (text) => `${text}.wav`,
    play: playEach(() => { plays++; }),
    cleanup: async (path) => { throw new Error(`disk failure ${path}`); },
    logCleanupError: (error) => { cleanupErrors.push(error); },
  });
  await service.announce("guild", "0|1", "sweet", () => channel());
  assert.equal(plays, 2);
  assert.deepEqual(cleanupErrors.map(String), ["Error: disk failure 0.wav", "Error: disk failure 1.wav"]);
});

test("empty speech fails before any generation", async () => {
  let generated = false;
  const service = new VoiceAnnouncementService({
    generate: async () => { generated = true; return "never.wav"; },
    play: playEach(),
    cleanup: async () => undefined,
  });
  await assert.rejects(service.announce("guild", "   ", "old", () => channel()), /empty/);
  assert.equal(generated, false);
});
