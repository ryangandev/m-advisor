import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { VoiceChannel, type Client, type MessageCreateOptions } from "discord.js";
import type { MatchDetail, TrackedMember } from "../src/types";
import { GameMonitor, MAX_VOICE_ATTEMPTS, resolveMonitoredVoiceChannel, type MonitorDependencies } from "../src/services/gameMonitor";
import { VoiceAnnouncementService, type VoiceAnnouncementDependencies } from "../src/services/voiceAnnouncements";
import { resetMockData, RiotApiError, simulateMockMatch } from "../src/services/riotData";
import { buildMatchAnnouncement } from "../src/services/announcementText";
import { buildHorseRecords } from "../src/services/horseRecords";
import type { MatchEvent } from "../src/services/matchEvents";
import { getAnnouncerState, getLastMatchId } from "../src/store/announcerStore";
import { setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import { listMatchHorseRecords, recordHorseRecords, type HorseRecord } from "../src/store/horseRecordStore";
import { getLatestSRMatchId, getMatchDetail } from "../src/utils/riotMatchApi";
import { testMatch } from "./helpers/matches";

const monitors: GameMonitor[] = [];
let originalDatabasePath: string | undefined;
let savedEnvironment: Record<string, string | undefined>;
beforeEach(() => {
  originalDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = ":memory:";
  savedEnvironment = Object.fromEntries(["RIOT_MODE", "TEST_GUILD_ID", "TEST_VOICE_CHANNEL_ID"].map((key) => [key, process.env[key]]));
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stopAll();
  closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Longer than the voice queue's 100 ms channel watch. */
const WATCH = 250;

/** A match that ended an hour before the test, so it is history for anyone who joins voice during the test. */
function oldMatch(matchId: string, puuids: string[]): MatchDetail {
  const detail = testMatch(matchId, puuids);
  detail.info.gameEndTimestamp = Date.now() - 3_600_000;
  return detail;
}

interface MemberSpec { id: string; puuids: string[]; channel: string | null }
interface FakeChannel { id: string; guild: { id: string }; members: Map<string, { user: { bot: boolean } }>; send: (message: MessageCreateOptions) => Promise<unknown> }

/**
 * A guild with tracked members in fake voice channels, the real announcer store and voice queue, and fake Riot, speech and Discord.
 * Called with PUUIDs it keeps the original single-member shape: member-1 owns them all and sits in first-channel.
 */
function harness(guildId: string, specs: string[] | MemberSpec[] = ["tracked"]) {
  const memberSpecs: MemberSpec[] = typeof specs[0] === "string"
    ? [{ id: "member-1", puuids: specs as string[], channel: "first-channel" }]
    : specs as MemberSpec[];
  let members: TrackedMember[] = memberSpecs.map((spec) => ({
    discordUserId: spec.id,
    accounts: spec.puuids.map((puuid) => ({ puuid, gameName: puuid, tagLine: "NA1" })),
  }));
  const sent: Array<{ channelId: string; message: MessageCreateOptions }> = [];
  const channels = new Map<string, FakeChannel>();
  const channel = (id: string): FakeChannel => {
    let existing = channels.get(id);
    if (!existing) {
      const created: FakeChannel = {
        id,
        guild: { id: guildId },
        members: new Map(),
        send: async (message) => { sent.push({ channelId: created.id, message }); return {}; },
      };
      existing = created;
      channels.set(id, existing);
    }
    return existing;
  };
  const location = new Map<string, string | null>();
  /** Channels announcements may not use, like the TEST_VOICE_CHANNEL_ID restriction in mock mode. */
  const blocked = new Set<string>();
  const move = (memberId: string, channelId: string | null) => {
    const previous = location.get(memberId);
    if (previous) channel(previous).members.delete(memberId);
    location.set(memberId, channelId);
    if (channelId) channel(channelId).members.set(memberId, { user: { bot: false } });
  };
  for (const spec of memberSpecs) move(spec.id, spec.channel);
  const allPuuids = [...new Set(memberSpecs.flatMap((spec) => spec.puuids))];
  const latestIds = new Map(allPuuids.map((puuid) => [puuid, "historical-match" as string | null]));
  const matches = new Map<string, MatchDetail>();
  const lookups: string[] = [];
  const generated: string[] = [];
  const played: string[] = [];
  const cleaned: string[] = [];
  const errors: unknown[] = [];
  const infos: string[] = [];
  const records: HorseRecord[][] = [];
  const timelines: string[] = [];
  let generate = async (text: string): Promise<string> => { generated.push(text); return "mock-audio.wav"; };
  let play: VoiceAnnouncementDependencies["play"] = async (target) => { played.push(target.id); };
  const service = new VoiceAnnouncementService({
    // Monitor tests inspect the whole report as one request; sentence chunking is covered in voiceAnnouncements tests.
    split: (text) => [text],
    generate: (text) => generate(text),
    play: (...args) => play(...args),
    cleanup: async (path) => { cleaned.push(path); },
  });
  const dependencies: MonitorDependencies = {
    latest: async (puuid) => { lookups.push(puuid); return latestIds.get(puuid) ?? null; },
    detail: async (matchId): Promise<MatchDetail> => matches.get(matchId) ?? oldMatch(matchId, allPuuids),
    members: () => members,
    resolveChannel: (_client, _guildId, userId) => {
      const channelId = location.get(userId);
      return channelId && !blocked.has(channelId) ? channel(channelId) as unknown as VoiceChannel : null;
    },
    announce: (...args) => service.announce(...args),
    // No timeline by default, so reports quote statistics; tests that need moments replace this.
    events: async (matchId) => { timelines.push(matchId); return null; },
    record: (batch) => { records.push([...batch]); return batch.length; },
    mock: () => true,
    log: (error) => { errors.push(error); },
    info: (message) => { infos.push(message); },
  };
  const monitor = new GameMonitor(dependencies);
  monitors.push(monitor);
  const client = {} as Client;
  const inVoice = () => members.filter((member) => location.get(member.discordUserId)).map((member) => member.discordUserId);
  return {
    guildId, monitor, client, dependencies, latestIds, matches, lookups, generated, played, cleaned, errors, infos, sent, channel, move, blocked,
    records, timelines,
    get messages() { return sent.map((entry) => entry.message); },
    get members() { return members; },
    set members(value: TrackedMember[]) { members = value; },
    set generate(value: (text: string) => Promise<string>) { generate = value; },
    set play(value: VoiceAnnouncementDependencies["play"]) { play = value; },
    /** What the voice event does: sync the session to every tracked member who is in voice. */
    sync: () => monitor.sync(client, guildId, inVoice()),
    start: async () => {
      monitor.sync(client, guildId, inVoice());
      return monitor.poll(client, guildId);
    },
    poll: () => monitor.poll(client, guildId),
    status: () => monitor.status(guildId),
  };
}

/**
 * A parsed match where `allies` share the first team and `enemies` play on the other team.
 * Each tracked participant is named after its PUUID so speech shows whose view it uses.
 */
function match(matchId: string, allies: string[], enemies: string[] = [], endedAt: number | null = Date.now()): MatchDetail {
  const detail = testMatch(matchId, allies);
  allies.forEach((puuid, index) => { detail.info.participants[index].riotIdGameName = puuid; });
  enemies.forEach((puuid, index) => {
    detail.info.participants[5 + index].puuid = puuid;
    detail.info.participants[5 + index].riotIdGameName = puuid;
  });
  detail.metadata.participants = detail.info.participants.map((participant) => participant.puuid);
  detail.info.gameEndTimestamp = endedAt;
  return detail;
}

/** Playback that lasts until released, and stops like the real transport when its signal aborts. */
function heldPlayback(bot: ReturnType<typeof harness>) {
  const waiters: Array<() => void> = [];
  let starts = 0;
  let awaited = 0;
  let release = () => {};
  bot.play = (target, _path, _timeout, signal) => new Promise<void>((resolve, reject) => {
    bot.played.push(target.id);
    release = resolve;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    starts++;
    waiters.splice(0).forEach((wake) => wake());
  });
  return {
    /** Resolves once the next playback, counted from the previous call, has started. */
    nextStart: async () => {
      const target = ++awaited;
      while (starts < target) await new Promise<void>((wake) => waiters.push(wake));
    },
    release: () => release(),
  };
}

// Single-member behaviour, unchanged from before several members could be tracked.

test("starting a monitoring session establishes a baseline without speaking history", async () => {
  const bot = harness("baseline-guild");
  assert.deepEqual(await bot.start(), { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.deepEqual(bot.generated, []);
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  bot.latestIds.set("tracked", "new-match");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(bot.played.length, 1);
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
});

test("monitoring logs its start, baseline, detections, completions and stop", async () => {
  const bot = harness("log-guild");
  await bot.start();
  assert.deepEqual(bot.infos.splice(0), [
    "Monitoring started for tracked#NA1 in voice channel first-channel; checking every 45 s.",
    "Baseline for tracked#NA1: historical-match; only matches that finish after this are announced.",
  ]);
  const detail = bot.dependencies.detail;
  bot.dependencies.detail = async (matchId) => {
    const match = await detail(matchId);
    match.info.gameEndTimestamp = matchId === "ended-match" ? Date.now() - 95_000 : null;
    return match;
  };
  bot.latestIds.set("tracked", "ended-match");
  await bot.poll();
  assert.equal(bot.infos.length, 4);
  assert.match(bot.infos[0], /^Detected finished match ended-match for tracked#NA1: ended 9[56] s ago, queue 420, 30 min\.$/);
  assert.equal(bot.infos[1], "Saved 1 马厩 record for match ended-match.");
  assert.match(bot.infos[2], /^Match ended-match starts playing in voice channel first-channel \d+\.\d s after detection\.$/);
  assert.match(bot.infos[3], /^Announced match ended-match in voice \d+\.\d s after detection\.$/);
  bot.latestIds.set("tracked", "unknown-end");
  await bot.poll();
  assert.match(bot.infos[4], /^Detected finished match unknown-end for tracked#NA1: end time unknown,/);
  assert.equal(bot.infos.length, 8);
  bot.monitor.stop(bot.guildId, "the tracked member left voice");
  assert.equal(bot.infos.at(-1), "Monitoring stopped: the tracked member left voice.");
  bot.monitor.stop(bot.guildId, "again");
  assert.equal(bot.infos.length, 9, "stopping an inactive guild logs nothing");
});

test("status reports the active session, its last check and the last error after it stops", async () => {
  const bot = harness("status-guild");
  assert.deepEqual({ ...bot.status(), announced: [] }, {
    active: false, startedAt: undefined, lastPollAt: undefined, lastError: undefined, announced: [], presentMemberIds: [] });
  const before = Date.now();
  await bot.start();
  const started = bot.status();
  assert.equal(started.active, true);
  assert.deepEqual(started.presentMemberIds, ["member-1"]);
  assert.ok(started.startedAt! >= before && started.lastPollAt! >= started.startedAt!);
  bot.latestIds.set("tracked", "announced-match");
  await bot.poll();
  assert.deepEqual([...bot.status().announced], ["announced-match"]);
  bot.dependencies.latest = async () => { throw new RiotApiError("Update RIOT_API_KEY", "unauthorized", 401); };
  await bot.poll();
  const stopped = bot.status();
  assert.equal(stopped.active, false);
  assert.deepEqual(stopped.presentMemberIds, []);
  assert.equal(stopped.lastError?.message, "Update RIOT_API_KEY");
  assert.match(bot.infos.at(-1)!, /^Monitoring stopped: Riot rejected the credentials/);
  // A later clean session clears the old error.
  bot.dependencies.latest = async () => "announced-match";
  await bot.start();
  assert.equal(bot.status().lastError, undefined);
});

test("tracked defeat remains defeat even when the enemy has the highest KDA", async () => {
  const bot = harness("tracked-defeat-guild");
  await bot.start();
  bot.latestIds.set("tracked", "loss-match");
  await bot.poll();
  assert.match(bot.generated[0], /^模拟战报。Tracked这局输了/);
  assert.doesNotMatch(bot.generated[0], /这局赢了/);
  // Only the tracked player's team is ranked, so the enemy with the best KDA is never mentioned.
  assert.doesNotMatch(bot.generated[0], /Enemy/);
  assert.equal(bot.messages[0].content, "<@member-1>");
  const embed = JSON.stringify(bot.messages[0].embeds);
  assert.match(embed, /模拟战报/);
  assert.match(embed, /没有马/);
  assert.deepEqual(bot.messages[0].allowedMentions, { parse: [], roles: [], users: ["member-1"], repliedUser: false });
});

test("a malformed match cannot produce speech or consume the pending match", async () => {
  const bot = harness("invalid-match-guild");
  await bot.start();
  bot.latestIds.set("tracked", "invalid-match");
  const detail = bot.dependencies.detail;
  bot.dependencies.detail = async (matchId) => {
    const match = await detail(matchId);
    match.info.participants[0].kills = Number.NaN;
    return match;
  };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.deepEqual(bot.generated, []);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
});

test("failed TTS leaves a pending match eligible for retry", async () => {
  const bot = harness("tts-retry-guild");
  await bot.start();
  bot.latestIds.set("tracked", "pending-match");
  let attempts = 0;
  bot.generate = async () => {
    attempts++;
    // The voice queue retries a failed request once inline, so both attempts of the first poll fail.
    if (attempts <= 2) throw new Error("Fake speech failure");
    return "retry-audio.wav";
  };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.equal(bot.infos.filter((message) => message.startsWith("Announced")).length, 0, "a failed announcement is not reported as done");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(attempts, 3);
  assert.deepEqual(bot.cleaned, ["retry-audio.wav"]);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "pending-match");
});

test("concurrent manual polls await one baseline and one announcement", async () => {
  const bot = harness("concurrent-poll-guild");
  const baseline = deferred<string | null>();
  let latestCalls = 0;
  bot.dependencies.latest = async () => { latestCalls++; return baseline.promise; };
  bot.sync();
  const first = bot.poll();
  const second = bot.poll();
  assert.equal(first, second);
  assert.equal(latestCalls, 1);
  baseline.resolve("historical");
  await first;
  bot.dependencies.latest = async () => { latestCalls++; return "new-match"; };
  const speech = deferred<string>();
  bot.generate = async () => speech.promise;
  const announce = bot.poll();
  assert.equal(announce, bot.poll());
  await new Promise<void>((resolve) => setImmediate(resolve));
  speech.resolve("concurrent-audio.wav");
  assert.deepEqual(await announce, { announced: 1, errors: 0 });
  assert.equal(latestCalls, 2);
  assert.equal(bot.played.length, 1);
});

test("duplicate accounts and shared matches announce once per guild", async () => {
  const bot = harness("duplicate-match-guild", ["tracked", "tracked", "second"]);
  await bot.start();
  assert.deepEqual(bot.lookups, ["tracked", "second"]);
  bot.latestIds.set("tracked", "shared-match");
  bot.latestIds.set("second", "shared-match");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(bot.played.length, 1);
  assert.equal(getLastMatchId(bot.guildId, "second"), "shared-match");
});

test("shared-match failure attempts speech once per poll and retries next time", async () => {
  const bot = harness("shared-failed-match-guild", ["tracked", "second"]);
  await bot.start();
  bot.latestIds.set("tracked", "shared-match");
  bot.latestIds.set("second", "shared-match");
  let attempts = 0;
  bot.generate = async () => { attempts++; throw new Error("speech unavailable"); };
  // One announcement per poll, each with the voice queue's single inline retry.
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(attempts, 2);
  assert.equal(getLastMatchId(bot.guildId, "second"), "historical-match");
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(attempts, 4);
});

test("stop and restart create a new baseline instead of replaying an offline match", async () => {
  const bot = harness("restart-monitor-guild");
  await bot.start();
  bot.monitor.stop(bot.guildId);
  assert.equal(getAnnouncerState(bot.guildId).pollingInterval, null);
  bot.latestIds.set("tracked", "offline-match");
  assert.deepEqual(await bot.start(), { announced: 0, errors: 0 });
  assert.deepEqual(bot.generated, []);
  bot.latestIds.set("tracked", "online-match");
  assert.equal((await bot.poll()).announced, 1);
});

test("an account with no history announces its first later match", async () => {
  const bot = harness("empty-history-guild");
  bot.latestIds.set("tracked", null);
  await bot.start();
  bot.latestIds.set("tracked", "first-match");
  assert.equal((await bot.poll()).announced, 1);
});

test("stopping during TTS cancels playback and cleans generated audio", async () => {
  const bot = harness("cancel-generation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.monitor.stop(bot.guildId);
  speech.resolve("cancelled-audio.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
  assert.deepEqual(bot.cleaned, ["cancelled-audio.wav"]);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), undefined);
});

test("a cancelled old session cannot alter the next session's baseline", async () => {
  const bot = harness("old-session-guild");
  await bot.start();
  bot.latestIds.set("tracked", "before-stop-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const oldPoll = bot.poll();
  await started.promise;
  bot.monitor.stop(bot.guildId);
  bot.latestIds.set("tracked", "new-baseline-match");
  await bot.start();
  speech.resolve("old-session.wav");
  assert.deepEqual(await oldPoll, { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "new-baseline-match");
  assert.deepEqual(bot.played, []);
});

test("rebind during TTS cancels the old member's pending announcement", async () => {
  const bot = harness("rebind-generation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.members = [{ ...bot.members[0], discordUserId: "member-2" }];
  speech.resolve("rebound-audio.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
  assert.deepEqual(bot.cleaned, ["rebound-audio.wav"]);
  // The new owner starts from a fresh baseline instead of inheriting the old member's pending match.
  bot.move("member-2", "first-channel");
  await bot.start();
  await bot.poll();
  assert.equal(bot.played.length, 0);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "new-match");
});

test("channel moves during TTS play in the member's new channel after the text went to the old one", async () => {
  const bot = harness("move-generation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.move("member-1", "second-channel");
  bot.sync();
  speech.resolve("moved-audio.wav");
  assert.equal((await poll).announced, 1);
  assert.deepEqual(bot.played, ["second-channel"]);
  // The text was posted before generation, while the member was still in the first channel.
  assert.deepEqual(bot.sent.map((entry) => entry.channelId), ["first-channel"]);
});

test("a simulation poll pinned to its authorized channel cancels a move during TTS", async () => {
  const bot = harness("authorized-simulation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "simulated-match");
  const started = deferred<void>();
  const speech = deferred<string>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.monitor.poll(bot.client, bot.guildId, "first-channel");
  await started.promise;
  bot.move("member-1", "unauthorized-channel");
  speech.resolve("pinned-simulation.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.deepEqual(bot.cleaned, ["pinned-simulation.wav"]);
});

test("a manual poll adds its channel guard to an already running automatic poll", async () => {
  const bot = harness("inflight-guard-guild");
  await bot.start();
  bot.latestIds.set("tracked", "simulated-match");
  const started = deferred<void>();
  const speech = deferred<string>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const automatic = bot.poll();
  await started.promise;
  const manual = bot.monitor.poll(bot.client, bot.guildId, "first-channel");
  assert.equal(automatic, manual);
  bot.move("member-1", "unauthorized-channel");
  speech.resolve("inflight-pinned.wav");
  assert.deepEqual(await manual, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
});

test("the production mock resolver enforces configured test guild and channel on retries", () => {
  const makeClient = (guildId: string, channelId: string): Client => {
    const voiceChannel = Object.create(VoiceChannel.prototype) as VoiceChannel;
    Object.defineProperties(voiceChannel, { id: { value: channelId }, guild: { value: { id: guildId } } });
    return { guilds: { cache: new Map([[guildId, { members: { cache: new Map([["member", { voice: { channel: voiceChannel } }]]) } }]]) } } as unknown as Client;
  };
  process.env.RIOT_MODE = "mock";
  process.env.TEST_GUILD_ID = "authorized-guild";
  process.env.TEST_VOICE_CHANNEL_ID = "authorized-channel";
  assert.equal(resolveMonitoredVoiceChannel(makeClient("another-guild", "authorized-channel"), "another-guild", "member"), null);
  assert.equal(resolveMonitoredVoiceChannel(makeClient("authorized-guild", "another-channel"), "authorized-guild", "member"), null);
  assert.equal(resolveMonitoredVoiceChannel(makeClient("authorized-guild", "authorized-channel"), "authorized-guild", "member")?.id, "authorized-channel");
  process.env.RIOT_MODE = "real";
  assert.equal(resolveMonitoredVoiceChannel(makeClient("another-guild", "another-channel"), "another-guild", "member")?.id, "another-channel");
});

test("a member leaving during TTS cancels playback without consuming the match", async () => {
  const bot = harness("leave-generation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.move("member-1", null);
  speech.resolve("left-audio.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.deepEqual(bot.played, []);
});

test("a text send failure is reported, the voice still plays, and nothing repeats", async () => {
  const bot = harness("text-failure-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  bot.channel("first-channel").send = async () => { throw new Error("Missing SendMessages permission"); };
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 1 });
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(bot.played.length, 1);
  assert.equal(bot.errors.length, 1);
});

test("credential failures stop polling without a retry loop", async () => {
  const bot = harness("auth-failure-guild");
  let calls = 0;
  bot.dependencies.latest = async () => { calls++; throw new RiotApiError("Update RIOT_API_KEY", "unauthorized", 401); };
  assert.deepEqual(await bot.start(), { announced: 0, errors: 1 });
  assert.equal(getAnnouncerState(bot.guildId).pollingInterval, null);
  await bot.poll();
  assert.equal(calls, 1);
});

test("real monitoring skips saved mock accounts while allowing real accounts", async () => {
  const bot = harness("mixed-real-guild", ["MOCK-fixture", "real-account"]);
  bot.dependencies.mock = () => false;
  assert.deepEqual(await bot.start(), { announced: 0, errors: 1 });
  assert.deepEqual(bot.lookups, ["real-account"]);
  assert.match(String(bot.errors[0]), /MOCK-fixture#NA1 was skipped in real mode\. Use \/bind with a real Riot ID to replace it/);
  bot.latestIds.set("real-account", "real-match");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.lookups, ["real-account", "real-account"]);
  assert.doesNotMatch(bot.generated[0], /模拟/);
});

test("participants without a mapped present Discord member cannot trigger mentions", async () => {
  const bot = harness("mention-safety-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  bot.channel("first-channel").members.clear();
  const detail = bot.dependencies.detail;
  bot.dependencies.detail = async (matchId) => {
    const match = await detail(matchId);
    match.info.participants[1].riotIdGameName = "@everyone <@123>";
    return match;
  };
  assert.equal((await bot.poll()).announced, 1);
  assert.deepEqual(bot.messages[0].allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  assert.equal(bot.messages[0].content, undefined);
  assert.doesNotMatch(JSON.stringify(bot.messages[0].embeds), /@everyone|<@/);
  assert.doesNotMatch(bot.generated[0], /@everyone|<@/);
});

// Several tracked members in one guild.

test("separate matches play in each player's channel, oldest first, and baselines advance only after playback", async () => {
  const bot = harness("separate-matches-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "y" },
    { id: "cara-id", puuids: ["cara"], channel: "x" },
  ]);
  await bot.start();
  const now = Date.now();
  bot.matches.set("alice-match", match("alice-match", ["alice"], [], now - 60_000));
  bot.matches.set("bob-match", match("bob-match", ["bob"], [], now - 120_000));
  bot.matches.set("cara-match", match("cara-match", ["cara"], [], null));
  bot.latestIds.set("alice", "alice-match");
  bot.latestIds.set("bob", "bob-match");
  bot.latestIds.set("cara", "cara-match");
  const baselinesAtPlayback: string[][] = [];
  bot.play = async (target) => {
    bot.played.push(target.id);
    baselinesAtPlayback.push(["alice", "bob", "cara"].map((puuid) => getLastMatchId(bot.guildId, puuid)!));
  };
  assert.deepEqual(await bot.poll(), { announced: 3, errors: 0 });
  assert.deepEqual(bot.played, ["y", "x", "x"]);
  assert.deepEqual(baselinesAtPlayback, [
    ["historical-match", "historical-match", "historical-match"],
    ["historical-match", "bob-match", "historical-match"],
    ["alice-match", "bob-match", "historical-match"],
  ]);
  assert.match(bot.generated[0], /bob这局/);
  assert.match(bot.generated[1], /alice这局/);
  assert.match(bot.generated[2], /cara这局/);
  assert.deepEqual(bot.sent.map((entry) => [entry.channelId, entry.message.content, entry.message.allowedMentions?.users]), [
    ["y", "<@bob-id>", ["bob-id"]],
    ["x", "<@alice-id>", ["alice-id"]],
    ["x", "<@cara-id>", ["cara-id"]],
  ]);
  assert.deepEqual(["alice", "bob", "cara"].map((puuid) => getLastMatchId(bot.guildId, puuid)), ["alice-match", "bob-match", "cara-match"]);
});

test("a match shared across channels is announced once where most of its players are, mentioning exactly them", async () => {
  const bot = harness("shared-across-channels-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "y" },
  ]);
  await bot.start();
  bot.matches.set("party-match", match("party-match", ["alice", "bob", "cara"]));
  for (const puuid of ["alice", "bob", "cara"]) bot.latestIds.set(puuid, "party-match");
  // A bystander makes y busier, but the count of players decides first.
  bot.channel("y").members.set("bystander", { user: { bot: false } });
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
  assert.equal(bot.generated.length, 1);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].channelId, "x");
  assert.equal(bot.sent[0].message.content, "<@alice-id> <@bob-id>");
  assert.deepEqual(bot.sent[0].message.allowedMentions, { parse: [], roles: [], users: ["alice-id", "bob-id"], repliedUser: false });
  assert.deepEqual(["alice", "bob", "cara"].map((puuid) => getLastMatchId(bot.guildId, puuid)), ["party-match", "party-match", "party-match"]);
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
});

test("a one-to-one tie goes to the busier channel, then to the earliest-bound member, then stays put", async () => {
  const members = (): MemberSpec[] => [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "y" },
  ];
  const busier = harness("tie-humans-guild", members());
  await busier.start();
  busier.channel("y").members.set("bystander", { user: { bot: false } });
  busier.channel("x").members.set("some-bot", { user: { bot: true } });
  busier.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  busier.latestIds.set("alice", "duo-match");
  busier.latestIds.set("bob", "duo-match");
  await busier.poll();
  assert.deepEqual(busier.played, ["y"], "two people beat one person and a bot");

  const ordered = harness("tie-order-guild", members());
  await ordered.start();
  ordered.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  ordered.latestIds.set("alice", "duo-match");
  ordered.latestIds.set("bob", "duo-match");
  await ordered.poll();
  assert.deepEqual(ordered.played, ["x"], "alice was bound first");
  // The next tie keeps the channel the bot just used, even when the other one gets busier.
  ordered.channel("y").members.set("bystander", { user: { bot: false } });
  ordered.matches.set("rematch", match("rematch", ["alice", "bob"]));
  ordered.latestIds.set("alice", "rematch");
  ordered.latestIds.set("bob", "rematch");
  await ordered.poll();
  assert.deepEqual(ordered.played, ["x", "x"]);
});

test("a second member joining gets a baseline without speech and never replays an earlier game", async () => {
  const bot = harness("second-join-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: null },
  ]);
  await bot.start();
  assert.deepEqual(bot.lookups, ["alice"], "only members in voice are polled");
  bot.latestIds.set("bob", "bob-before-joining");
  bot.move("bob-id", "y");
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id", "bob-id"]);
  assert.equal(getLastMatchId(bot.guildId, "bob"), "bob-before-joining");
  assert.equal(getLastMatchId(bot.guildId, "alice"), "historical-match", "alice keeps her baseline");
  assert.deepEqual(bot.generated, []);
  assert.ok(bot.infos.includes("Monitoring now also covers bob#NA1 in voice channel y."));
  bot.matches.set("bob-after-joining", match("bob-after-joining", ["bob"]));
  bot.latestIds.set("bob", "bob-after-joining");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["y"]);
});

test("a member joining during a running poll gets a baseline right after it", async () => {
  const bot = harness("join-during-poll-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: null },
  ]);
  await bot.start();
  bot.latestIds.set("alice", "alice-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const running = bot.poll();
  await started.promise;
  bot.move("bob-id", "x");
  bot.sync();
  speech.resolve("alice.wav");
  assert.deepEqual(await running, { announced: 1, errors: 0 });
  // No timer tick or manual poll: the follow-up poll starts on its own.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getLastMatchId(bot.guildId, "bob"), "historical-match");
});

test("one member leaving keeps the session; a rejoin starts a fresh baseline; the last one leaving stops it", async () => {
  const bot = harness("leave-rejoin-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "y" },
  ]);
  await bot.start();
  const startedAt = bot.status().startedAt;
  bot.move("bob-id", null);
  bot.sync();
  assert.equal(bot.status().active, true);
  assert.equal(bot.status().startedAt, startedAt);
  assert.deepEqual(bot.status().presentMemberIds, ["alice-id"]);
  assert.equal(getLastMatchId(bot.guildId, "bob"), undefined, "bob's baseline is dropped");
  assert.equal(getLastMatchId(bot.guildId, "alice"), "historical-match");
  assert.ok(bot.infos.includes("Monitoring no longer covers bob#NA1: they left voice or were unbound."));
  // Bob plays while out of voice, then comes back.
  bot.latestIds.set("bob", "bob-offline-match");
  bot.lookups.length = 0;
  await bot.poll();
  assert.deepEqual(bot.lookups, ["alice"]);
  bot.move("bob-id", "y");
  bot.sync();
  await bot.poll();
  assert.equal(getLastMatchId(bot.guildId, "bob"), "bob-offline-match");
  assert.deepEqual(bot.generated, []);
  bot.move("alice-id", null);
  bot.move("bob-id", null);
  bot.sync();
  assert.equal(bot.status().active, false);
  assert.equal(bot.infos.at(-1), "Monitoring stopped: no tracked member is in voice.");
  assert.equal(getAnnouncerState(bot.guildId).pollingInterval, null);
});

test("a member leaving does not lose another member's pending match", async () => {
  const bot = harness("pending-survives-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "y" },
  ]);
  await bot.start();
  bot.latestIds.set("alice", "alice-match");
  let attempts = 0;
  // Both inline attempts of the first poll fail.
  bot.generate = async () => { attempts++; if (attempts <= 2) throw new Error("speech unavailable"); return "retry.wav"; };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  bot.move("bob-id", null);
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
});

test("a majority move during speech generation is followed", async () => {
  const bot = harness("generation-majority-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "y" },
  ]);
  await bot.start();
  bot.matches.set("party-match", match("party-match", ["alice", "bob", "cara"]));
  for (const puuid of ["alice", "bob", "cara"]) bot.latestIds.set(puuid, "party-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.move("bob-id", "y");
  bot.sync();
  speech.resolve("party.wav");
  assert.deepEqual(await poll, { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["y"]);
  // The text went out before generation, to the channel chosen then; only the voice follows the move.
  assert.deepEqual(bot.sent.map((entry) => [entry.channelId, entry.message.content]), [["x", "<@alice-id> <@bob-id>"]]);
});

test("a tie during speech generation keeps the first channel", async () => {
  const bot = harness("generation-tie-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "y" },
  ]);
  await bot.start();
  bot.matches.set("party-match", match("party-match", ["alice", "bob", "cara"]));
  for (const puuid of ["alice", "bob", "cara"]) bot.latestIds.set(puuid, "party-match");
  bot.channel("y").members.set("bystander", { user: { bot: false } });
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.move("bob-id", null);
  bot.sync();
  speech.resolve("party.wav");
  assert.deepEqual(await poll, { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
});

test("during playback a tied departure keeps playing while a strict majority move aborts and retries there", async () => {
  const bot = harness("playback-move-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "y" },
  ]);
  await bot.start();
  const playback = heldPlayback(bot);
  bot.matches.set("first-party", match("first-party", ["alice", "bob", "cara"]));
  for (const puuid of ["alice", "bob", "cara"]) bot.latestIds.set(puuid, "first-party");
  // y is busier, so only the hysteresis keeps the tied announcement in x.
  bot.channel("y").members.set("bystander", { user: { bot: false } });
  const tied = bot.poll();
  await playback.nextStart();
  bot.move("bob-id", null);
  bot.sync();
  await delay(WATCH);
  playback.release();
  assert.deepEqual(await tied, { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);

  bot.move("bob-id", "x");
  bot.sync();
  await bot.poll();
  bot.matches.set("second-party", match("second-party", ["alice", "bob", "cara"]));
  for (const puuid of ["alice", "bob", "cara"]) bot.latestIds.set(puuid, "second-party");
  const moved = bot.poll();
  await playback.nextStart();
  assert.deepEqual(bot.played, ["x", "x"]);
  bot.move("bob-id", "y");
  bot.sync();
  assert.deepEqual(await moved, { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "alice"), "first-party", "the aborted match is not consumed");
  assert.deepEqual(bot.sent.map((entry) => entry.channelId), ["x", "x"], "each match's text went out before its voice");
  const retry = bot.poll();
  await playback.nextStart();
  playback.release();
  assert.deepEqual(await retry, { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x", "x", "y"]);
  assert.equal(bot.sent.length, 2, "the retry does not post the text again");
  assert.equal(getLastMatchId(bot.guildId, "alice"), "second-party");
});

test("unbinding the member whose view the report uses cancels it, while an unrelated bind does not", async () => {
  const bot = harness("perspective-unbind-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
  ]);
  await bot.start();
  const firstSpeech = deferred<string>();
  const firstStarted = deferred<void>();
  bot.generate = async () => { firstStarted.resolve(); return firstSpeech.promise; };
  bot.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  bot.latestIds.set("alice", "duo-match");
  bot.latestIds.set("bob", "duo-match");
  const unrelated = bot.poll();
  await firstStarted.promise;
  bot.members = [...bot.members, { discordUserId: "dan-id", accounts: [{ puuid: "dan", gameName: "dan", tagLine: "NA1" }] }];
  bot.sync();
  firstSpeech.resolve("duo.wav");
  assert.deepEqual(await unrelated, { announced: 1, errors: 0 });

  const secondSpeech = deferred<string>();
  const secondStarted = deferred<void>();
  const texts: string[] = [];
  bot.generate = async (text) => { texts.push(text); secondStarted.resolve(); return secondSpeech.promise; };
  bot.matches.set("rematch", match("rematch", ["alice", "bob"]));
  bot.latestIds.set("alice", "rematch");
  bot.latestIds.set("bob", "rematch");
  const unbound = bot.poll();
  await secondStarted.promise;
  assert.match(texts[0], /alice这局/);
  bot.members = bot.members.filter((member) => member.discordUserId !== "alice-id");
  secondSpeech.resolve("rematch.wav");
  assert.deepEqual(await unbound, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
  assert.equal(getLastMatchId(bot.guildId, "bob"), "duo-match", "the cancelled match is not consumed");
  // Bob is still in voice, so the match is announced from his side next time.
  bot.sync();
  bot.generate = async (text) => { texts.push(text); return "bob.wav"; };
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.match(texts[1], /bob这局/);
});

test("a participant out of voice is neither mentioned nor replayed when they join later", async () => {
  const bot = harness("absent-participant-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: null },
  ]);
  await bot.start();
  bot.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  bot.latestIds.set("alice", "duo-match");
  bot.latestIds.set("bob", "duo-match");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(bot.sent[0].message.content, "<@alice-id>");
  assert.deepEqual(bot.sent[0].message.allowedMentions?.users, ["alice-id"]);
  assert.ok(!bot.lookups.includes("bob"));
  bot.move("bob-id", "x");
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(bot.played.length, 1);
  assert.equal(getLastMatchId(bot.guildId, "bob"), "duo-match");
});

test("the report speaks for the team with more players in the channel and still mentions a tracked enemy", async () => {
  const bot = harness("perspective-team-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "x" },
    { id: "dan-id", puuids: ["dan"], channel: "x" },
  ]);
  await bot.start();
  bot.matches.set("rivals", match("rivals", ["cara", "dan"], ["alice"]));
  for (const puuid of ["alice", "cara", "dan"]) bot.latestIds.set(puuid, "rivals");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.match(bot.generated[0], /cara这局/);
  assert.doesNotMatch(bot.generated[0], /alice/, "the enemy is neither scored nor named");
  assert.doesNotMatch(JSON.stringify(bot.messages[0].embeds), /alice/);
  assert.equal(bot.messages[0].content, "<@alice-id> <@cara-id> <@dan-id>");

  const tie = harness("perspective-tie-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "cara-id", puuids: ["cara"], channel: "x" },
  ]);
  await tie.start();
  tie.matches.set("duel", match("duel", ["cara"], ["alice"]));
  tie.latestIds.set("alice", "duel");
  tie.latestIds.set("cara", "duel");
  await tie.poll();
  assert.match(tie.generated[0], /alice这局/, "a one-to-one split speaks for the earliest-bound member");
  assert.doesNotMatch(tie.generated[0], /cara/);
});

test("a match with no player in a usable channel waits without an error and is logged once", async () => {
  const bot = harness("blocked-channel-guild", [{ id: "alice-id", puuids: ["alice"], channel: "stage" }]);
  bot.blocked.add("stage");
  await bot.start();
  bot.latestIds.set("alice", "waiting-match");
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(bot.infos.filter((message) => message.startsWith("Match waiting-match is waiting")).length, 1);
  assert.equal(getLastMatchId(bot.guildId, "alice"), "historical-match");
  assert.deepEqual(bot.generated, []);
  bot.move("alice-id", "x");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
});

test("an account added to a member already in voice gets a baseline before anything is announced", async () => {
  const bot = harness("added-account-guild", [{ id: "alice-id", puuids: ["alice"], channel: "x" }]);
  await bot.start();
  bot.latestIds.set("alice-smurf", "smurf-history");
  bot.members = [{ discordUserId: "alice-id", accounts: [
    { puuid: "alice", gameName: "alice", tagLine: "NA1" },
    { puuid: "alice-smurf", gameName: "alice-smurf", tagLine: "NA1" },
  ] }];
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "alice-smurf"), "smurf-history");
  // Replacing the account drops its baseline, so adding it back later cannot replay a game played in between.
  bot.members = [{ discordUserId: "alice-id", accounts: [{ puuid: "alice", gameName: "alice", tagLine: "NA1" }] }];
  bot.sync();
  assert.equal(getLastMatchId(bot.guildId, "alice-smurf"), undefined);
  bot.latestIds.set("alice-smurf", "smurf-while-unbound");
  bot.members = [{ discordUserId: "alice-id", accounts: [
    { puuid: "alice", gameName: "alice", tagLine: "NA1" },
    { puuid: "alice-smurf", gameName: "alice-smurf", tagLine: "NA1" },
  ] }];
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(bot.generated, []);
});

test("the speaker leaving mid-report does not cut off a teammate who stays, and nothing replays", async () => {
  const bot = harness("speaker-leaves-playback-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
  ]);
  await bot.start();
  const playback = heldPlayback(bot);
  bot.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  bot.latestIds.set("alice", "duo-match");
  bot.latestIds.set("bob", "duo-match");
  const poll = bot.poll();
  await playback.nextStart();
  assert.match(bot.generated[0], /alice这局/);
  // The text went out before generation, while both were in the channel.
  assert.equal(bot.sent[0].message.content, "<@alice-id> <@bob-id>");
  // Alice says good night and leaves while her report plays; Bob, who played the same game, stays.
  bot.move("alice-id", null);
  bot.sync();
  await delay(WATCH);
  playback.release();
  assert.deepEqual(await poll, { announced: 1, errors: 0 });
  assert.equal(bot.sent.length, 1);
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);
  assert.equal(getLastMatchId(bot.guildId, "bob"), "duo-match");
});

test("the speaker leaving before playback starts cancels it, and the next poll speaks for a teammate still in voice", async () => {
  const bot = harness("speaker-leaves-generation-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
  ]);
  await bot.start();
  bot.matches.set("duo-match", match("duo-match", ["alice", "bob"]));
  bot.latestIds.set("alice", "duo-match");
  bot.latestIds.set("bob", "duo-match");
  const texts: string[] = [];
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async (text) => { texts.push(text); started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.move("alice-id", null);
  bot.sync();
  speech.resolve("alice.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
  bot.generate = async (text) => { texts.push(text); return "bob.wav"; };
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.match(texts[0], /alice这局/);
  assert.match(texts.at(-1)!, /bob这局/);
  assert.deepEqual(bot.played, ["x"]);
});

test("a game that ends after a member joined is announced even when their first lookup waited behind a long report", async () => {
  const bot = harness("join-behind-playback-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: null },
    { id: "cara-id", puuids: ["cara"], channel: null },
  ]);
  await bot.start();
  const playback = heldPlayback(bot);
  bot.matches.set("alice-match", match("alice-match", ["alice"]));
  bot.latestIds.set("alice", "alice-match");
  const running = bot.poll();
  await playback.nextStart();
  // Bob and Cara join while Alice's report plays. Cara's last game ended before she joined; Bob's ends after he joined.
  bot.matches.set("cara-before-joining", match("cara-before-joining", ["cara"], [], Date.now() - 60_000));
  bot.latestIds.set("cara", "cara-before-joining");
  bot.move("bob-id", "y");
  bot.move("cara-id", "y");
  bot.sync();
  await delay(5);
  bot.matches.set("bob-after-joining", match("bob-after-joining", ["bob"], [], Date.now()));
  bot.latestIds.set("bob", "bob-after-joining");
  bot.play = async (target) => { bot.played.push(target.id); };
  playback.release();
  assert.deepEqual(await running, { announced: 1, errors: 0 });
  // The follow-up poll for the joiners has started on its own; this joins it.
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x", "y"]);
  assert.match(bot.generated[1], /bob这局/);
  assert.equal(getLastMatchId(bot.guildId, "bob"), "bob-after-joining");
  assert.equal(getLastMatchId(bot.guildId, "cara"), "cara-before-joining");
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(bot.played.length, 2, "neither game is announced twice and Cara's earlier game never");

  // A restart takes every latest match as a baseline, even one that ended while the old session ran.
  bot.monitor.stop(bot.guildId);
  bot.matches.set("bob-during-old-session", match("bob-during-old-session", ["bob"], [], Date.now()));
  bot.latestIds.set("bob", "bob-during-old-session");
  await delay(5);
  assert.deepEqual(await bot.start(), { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "bob"), "bob-during-old-session");
  assert.equal(bot.played.length, 2);
});

test("a teammate unbound during the report is neither counted for the channel nor mentioned", async () => {
  const bot = harness("unbound-teammate-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "y" },
    { id: "cara-id", puuids: ["cara"], channel: null },
  ]);
  await bot.start();
  bot.matches.set("trio", match("trio", ["alice", "bob", "cara"]));
  bot.latestIds.set("alice", "trio");
  bot.latestIds.set("bob", "trio");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  // Cara is unbound, then joins Bob's channel; she would otherwise make it the majority.
  bot.members = bot.members.filter((member) => member.discordUserId !== "cara-id");
  bot.move("cara-id", "y");
  speech.resolve("trio.wav");
  assert.deepEqual(await poll, { announced: 1, errors: 0 });
  assert.deepEqual(bot.played, ["x"]);

  const second = harness("unbound-mention-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "x" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
  ]);
  await second.start();
  second.matches.set("duo", match("duo", ["alice", "bob"]));
  second.latestIds.set("alice", "duo");
  second.latestIds.set("bob", "duo");
  const timeline = deferred<null>();
  const timelineStarted = deferred<void>();
  second.dependencies.events = async () => { timelineStarted.resolve(); return timeline.promise; };
  const secondPoll = second.poll();
  await timelineStarted.promise;
  // Bob is unbound after the match was detected, before its text goes out, but stays in the channel.
  second.members = second.members.filter((member) => member.discordUserId !== "bob-id");
  timeline.resolve(null);
  assert.deepEqual(await secondPoll, { announced: 1, errors: 0 });
  assert.equal(second.messages[0].content, "<@alice-id>");
  assert.deepEqual(second.messages[0].allowedMentions?.users, ["alice-id"]);
});

test("a match waiting for a usable channel is fetched and logged once, and forgotten when its player leaves", async () => {
  const bot = harness("waiting-cache-guild", [{ id: "alice-id", puuids: ["alice"], channel: "stage" }]);
  bot.blocked.add("stage");
  await bot.start();
  bot.matches.set("waiting-match", match("waiting-match", ["alice"]));
  bot.latestIds.set("alice", "waiting-match");
  const fetched: string[] = [];
  const detail = bot.dependencies.detail;
  bot.dependencies.detail = async (matchId) => { fetched.push(matchId); return detail(matchId); };
  for (let poll = 0; poll < 3; poll++) assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(fetched, ["waiting-match"]);
  assert.equal(bot.infos.filter((message) => message.startsWith("Detected finished match waiting-match")).length, 1);
  bot.move("alice-id", "x");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(fetched, ["waiting-match"], "the cached detail is used for the announcement");

  const leaving = harness("waiting-leave-guild", [
    { id: "alice-id", puuids: ["alice"], channel: "stage" },
    { id: "bob-id", puuids: ["bob"], channel: "x" },
  ]);
  leaving.blocked.add("stage");
  await leaving.start();
  leaving.matches.set("alice-solo", match("alice-solo", ["alice"], [], Date.now() - 1_000));
  leaving.latestIds.set("alice", "alice-solo");
  await leaving.poll();
  leaving.move("alice-id", null);
  leaving.sync();
  leaving.move("alice-id", "x");
  leaving.sync();
  await leaving.poll();
  await leaving.poll();
  // Alice's return starts a fresh baseline, so the game she finished before rejoining is not announced.
  assert.deepEqual(leaving.played, []);
  assert.equal(getLastMatchId(leaving.guildId, "alice"), "alice-solo");
  assert.equal(leaving.infos.filter((message) => message.startsWith("Match alice-solo is waiting")).length, 1);
});

// Text first, timeline moments, 马厩 records and the voice attempt cap.

test("the text report is posted before speech generation and only once across voice retries", async () => {
  const bot = harness("text-first-guild");
  await bot.start();
  bot.latestIds.set("tracked", "retried-match");
  const sentAtGeneration: number[] = [];
  let attempts = 0;
  bot.generate = async () => {
    sentAtGeneration.push(bot.sent.length);
    // Both inline attempts of the first poll fail; the second poll succeeds.
    if (++attempts <= 2) throw new Error("Fake speech failure");
    return "retried.wav";
  };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].message.content, "<@member-1>");
  assert.deepEqual(bot.sent[0].message.allowedMentions, { parse: [], roles: [], users: ["member-1"], repliedUser: false });
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(sentAtGeneration, [1, 1, 1], "the text was already posted when generation started");
  assert.equal(bot.sent.length, 1, "a voice retry does not post the text again");
  assert.equal(bot.records.length, 1, "the 马厩 records are written with the text, once");
  assert.deepEqual(bot.timelines, ["retried-match"], "the timeline is fetched once per match");
  assert.equal(bot.infos.filter((message) => message.startsWith("Detected finished match retried-match")).length, 1);
});

