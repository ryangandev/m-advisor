import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Client, VoiceChannel, VoiceState } from "discord.js";
import type { TrackedMember } from "../src/types";
import { GameMonitor } from "../src/services/gameMonitor";
import { MonitorLifecycle } from "../src/services/monitorLifecycle";
import { closeDatabase } from "../src/store/database";

const monitors: GameMonitor[] = [];
let originalDatabasePath: string | undefined;
beforeEach(() => {
  originalDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = ":memory:";
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stopAll();
  closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

/** Voice events for tracked and untracked members, wired through the real lifecycle into a real monitor with fake Riot I/O. */
function presence(guildId: string) {
  const members: TrackedMember[] = [
    { discordUserId: "alice-id", accounts: [{ puuid: "alice", gameName: "alice", tagLine: "NA1" }] },
    { discordUserId: "bob-id", accounts: [{ puuid: "bob", gameName: "bob", tagLine: "NA1" }] },
  ];
  const location = new Map<string, string | null>();
  const syncs: string[][] = [];
  const lookups: string[] = [];
  /** A pending lookup per member, so tests can hold one reconcile's view of voice. */
  const slowFetch = new Map<string, Promise<void>>();
  const guild = {
    id: guildId,
    members: {
      fetch: async (id: string) => {
        const channelId = location.get(id) ?? null;
        await slowFetch.get(id);
        return { voice: { channelId } };
      },
    },
  };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } } as unknown as Client;
  const monitor = new GameMonitor({
    latest: async (puuid) => { lookups.push(puuid); return "historical-match"; },
    detail: async () => { throw new Error("No match should be announced in presence tests."); },
    members: () => members,
    resolveChannel: (_client, _guildId, userId) => {
      const channelId = location.get(userId);
      return channelId ? ({ id: channelId, guild: { id: guildId }, members: new Map() } as unknown as VoiceChannel) : null;
    },
    announce: async () => { throw new Error("No speech in presence tests."); },
    mock: () => true,
    log: (error) => { throw error; },
    info: () => {},
  });
  monitors.push(monitor);
  const lifecycle = new MonitorLifecycle({
    members: () => members,
    sync: (syncClient, syncGuildId, memberIds) => { syncs.push(memberIds); monitor.sync(syncClient, syncGuildId, memberIds); },
    stop: (stopGuildId, reason) => monitor.stop(stopGuildId, reason),
    stopping: () => false,
    log: (message) => { throw new Error(message); },
  });
  const state = (id: string, channelId: string | null, extra: Partial<Record<"selfMute", boolean>> = {}) =>
    ({ id, channelId, guild: { id: guildId }, client, ...extra }) as unknown as VoiceState;
  /** Move a member in the cache first, as discord.js does, then deliver the event. */
  const voice = (id: string, channelId: string | null) => {
    const before = location.get(id) ?? null;
    location.set(id, channelId);
    return lifecycle.voiceStateChanged(state(id, before), state(id, channelId));
  };
  return { monitor, lifecycle, client, location, syncs, lookups, slowFetch, state, voice, status: () => monitor.status(guildId) };
}

test("an untracked member and a mute toggle do nothing", async () => {
  const bot = presence("ignored-guild");
  assert.equal(bot.voice("stranger-id", "x"), undefined);
  bot.location.set("alice-id", "x");
  assert.equal(bot.lifecycle.voiceStateChanged(bot.state("alice-id", "x"), bot.state("alice-id", "x", { selfMute: true })), undefined);
  assert.deepEqual(bot.syncs, []);
  assert.equal(bot.status().active, false);
});

test("a tracked member joining starts monitoring for them", async () => {
  const bot = presence("join-guild");
  await bot.voice("alice-id", "x");
  assert.deepEqual(bot.syncs, [["alice-id"]]);
  assert.equal(bot.status().active, true);
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id"]);
});

test("moving between channels does not change the session", async () => {
  const bot = presence("move-guild");
  await bot.voice("alice-id", "x");
  await bot.monitor.poll(bot.client, "move-guild");
  const before = bot.status();
  const lookups = bot.lookups.length;
  await bot.voice("alice-id", "y");
  const after = bot.status();
  assert.equal(after.startedAt, before.startedAt);
  assert.deepEqual(after.presentMemberIds, ["alice-id"]);
  await bot.monitor.poll(bot.client, "move-guild");
  assert.equal(bot.lookups.length, lookups + 1, "only the next regular poll, no new baseline");
});

test("one of two members leaving keeps monitoring the other; the last one leaving stops it", async () => {
  const bot = presence("leave-guild");
  await bot.voice("alice-id", "x");
  await bot.voice("bob-id", "y");
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id", "bob-id"]);
  await bot.voice("bob-id", null);
  assert.deepEqual(bot.syncs.at(-1), ["alice-id"]);
  assert.equal(bot.status().active, true);
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id"]);
  await bot.voice("alice-id", null);
  assert.deepEqual(bot.syncs.at(-1), []);
  assert.equal(bot.status().active, false);
});

test("overlapping reconciles apply in the order they were requested", async () => {
  const bot = presence("overlap-guild");
  const held = deferred<void>();
  bot.slowFetch.set("alice-id", held.promise);
  // The first view (alice joined) is still being read when bob joins.
  const first = bot.voice("alice-id", "x");
  await new Promise<void>((resolve) => setImmediate(resolve));
  bot.slowFetch.delete("alice-id");
  const second = bot.voice("bob-id", "y");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(bot.syncs, [], "the newer reconcile waits for the older one");
  held.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(bot.syncs, [["alice-id"], ["alice-id", "bob-id"]]);
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id", "bob-id"]);
});
