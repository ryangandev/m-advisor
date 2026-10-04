import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { VoiceChannel, type Client, type MessageCreateOptions } from "discord.js";
import type { MatchDetail, ServerBinding } from "../src/types";
import { GameMonitor, resolveMonitoredVoiceChannel, type MonitorDependencies } from "../src/services/gameMonitor";
import { VoiceAnnouncementService } from "../src/services/voiceAnnouncements";
import { RiotApiError } from "../src/services/riotData";
import { getAnnouncerState, getLastMatchId } from "../src/store/announcerStore";
import { closeDatabase } from "../src/store/database";
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

function harness(guildId: string, puuids = ["tracked"]) {
  let binding: ServerBinding | undefined = {
    discordUserId: "member-1",
    accounts: puuids.map((puuid) => ({ puuid, gameName: puuid, tagLine: "NA1" })),
  };
  const messages: MessageCreateOptions[] = [];
  const channel = (id: string): VoiceChannel => ({
    id,
    guild: { id: guildId },
    members: new Map([["member-1", {}]]),
    send: async (message: MessageCreateOptions) => { messages.push(message); return {}; },
  }) as unknown as VoiceChannel;
  let currentChannel: VoiceChannel | null = channel("first-channel");
  const latestIds = new Map(puuids.map((puuid) => [puuid, "historical-match" as string | null]));
  const lookups: string[] = [];
  const generated: string[] = [];
  const played: string[] = [];
  const cleaned: string[] = [];
  const errors: unknown[] = [];
  const infos: string[] = [];
  let generate = async (text: string): Promise<string> => { generated.push(text); return "mock-audio.wav"; };
  const service = new VoiceAnnouncementService({
    generate: (text) => generate(text),
    play: async (target) => { played.push(target.id); },
    cleanup: async (path) => { cleaned.push(path); },
  });
  const dependencies: MonitorDependencies = {
    latest: async (puuid) => { lookups.push(puuid); return latestIds.get(puuid) ?? null; },
    detail: async (matchId): Promise<MatchDetail> => testMatch(matchId, [...new Set(puuids)]),
    binding: () => binding,
    resolveChannel: () => currentChannel,
    announce: (...args) => service.announce(...args),
    mock: () => true,
    log: (error) => { errors.push(error); },
    info: (message) => { infos.push(message); },
  };
  const monitor = new GameMonitor(dependencies);
  monitors.push(monitor);
  const client = {} as Client;
  return {
    guildId, monitor, client, dependencies, latestIds, lookups, generated, played, cleaned, errors, infos, messages, channel,
    get binding() { return binding; },
    set binding(value: ServerBinding | undefined) { binding = value; },
    get currentChannel() { return currentChannel; },
    set currentChannel(value: VoiceChannel | null) { currentChannel = value; },
    set generate(value: (text: string) => Promise<string>) { generate = value; },
    start: async () => {
      monitor.start(client, guildId, currentChannel!.id);
      return monitor.poll(client, guildId);
    },
    poll: () => monitor.poll(client, guildId),
  };
}

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

test("detection and completion are logged with the delay since the game ended", async () => {
  const bot = harness("log-guild");
  await bot.start();
  assert.deepEqual(bot.infos, [], "the baseline is silent");
  const detail = bot.dependencies.detail;
  bot.dependencies.detail = async (matchId) => {
    const match = await detail(matchId);
    match.info.gameEndTimestamp = matchId === "ended-match" ? Date.now() - 95_000 : null;
    return match;
  };
  bot.latestIds.set("tracked", "ended-match");
  await bot.poll();
  assert.match(bot.infos[0], /^Detected finished match ended-match for tracked#NA1: ended 9[56] s ago, queue 420, 30 min\.$/);
  assert.match(bot.infos[1], /^Announced match ended-match in voice \d+ s after detection\.$/);
  bot.latestIds.set("tracked", "unknown-end");
  await bot.poll();
  assert.match(bot.infos[2], /^Detected finished match unknown-end for tracked#NA1: end time unknown,/);
  assert.equal(bot.infos.length, 4);
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
    if (attempts === 1) throw new Error("Fake speech failure");
    return "retry-audio.wav";
  };
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.equal(bot.infos.filter((message) => message.startsWith("Announced")).length, 0, "a failed announcement is not reported as done");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(bot.cleaned, ["retry-audio.wav"]);
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "pending-match");
});

test("concurrent manual polls await one baseline and one announcement", async () => {
  const bot = harness("concurrent-poll-guild");
  const baseline = deferred<string | null>();
  let latestCalls = 0;
  bot.dependencies.latest = async () => { latestCalls++; return baseline.promise; };
  bot.monitor.start(bot.client, bot.guildId, bot.currentChannel!.id);
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
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(attempts, 1);
  assert.equal(getLastMatchId(bot.guildId, "second"), "historical-match");
  assert.deepEqual(await bot.poll(), { announced: 0, errors: 1 });
  assert.equal(attempts, 2);
});

test("stop and restart create a new baseline instead of replaying an offline match", async () => {
  const bot = harness("restart-monitor-guild");
  await bot.start();
  bot.monitor.stop(bot.guildId);
  assert.equal(getAnnouncerState(bot.guildId).activeVoiceChannelId, null);
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
  bot.binding = { ...bot.binding!, discordUserId: "member-2" };
  speech.resolve("rebound-audio.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.deepEqual(bot.played, []);
  assert.deepEqual(bot.cleaned, ["rebound-audio.wav"]);
  await bot.start();
  assert.equal(bot.played.length, 0);
});

test("channel moves during TTS play and mention only in the member's new channel", async () => {
  const bot = harness("move-generation-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  const speech = deferred<string>();
  const started = deferred<void>();
  bot.generate = async () => { started.resolve(); return speech.promise; };
  const poll = bot.poll();
  await started.promise;
  bot.currentChannel = bot.channel("second-channel");
  bot.monitor.start(bot.client, bot.guildId, "second-channel");
  speech.resolve("moved-audio.wav");
  assert.equal((await poll).announced, 1);
  assert.deepEqual(bot.played, ["second-channel"]);
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
  bot.currentChannel = bot.channel("unauthorized-channel");
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
  bot.currentChannel = bot.channel("unauthorized-channel");
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
  bot.currentChannel = null;
  speech.resolve("left-audio.wav");
  assert.deepEqual(await poll, { announced: 0, errors: 0 });
  assert.equal(getLastMatchId(bot.guildId, "tracked"), "historical-match");
  assert.deepEqual(bot.played, []);
});

test("text send failure is reported after successful audio without repeating voice", async () => {
  const bot = harness("text-failure-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  bot.currentChannel!.send = async () => { throw new Error("Missing SendMessages permission"); };
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
  assert.match(String(bot.errors[0]), /Use \/bind/);
  bot.latestIds.set("real-account", "real-match");
  assert.deepEqual(await bot.poll(), { announced: 1, errors: 0 });
  assert.deepEqual(bot.lookups, ["real-account", "real-account"]);
  assert.doesNotMatch(bot.generated[0], /模拟/);
});

test("participants without a mapped present Discord member cannot trigger mentions", async () => {
  const bot = harness("mention-safety-guild");
  await bot.start();
  bot.latestIds.set("tracked", "new-match");
  (bot.currentChannel!.members as unknown as Map<string, unknown>).clear();
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