test("a timeline failure or a stuck timeline falls back to a statistics-only report", async () => {
  const failing = harness("timeline-failure-guild");
  await failing.start();
  failing.dependencies.events = async () => { throw new Error("timeline exploded"); };
  failing.latestIds.set("tracked", "no-timeline");
  assert.deepEqual(await failing.poll(), { announced: 1, errors: 0 });
  const detail = await failing.dependencies.detail("no-timeline");
  assert.equal(failing.generated[0], buildMatchAnnouncement(detail, "tracked", true).speech);
  assert.ok(failing.infos.includes("Timeline for match no-timeline is unavailable (timeline exploded); the report uses end-of-game statistics only."));
  assert.equal(failing.sent.length, 1);

  const stuck = harness("timeline-stuck-guild");
  await stuck.start();
  stuck.dependencies.timelineWaitMs = 30;
  stuck.dependencies.events = () => new Promise(() => {});
  stuck.latestIds.set("tracked", "slow-timeline");
  assert.deepEqual(await stuck.poll(), { announced: 1, errors: 0 });
  assert.ok(stuck.infos.some((message) => /^Timeline for match slow-timeline is unavailable \(no answer after 0\.0 s\)/.test(message)));
});

test("timeline moments reach the spoken and posted report", async () => {
  const bot = harness("timeline-moments-guild");
  await bot.start();
  bot.latestIds.set("tracked", "moment-match");
  const detail = await bot.dependencies.detail("moment-match");
  // A pentakill for every player, so whoever is praised has a moment to cite.
  const events: MatchEvent[] = detail.info.participants.map((player) => ({ puuid: player.puuid, timestamp: 600_000, kind: "multiKill", kills: 5 }));
  bot.dependencies.events = async () => events;
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  const withMoments = buildMatchAnnouncement(detail, "tracked", true, { events });
  assert.notEqual(withMoments.speech, buildMatchAnnouncement(detail, "tracked", true).speech);
  assert.equal(bot.generated[0], withMoments.speech);
  assert.ok(JSON.stringify(bot.messages[0].embeds).includes(JSON.stringify(withMoments.report.praise!).slice(1, -1)));
  const praised = bot.records[0].find((record) => record.commentaryTone === "praise");
  if (praised) assert.equal(praised.momentKind, "multiKill");
});

test("the 马厩 records are written once, from the posted report's perspective, for every bound player", async () => {
  const allies = ["alice", "bob", "cara", "dan", "eve"];
  const bot = harness("horse-record-guild", [...allies, "zed"].map((puuid) => ({ id: `${puuid}-id`, puuids: [puuid], channel: "x" })));
  await bot.start();
  const detail = match("party", allies, ["zed"]);
  bot.matches.set("party", detail);
  for (const puuid of [...allies, "zed"]) bot.latestIds.set(puuid, "party");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(bot.records.length, 1);
  const [records] = bot.records;
  const expected = buildHorseRecords({
    guildId: bot.guildId,
    detail,
    tracked: bot.members.flatMap((member) => member.accounts.map((account) => ({ discordUserId: member.discordUserId, puuid: account.puuid }))),
    mock: true,
    recordedAt: records[0].recordedAt,
    announcement: { announcement: buildMatchAnnouncement(detail, "alice", true), perspectivePuuid: "alice", events: null },
  });
  assert.deepEqual(records, expected);
  assert.equal(records.length, 6, "the tracked enemy is recorded from their own team's ranking");
  const spoken = records.filter((record) => record.commentary !== null);
  assert.deepEqual(spoken.map((record) => record.commentaryTone).sort(), ["praise", "roast"]);
  assert.ok(spoken.every((record) => record.teamId === 100), "only the perspective's team was praised and roasted");
  assert.equal(records.find((record) => record.puuid === "zed")!.commentary, null);
});

test("records go through the real store once per match, and a refused write never fails the announcement", async () => {
  const bot = harness("horse-store-guild");
  setMemberAccounts(bot.guildId, "member-1", [{ puuid: "tracked", gameName: "tracked", tagLine: "NA1" }]);
  bot.dependencies.record = recordHorseRecords;
  await bot.start();
  bot.latestIds.set("tracked", "stored-match");
  let attempts = 0;
  bot.generate = async () => { if (++attempts <= 2) throw new Error("Fake speech failure"); return "stored.wav"; };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  const stored = listMatchHorseRecords(bot.guildId, "stored-match", true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].discordUserId, "member-1");

  // The harness member is not in the database here, so the store refuses the record with UntrackedMemberError.
  const refused = harness("horse-refused-guild");
  refused.dependencies.record = recordHorseRecords;
  await refused.start();
  refused.latestIds.set("tracked", "refused-match");
  assert.deepEqual(await refused.poll(), { announced: 1, errors: 0 });
  assert.equal(refused.played.length, 1);
  assert.equal(refused.errors.length, 1);
  assert.match(String(refused.errors[0]), /马厩 records of match refused-match were not saved: A horse record can only be saved/);
  assert.deepEqual(listMatchHorseRecords(refused.guildId, "refused-match", true), []);
});

test(`a match whose voice fails ${MAX_VOICE_ATTEMPTS} times is consumed once and never replayed`, async () => {
  const bot = harness("attempt-cap-guild", ["tracked", "second"]);
  await bot.start();
  bot.latestIds.set("tracked", "broken-match");
  bot.latestIds.set("second", "broken-match");
  let attempts = 0;
  bot.generate = async () => { attempts++; throw new Error("speech unavailable"); };
  for (let poll = 1; poll < MAX_VOICE_ATTEMPTS; poll++) {
    assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
    assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match", "the match stays pending before the cap");
  }
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(attempts, MAX_VOICE_ATTEMPTS * 2, "each attempt includes the queue's inline retry");
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "broken-match");
  assert.equal(getLastMatchId(bot.guildId, "second"), "broken-match");
  assert.ok(bot.status().announced.has("broken-match"));
  assert.deepEqual(bot.infos.filter((message) => message.startsWith("Gave up")), [
    `Gave up on the voice report of match broken-match after ${MAX_VOICE_ATTEMPTS} failed attempts; its text report was posted, and it is not retried.`,
  ]);
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.equal(attempts, MAX_VOICE_ATTEMPTS * 2);
  assert.equal(bot.sent.length, 1);
  assert.deepEqual(bot.played, []);
});

test("cancelled voice attempts do not count toward the cap", async () => {
  const bot = harness("cap-cancel-guild");
  await bot.start();
  bot.latestIds.set("tracked", "interrupted-match");
  for (let attempt = 0; attempt < MAX_VOICE_ATTEMPTS; attempt++) {
    const started = deferred<void>();
    const speech = deferred<string>();
    bot.generate = async () => { started.resolve(); return speech.promise; };
    const poll = bot.poll();
    await started.promise;
    bot.move("member-1", null);
    speech.resolve("interrupted.wav");
    assert.deepEqual(await poll, { announced: 0, errors: 0 });
    bot.move("member-1", "first-channel");
  }
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  bot.generate = async () => "finally.wav";
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(bot.sent.length, 1);
});

test("after a restart, a member with a saved mock binding who joins a running mock session hears nothing", async () => {
  process.env.RIOT_MODE = "mock";
  // A fresh process: no mock profile or match exists until the first lookup.
  resetMockData();
  const bot = harness("mock-restart-guild", [
    { id: "alice-id", puuids: ["MOCK-restart-alice"], channel: "x" },
    { id: "bob-id", puuids: ["MOCK-restart-bob"], channel: null },
  ]);
  // A lookup takes a moment, as a real one does, so the fixture is created after Bob joined.
  bot.dependencies.latest = async (puuid) => { await delay(5); return getLatestSRMatchId(puuid); };
  bot.dependencies.detail = getMatchDetail;
  assert.deepEqual(await bot.start(), { announced: 0, errors: 0 });
  bot.move("bob-id", "x");
  bot.sync();
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 0 });
  assert.deepEqual(bot.generated, []);
  assert.deepEqual(bot.sent, []);
  assert.match(getLastMatchId(bot.guildId, "MOCK-restart-bob")!, /^MOCK_MOCK-restart-bob_\d+_BASELINE$/);
  // A game Bob finishes afterwards is announced as usual.
  const { matchId } = simulateMockMatch("MOCK-restart-bob", "win");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "MOCK-restart-bob"), matchId);
});
