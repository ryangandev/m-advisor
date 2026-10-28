import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Client, MessageCreateOptions, VoiceChannel } from "discord.js";
import type { ActiveGame, ActiveGameParticipant, MatchDetail, RankedEntry, TrackedMember } from "../src/types";
import { RankTracker } from "../src/services/rankTracker";
import { GameMonitor, logGameStartFailure, type MonitorDependencies } from "../src/services/gameMonitor";
import { GAME_START_INTERVAL_MS, GAME_START_WINDOW_MS, PICK_MEMORY_MS } from "../src/services/gameStartWatcher";
import { buildPregameRecap, RECAP_FIELD_NAME, RECAP_PHRASES, spacedName } from "../src/services/pregameRecap";
import { rankTeam } from "../src/services/horseRanking";
import { VoiceAnnouncementService, type VoiceAnnouncementDependencies } from "../src/services/voiceAnnouncements";
import { MOCK_PREGAME_PREFIX, OTHER_SIDE_NOTE } from "../src/services/pregameBrief";
import { resetMockData, RiotApiError, simulateMockGameStart } from "../src/services/riotData";
import { getActiveGame } from "../src/utils/riotSpectatorApi";
import { closeDatabase } from "../src/store/database";
import type { HorseRecord } from "../src/store/horseRecordStore";
import type { HorseTier } from "../src/services/horseRanking";
import { makeHorseRecord } from "./helpers/horseRecords";
import { testMatch } from "./helpers/matches";

const monitors: GameMonitor[] = [];
let savedEnvironment: Record<string, string | undefined>;
beforeEach(() => {
  savedEnvironment = Object.fromEntries(["DATABASE_PATH", "RIOT_MODE", "TEST_GUILD_ID", "TEST_VOICE_CHANNEL_ID"].map((key) => [key, process.env[key]]));
  process.env.DATABASE_PATH = ":memory:";
  delete process.env.TEST_GUILD_ID;
  delete process.env.TEST_VOICE_CHANNEL_ID;
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stopAll();
  mock.timers.reset();
  closeDatabase();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const GUILD = "start-guild";
/** Discord-looking user IDs: the brief refuses anything else. */
const id = (n: number) => `2000000000000000${String(n).padStart(2, "0")}`;
const A = id(1);
const B = id(2);
const C = id(3);
const F = id(4);
const AHRI = 103;
const LUX = 99;
const LEE_SIN = 64;
const STRANGER_CHAMPIONS = [22, 86, 238];
const ENEMY_CHAMPIONS = [222, 157, 412, 18, 11];
const SCORE: Record<HorseTier, number> = { 特等马: 9, 上等马: 7, 中等马: 5, 下等马: 3, 没有马: 1 };
const RUNNING_REPORT = "正在播报的上一局战报。";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** Lets queued promise callbacks run without real time passing; setImmediate is never faked here. */
async function flush(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function history(memberId: string, tiers: readonly HorseTier[], mock = false, championId = AHRI): HorseRecord[] {
  return tiers.map((tier, index) => makeHorseRecord({
    guildId: GUILD,
    discordUserId: memberId,
    matchId: `NA1_${memberId}_${index}`,
    playedAt: 1_800_000_000_000 + index * 3_600_000,
    championId,
    tier,
    score: SCORE[tier],
    mock,
  }));
}

interface Seat { puuid: string | null; teamId: 100 | 200; championId: number; smite?: boolean; bot?: boolean }

/**
 * A spectator game: the given seats, then strangers on team 100 and enemies on team 200 up to five a side.
 * Strangers and enemies have their own PUUIDs and champions so a leak would show.
 */
function spectatorGame(gameId: number, seats: Seat[], options: { start?: number; length?: number; queue?: number | null; map?: number | null } = {}): ActiveGame {
  const participants: ActiveGameParticipant[] = seats.map((seat) => ({
    puuid: seat.puuid, teamId: seat.teamId, championId: seat.championId, spell1Id: 4, spell2Id: seat.smite ? 11 : 14, bot: seat.bot ?? false,
  }));
  let stranger = 0;
  let enemy = 0;
  while (participants.filter((player) => player.teamId === 100).length < 5) {
    participants.push({ puuid: `puuid-stranger-${++stranger}`, teamId: 100, championId: STRANGER_CHAMPIONS[(stranger - 1) % 3], spell1Id: 4, spell2Id: 14, bot: false });
  }
  while (participants.filter((player) => player.teamId === 200).length < 5) {
    participants.push({ puuid: `puuid-enemy-${++enemy}`, teamId: 200, championId: ENEMY_CHAMPIONS[enemy - 1], spell1Id: 4, spell2Id: 14, bot: false });
  }
  return {
    gameId,
    gameStartTime: options.start ?? 0,
    gameLength: options.length ?? 0,
    gameQueueConfigId: options.queue === undefined ? 420 : options.queue,
    mapId: options.map === undefined ? 11 : options.map,
    platformId: "NA1",
    participants,
    mock: false,
  };
}

interface MemberSpec { id: string; puuids: string[]; channel: string | null; names?: string[] }
interface FakeChannel { id: string; name: string; guild: { id: string }; members: Map<string, { user: { bot: boolean } }>; send: (message: MessageCreateOptions) => Promise<unknown> }

/**
 * A guild with tracked members in fake voice channels, the real monitor, watcher and voice queue,
 * and fake spectator, speech and Discord. Real mode unless `mock` is set.
 */
function harness(specs: MemberSpec[], options: { mock?: boolean; realSpectator?: boolean; watcherLog?: string[] } = {}) {
  let members: TrackedMember[] = specs.map((spec) => ({
    discordUserId: spec.id,
    accounts: spec.puuids.map((puuid, index) => ({ puuid, gameName: spec.names?.[index] ?? `Stored-${puuid}`, tagLine: "NA1" })),
  }));
  const sent: Array<{ channelId: string; message: MessageCreateOptions }> = [];
  const order: string[] = [];
  const channels = new Map<string, FakeChannel>();
  const channel = (channelId: string): FakeChannel => {
    let existing = channels.get(channelId);
    if (!existing) {
      const created: FakeChannel = {
        id: channelId,
        name: channelId,
        guild: { id: GUILD },
        members: new Map(),
        send: async (message) => { sent.push({ channelId: created.id, message }); order.push("text"); return {}; },
      };
      existing = created;
      channels.set(channelId, existing);
    }
    return existing;
  };
  const location = new Map<string, string | null>();
  const blocked = new Set<string>();
  /** Channels the text may go to but the voice cannot use: full, AFK, or without Connect or Speak. */
  const voiceBlocked = new Set<string>();
  const move = (memberId: string, channelId: string | null) => {
    const previous = location.get(memberId);
    if (previous) channel(previous).members.delete(memberId);
    location.set(memberId, channelId);
    if (channelId) channel(channelId).members.set(memberId, { user: { bot: false } });
  };
  for (const spec of specs) move(spec.id, spec.channel);

  let clock = 1_900_000_000_000;
  const games = new Map<string, ActiveGame | Error>();
  const requests: string[] = [];
  const records = new Map<string, HorseRecord[]>();
  const latest = new Map<string, string | null>();
  const matches = new Map<string, MatchDetail>();
  const generated: string[] = [];
  const played: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const settings = { voice: true, failMembers: false };
  let generate = async (text: string): Promise<string> => { generated.push(text); order.push(`voice:${text}`); return `audio-${generated.length}.wav`; };
  let play: VoiceAnnouncementDependencies["play"] = async (target) => { played.push(target.id); };
  const service = new VoiceAnnouncementService({
    split: (text) => [text],
    generate: (text) => generate(text),
    play: (...args) => play(...args),
    cleanup: async () => undefined,
  });
  const dependencies: MonitorDependencies = {
    latest: async (puuid) => latest.get(puuid) ?? null,
    detail: async (matchId) => {
      const detail = matches.get(matchId);
      if (!detail) throw new Error(`no match ${matchId}`);
      return detail;
    },
    members: () => { if (settings.failMembers) throw new Error("SQLITE_BUSY: database is locked"); return members; },
    resolveChannel: (_client, _guildId, userId) => {
      const channelId = location.get(userId);
      return channelId && !blocked.has(channelId) && !voiceBlocked.has(channelId) ? channel(channelId) as unknown as VoiceChannel : null;
    },
    resolveTextChannel: (_client, _guildId, userId) => {
      const channelId = location.get(userId);
      return channelId && !blocked.has(channelId) ? channel(channelId) as unknown as VoiceChannel : null;
    },
    announce: (...args) => service.announce(...args),
    events: async () => null,
    record: (batch) => batch.length,
    mock: () => options.mock ?? false,
    log: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    info: (message) => { infos.push(message); },
    gameStart: {
      activeGame: async (puuid) => {
        requests.push(puuid);
        if (options.realSpectator) return getActiveGame(puuid);
        const game = games.get(puuid);
        if (game instanceof Error) throw game;
        return game ?? null;
      },
      records: (_guildId, memberId, isMock) => (records.get(memberId) ?? []).filter((record) => record.mock === isMock),
      pregameVoice: () => settings.voice,
      voiceStyle: () => "old",
      now: () => clock,
      ...(options.watcherLog ? { log: (error: unknown) => { options.watcherLog!.push(error instanceof Error ? error.message : String(error)); } } : {}),
    },
  };
  const monitor = new GameMonitor(dependencies);
  monitors.push(monitor);
  const client = {} as Client;
  const inVoice = () => members.filter((member) => location.get(member.discordUserId)).map((member) => member.discordUserId);
  /** Every bound account in the game answers with it, the way Riot answers for each player in it. */
  const enter = (game: ActiveGame) => {
    for (const player of game.participants) if (player.puuid && members.some((member) => member.accounts.some((account) => account.puuid === player.puuid))) games.set(player.puuid, game);
  };
  const leaveGame = (game: ActiveGame) => {
    for (const player of game.participants) if (player.puuid) games.delete(player.puuid);
  };
  return {
    monitor, client, channel, move, blocked, voiceBlocked, games, requests, records, latest, matches, generated, played, errors, infos, settings, sent, order, enter, leaveGame,
    dependencies,
    /** The fake clock the watcher reads. */
    now: () => clock,
    get messages() { return sent.map((entry) => entry.message); },
    get members() { return members; },
    set members(value: TrackedMember[]) { members = value; },
    set generate(value: (text: string) => Promise<string>) { generate = value; },
    set play(value: VoiceAnnouncementDependencies["play"]) { play = value; },
    advance: (ms: number) => { clock += ms; },
    sync: () => monitor.sync(client, GUILD, inVoice()),
    /** Starts the session; its watcher checks at once, and this waits for that first check. */
    start: async () => {
      monitor.sync(client, GUILD, inVoice());
      return (await monitor.pollGameStart(GUILD)).tick;
    },
    /** One more check, as the 20 second timer would run it: the clock moves on by the interval first. */
    tick: async () => { clock += GAME_START_INTERVAL_MS; return (await monitor.pollGameStart(GUILD)).tick; },
    /** Holds the guild's voice queue with a running report until released. */
    holdQueue: () => {
      const gate = deferred();
      const original = play;
      let started = false;
      play = async (target, audio, timeout, signal) => {
        if (!started) {
          started = true;
          played.push(target.id);
          await gate.promise;
          return;
        }
        return original(target, audio, timeout, signal);
      };
      const running = service.announce(GUILD, RUNNING_REPORT, "old", () => channel("voice-1") as unknown as VoiceChannel);
      running.catch(() => undefined);
      return { release: async () => { gate.resolve(); await running; }, running };
    },
  };
}

type Harness = ReturnType<typeof harness>;
const embedOf = (message: MessageCreateOptions) => JSON.stringify((message.embeds![0] as { toJSON(): unknown }).toJSON());
const pregameSpeech = (bot: Harness) => bot.generated.filter((text) => text !== RUNNING_REPORT);

test("a game loading on the first check posts the 锦囊 text, then speaks it", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.records.set(A, history(A, ["上等马", "特等马", "特等马"]));
  bot.enter(spectatorGame(5001, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  const tick = await bot.start();
  assert.deepEqual(tick, { started: 1, posted: 1, errors: 0 });
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].channelId, "voice-1");
  const message = bot.sent[0].message;
  assert.equal(message.content, `<@${A}>`);
  assert.match(embedOf(message), /"title":"军师赛前锦囊"/);
  await until(() => bot.played.length === 1, "the voice line");
  assert.equal(pregameSpeech(bot).length, 1);
  assert.ok(!pregameSpeech(bot)[0].startsWith(MOCK_PREGAME_PREFIX));
  // Text before voice.
  assert.deepEqual(bot.order.map((entry) => entry.split(":")[0]), ["text", "voice"]);
  assert.ok(bot.infos.some((line) => line.includes("Detected game start NA1_5001: loading")));
});

test("a premade costs one request, is announced once, and is rechecked only every sixth tick", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-1" },
  ]);
  bot.enter(spectatorGame(5002, [
    { puuid: "acct-a", teamId: 100, championId: AHRI },
    { puuid: "acct-b", teamId: 100, championId: LUX },
  ]));
  await bot.start();
  assert.deepEqual(bot.requests, ["acct-a"]);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].message.content, `<@${A}> <@${B}>`);
  await until(() => bot.played.length === 1, "the voice line");
  for (let tick = 2; tick <= 6; tick++) await bot.tick();
  assert.deepEqual(bot.requests, ["acct-a"], "nobody in a seen game is asked again before the sixth tick");
  await bot.tick();
  assert.deepEqual(bot.requests, ["acct-a", "acct-a"], "the sixth tick rechecks once for the premade");
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.played.length, 1);
});

test("a game already in progress on the first check stays silent, even once it is a minute old", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.enter(spectatorGame(5003, [{ puuid: "acct-a", teamId: 100, championId: AHRI }], { start: 1_899_999_000_000, length: 30 }));
  assert.deepEqual(await bot.start(), { started: 0, posted: 0, errors: 0 });
  await delay(20);
  assert.equal(bot.sent.length, 0);
  assert.deepEqual(bot.generated, []);
  assert.ok(bot.infos.some((line) => line.includes("NA1_5003 is not announced at its start: it was already 30 s in")));
});

test("no game, then a loading game, is announced; no game, then a game under a minute old, too; older stays silent", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-2" },
    { id: C, puuids: ["acct-c"], channel: "voice-3" },
  ]);
  await bot.start();
  assert.deepEqual(bot.requests, ["acct-a", "acct-b", "acct-c"]);
  assert.equal(bot.sent.length, 0);
  bot.enter(spectatorGame(5004, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  bot.enter(spectatorGame(5005, [{ puuid: "acct-b", teamId: 100, championId: AHRI }], { start: 1_899_999_990_000, length: 60 }));
  bot.enter(spectatorGame(5006, [{ puuid: "acct-c", teamId: 100, championId: AHRI }], { start: 1_899_999_900_000, length: 61 }));
  const tick = await bot.tick();
  assert.equal(tick.started, 2);
  assert.deepEqual(bot.sent.map((entry) => entry.channelId), ["voice-1", "voice-2"]);
  assert.ok(bot.infos.some((line) => line.includes("NA1_5006 is not announced at its start: it was already 61 s in")));
});

test("ARAM, an unknown queue and a non-Rift map are ignored even while loading", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-1" },
    { id: C, puuids: ["acct-c"], channel: "voice-1" },
  ]);
  bot.enter(spectatorGame(5007, [{ puuid: "acct-a", teamId: 100, championId: AHRI }], { queue: 450, map: 12 }));
  bot.enter(spectatorGame(5008, [{ puuid: "acct-b", teamId: 100, championId: AHRI }], { queue: null }));
  bot.enter(spectatorGame(5009, [{ puuid: "acct-c", teamId: 100, championId: AHRI }], { map: 12 }));
  assert.equal((await bot.start()).started, 0);
  await delay(20);
  assert.equal(bot.sent.length, 0);
  assert.deepEqual(bot.generated, []);
  assert.ok(bot.infos.some((line) => line.includes("NA1_5007 is not announced at its start: queue 450 on map 12 is not announced")));
});

test("with the server's pregame voice off, only the text is posted", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.settings.voice = false;
  bot.enter(spectatorGame(5010, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await bot.start();
  assert.equal(bot.sent.length, 1);
  const outcome = await bot.monitor.pollGameStart(GUILD, "NA1_5010");
  assert.deepEqual(outcome.outcome, { textPosted: true, voice: "off" });
  await delay(20);
  assert.deepEqual(bot.generated, []);
  assert.deepEqual(bot.played, []);
});

test("a 锦囊 whose players are all in a channel the voice cannot use is posted there as text only, without a voice failure", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.voiceBlocked.add("voice-1");
  bot.enter(spectatorGame(5014, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await bot.start();
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].channelId, "voice-1");
  const outcome = await bot.monitor.pollGameStart(GUILD, "NA1_5014");
  assert.deepEqual(outcome.outcome, { textPosted: true, voice: "dropped" });
  await delay(20);
  assert.deepEqual(bot.generated, []);
  assert.deepEqual(bot.errors, []);
  assert.ok(bot.infos.some((line) => line.includes("NA1_5014 is text only")));
  await bot.tick();
  assert.equal(bot.sent.length, 1, "posted once");
});

test("the 90 second window: a 锦囊 with no usable channel waits, posts at 60 s, and is dropped after 90 s", async () => {
  const late = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  late.blocked.add("voice-1");
  late.enter(spectatorGame(5011, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await late.start();
  assert.equal(late.sent.length, 0);
  late.advance(60_000);
  await late.tick();
  assert.equal(late.sent.length, 0, "still no usable channel");
  late.blocked.delete("voice-1");
  late.advance(GAME_START_WINDOW_MS - 60_000);
  await late.tick();
  assert.equal(late.sent.length, 0, "too late for the loading screen");
  assert.ok(late.infos.some((line) => line.includes("NA1_5011 was dropped")));
  await late.tick();
  assert.equal(late.sent.length, 0);

  const inTime = harness([{ id: B, puuids: ["acct-b"], channel: "voice-1" }]);
  inTime.blocked.add("voice-1");
  inTime.enter(spectatorGame(5012, [{ puuid: "acct-b", teamId: 100, championId: AHRI }]));
  await inTime.start();
  inTime.advance(60_000);
  inTime.blocked.delete("voice-1");
  await inTime.tick();
  assert.equal(inTime.sent.length, 1);
  await until(() => inTime.played.length === 1, "the voice line");
});

test("the 90 second window also drops a queued line that could not start in time; the text stays", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.enter(spectatorGame(5013, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  bot.sync();
  const held = bot.holdQueue();
  await bot.tick();
  assert.equal(bot.sent.length, 1);
  bot.advance(GAME_START_WINDOW_MS);
  await held.release();
  await delay(20);
  assert.deepEqual(pregameSpeech(bot), []);
  await bot.tick();
  assert.ok(bot.infos.some((line) => line.includes("NA1_5013 was dropped: its voice line could not start")));
  assert.deepEqual(pregameSpeech(bot), []);
});

test("a line queued behind a running report waits for it, then plays; the report is never cut", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.enter(spectatorGame(5014, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  bot.sync();
  const held = bot.holdQueue();
  await until(() => bot.played.length === 1, "the running report to play");
  await bot.tick();
  assert.equal(bot.sent.length, 1, "the text does not wait for the voice queue");
  await delay(20);
  assert.deepEqual(bot.generated, [RUNNING_REPORT]);
  await held.release();
  await until(() => bot.played.length === 2, "the queued line");
  assert.equal(bot.generated.length, 2);
  assert.equal(bot.generated[0], RUNNING_REPORT);
});

test("a finished match for the same game cancels a line that has not played", async () => {
  const second = harness([{ id: B, puuids: ["acct-b"], channel: "voice-1" }]);
  const ended = spectatorGame(5016, [{ puuid: "acct-b", teamId: 100, championId: AHRI }]);
  second.enter(ended);
  // The queue is busy before the session starts, so the line has to wait.
  const held = second.holdQueue();
  second.sync();
  await second.monitor.poll(second.client, GUILD);
  await second.tick();
  assert.equal(second.sent.length, 1);
  // The game ends and the match poll finds it while the line still waits in the queue.
  second.leaveGame(ended);
  const detail = testMatch("NA1_5016", ["acct-b"]);
  detail.info.gameEndTimestamp = Date.now();
  second.matches.set("NA1_5016", detail);
  second.latest.set("acct-b", "NA1_5016");
  const poll = second.monitor.poll(second.client, GUILD);
  await until(() => second.infos.some((line) => line.includes("Detected finished match NA1_5016")), "the finished match");
  await held.release();
  await poll;
  const spoken = pregameSpeech(second);
  assert.equal(spoken.length, 1, "only the finished report is spoken, not the pregame line");
  assert.match(spoken[0], /本局马匹鉴定/);
  assert.deepEqual((await second.monitor.pollGameStart(GUILD, "NA1_5016")).outcome, { textPosted: true, voice: "dropped" });
  assert.equal(second.sent.length, 2);
});

test("the teammate leaving before playback cancels the line; it plays when they return within the window", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: F, puuids: ["acct-friend"], channel: "voice-1" },
  ]);
  // A tie in the channel goes to the earliest-bound member's team, so A's team is rated.
  bot.enter(spectatorGame(5017, [
    { puuid: "acct-a", teamId: 100, championId: AHRI },
    { puuid: "acct-friend", teamId: 200, championId: LUX },
  ]));
  bot.sync();
  const held = bot.holdQueue();
  await bot.tick();
  assert.equal(bot.sent.length, 1);
  bot.move(A, null);
  bot.sync();
  await held.release();
  await delay(20);
  assert.deepEqual(pregameSpeech(bot), [], "F is still in voice, but on the other team, so nobody of the rated team would hear it");
  bot.move(A, "voice-1");
  bot.sync();
  await bot.tick();
  await until(() => pregameSpeech(bot).length === 1, "the retried line");
  await until(() => bot.played.length === 2, "its playback");
  assert.equal(bot.sent.length, 1, "the text is posted once");
});

test("a member who leaves and comes back starts a new presence and is checked at once", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }, { id: B, puuids: ["acct-b"], channel: "voice-2" }]);
  const running = spectatorGame(5025, [{ puuid: "acct-a", teamId: 100, championId: AHRI }], { start: 1_899_999_000_000, length: 900 });
  bot.enter(running);
  await bot.start();
  assert.equal(bot.sent.length, 0);
  // A leaves voice, the game ends and the next one is loading when A is back, well before the sixth tick.
  bot.move(A, null);
  bot.sync();
  bot.leaveGame(running);
  bot.enter(spectatorGame(5026, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  const before = bot.requests.length;
  // Away for a while: each account is asked at most once per interval.
  bot.advance(GAME_START_INTERVAL_MS);
  bot.move(A, "voice-1");
  // Their return alone triggers a check, long before the next 20 second tick.
  bot.sync();
  await until(() => bot.sent.length === 1, "the 锦囊 after the return");
  assert.ok(bot.infos.some((line) => line.includes("Detected game start NA1_5026")));
  assert.deepEqual(bot.requests.slice(before), ["acct-a", "acct-b"], "one early check of everyone in the session");
  // A sync that adds nobody, such as a channel move, does not check early.
  bot.move(B, "voice-1");
  bot.sync();
  await delay(20);
  assert.deepEqual(bot.requests.slice(before), ["acct-a", "acct-b"]);
});

test("the teammate leaving during playback does not cut the line; the last member leaving stops it", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-1" },
  ]);
  bot.enter(spectatorGame(5018, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  const gate = deferred();
  let started = false;
  bot.play = async (target) => { started = true; await gate.promise; bot.played.push(target.id); };
  await bot.start();
  await until(() => started, "playback");
  bot.move(A, null);
  bot.sync();
  gate.resolve();
  await until(() => bot.played.length === 1, "the line to finish");
  assert.deepEqual((await bot.monitor.pollGameStart(GUILD, "NA1_5018")).outcome, { textPosted: true, voice: "played" });

  const alone = harness([{ id: C, puuids: ["acct-c"], channel: "voice-1" }]);
  alone.enter(spectatorGame(5019, [{ puuid: "acct-c", teamId: 100, championId: AHRI }]));
  let aborted = false;
  let playing = false;
  alone.play = (_target, _audio, _timeout, signal) => new Promise<void>((_resolve, reject) => {
    playing = true;
    signal?.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  await alone.start();
  await until(() => playing, "playback");
  alone.move(C, null);
  alone.sync();
  await until(() => aborted, "the abort");
});

test("the team with most members in the channel is rated; a friend on the other side is mentioned, never named or rated", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1", names: ["BlueSideFriend"] },
    { id: B, puuids: ["acct-b"], channel: "voice-1", names: ["RedOne"] },
    { id: C, puuids: ["acct-c"], channel: "voice-1", names: ["RedTwo"] },
  ]);
  bot.records.set(A, history(A, ["特等马", "特等马", "特等马", "特等马"]));
  bot.records.set(B, history(B, ["上等马", "上等马", "上等马"]));
  bot.records.set(C, history(C, ["中等马", "中等马", "中等马"]));
  bot.enter(spectatorGame(5020, [
    { puuid: "acct-a", teamId: 100, championId: LEE_SIN },
    { puuid: "acct-b", teamId: 200, championId: AHRI },
    { puuid: "acct-c", teamId: 200, championId: LUX },
  ]));
  await bot.start();
  await until(() => bot.played.length === 1, "the voice line");
  const message = bot.sent[0].message;
  assert.equal(message.content, `<@${A}> <@${B}> <@${C}>`);
  const embed = embedOf(message);
  assert.ok(embed.includes(`<@${B}>`) && embed.includes(`<@${C}>`));
  assert.ok(!embed.includes(A), "the friend on team 100 is not on the card");
  assert.ok(embed.includes(OTHER_SIDE_NOTE));
  assert.ok(embed.includes("还有 3 位路人队友"));
  const speech = pregameSpeech(bot)[0];
  assert.ok(!speech.includes("BlueSideFriend") && !speech.includes("李青"));
  assert.ok(!embed.includes("BlueSideFriend") && !embed.includes("李青"));
});

test("allowedMentions is exactly the game's bound players in the posting channel", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-2" },
    { id: C, puuids: ["acct-c"], channel: "voice-1" },
  ]);
  bot.enter(spectatorGame(5021, [
    { puuid: "acct-a", teamId: 100, championId: AHRI },
    { puuid: "acct-b", teamId: 100, championId: LUX },
  ]));
  await bot.start();
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].channelId, "voice-1");
  const message = bot.sent[0].message;
  assert.equal(message.content, `<@${A}>`);
  assert.deepEqual(message.allowedMentions, { parse: [], roles: [], users: [A], repliedUser: false });
});

test("nothing about enemies, strangers or the friend on the other side reaches the posted card or the speech", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1", names: ["AllyOne"] },
    { id: B, puuids: ["acct-b"], channel: "voice-1", names: ["AllyTwo"] },
    { id: F, puuids: ["acct-friend"], channel: "voice-1", names: ["FriendOnTheOtherSide"] },
  ]);
  bot.records.set(A, history(A, ["中等马", "上等马", "特等马", "特等马"]));
  bot.records.set(B, history(B, ["上等马", "下等马", "没有马", "没有马"], false, LUX));
  // The friend's record is the best by far: if they reached the builder they would be the pick.
  bot.records.set(F, history(F, ["特等马", "特等马", "特等马", "特等马", "特等马"], false, LEE_SIN));
  bot.enter(spectatorGame(5022, [
    { puuid: "acct-a", teamId: 100, championId: AHRI },
    { puuid: "acct-b", teamId: 100, championId: LUX },
    { puuid: "acct-friend", teamId: 200, championId: LEE_SIN },
  ]));
  await bot.start();
  await until(() => bot.played.length === 1, "the voice line");
  const everything = `${pregameSpeech(bot).join("\n")}\n${embedOf(bot.sent[0].message)}`;
  for (const secret of [
    "puuid-", "acct-", "FriendOnTheOtherSide", F, "Stored-",
    "金克丝", "亚索", "锤石", "崔丝塔娜", "李青", // the other team's champions
    "艾希", "盖伦", "劫", // the strangers' champions
  ]) assert.ok(!everything.includes(secret), `${secret} must not appear`);
  assert.ok(everything.includes("AllyOne") || everything.includes(A));
  // The friend is still told about the game in the channel.
  assert.ok(bot.sent[0].message.content!.includes(`<@${F}>`));
});

test("names come from the stored binding, never the spectator riotId, and mock 锦囊 are labeled", async () => {
  process.env.RIOT_MODE = "mock";
  resetMockData();
  const bot = harness([{ id: A, puuids: ["MOCK-stored-a"], channel: "voice-1", names: ["存的名字"] }], { mock: true, realSpectator: true });
  bot.records.set(A, history(A, ["特等马", "特等马", "特等马"], true));
  const { matchId } = simulateMockGameStart(["MOCK-stored-a"]);
  bot.sync();
  const { outcome } = await bot.monitor.pollGameStart(GUILD, matchId, "voice-1");
  assert.deepEqual(outcome, { textPosted: true, voice: "played" });
  const speech = pregameSpeech(bot)[0];
  assert.ok(speech.startsWith(MOCK_PREGAME_PREFIX));
  assert.ok(speech.includes("存的名字"));
  const embed = embedOf(bot.sent[0].message);
  assert.match(embed, /"title":"模拟数据 · 军师赛前锦囊"/);
  assert.match(embed, /模拟数据 \/ Mock data/);
  for (const text of [speech, embed]) assert.ok(!text.includes("模拟队友") && !text.includes("模拟对手") && !text.includes("MOCK-ALLY"));
});

test("in real mode a saved mock account is skipped without a request or a watcher log", async () => {
  const bot = harness([{ id: A, puuids: ["MOCK-old", "acct-a"], channel: "voice-1" }]);
  await bot.start();
  assert.deepEqual(bot.requests, ["acct-a"]);
  assert.ok(!bot.errors.some((line) => /game start|锦囊/i.test(line)));
});

test("a spectator 403 turns off only the watcher; finished matches are still announced", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.games.set("acct-a", new RiotApiError("Riot API rejected the key.", "forbidden", 403));
  const first = await bot.start();
  assert.equal(first.errors, 1);
  assert.equal(bot.errors.filter((line) => line.includes("game start checks are off")).length, 1);
  await bot.tick();
  await bot.tick();
  assert.deepEqual(bot.requests, ["acct-a"], "no more spectator requests in this session");
  assert.equal(bot.monitor.status(GUILD).active, true);
  bot.matches.set("NA1_6001", testMatch("NA1_6001", ["acct-a"]));
  bot.matches.get("NA1_6001")!.info.gameEndTimestamp = Date.now();
  bot.latest.set("acct-a", "NA1_6001");
  assert.deepEqual(await bot.monitor.poll(bot.client, GUILD), { announced: 1, errors: 0 });
});

test("a spectator rate limit is quiet; an unexpected 404 is logged once and never turns the watcher off", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.games.set("acct-a", new RiotApiError("Riot API rate limit reached.", "rate_limited", 429));
  assert.deepEqual(await bot.start(), { started: 0, posted: 0, errors: 0 });
  await bot.tick();
  assert.deepEqual(bot.errors, []);
  assert.equal(bot.requests.length, 2, "the next tick asks again");
  bot.games.set("acct-a", new RiotApiError("Riot API returned an unexpected 404 for an active game lookup.", "invalid_response", 404));
  for (let tick = 0; tick < 3; tick++) assert.equal((await bot.tick()).errors, 1);
  assert.equal(bot.errors.length, 1);
  assert.match(bot.errors[0], /unexpected 404.*logged once/);
  bot.enter(spectatorGame(5023, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  assert.equal((await bot.tick()).started, 1, "the watcher is still on");
});

test("ten accounts cost at most 60 spectator requests in two minutes, and a game in progress far fewer", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const specs = Array.from({ length: 10 }, (_, index) => ({ id: id(20 + index), puuids: [`acct-${index}`], channel: "voice-1" }));
  const bot = harness(specs);
  bot.sync();
  await flush();
  for (let elapsed = GAME_START_INTERVAL_MS; elapsed < 120_000; elapsed += GAME_START_INTERVAL_MS) {
    bot.advance(GAME_START_INTERVAL_MS);
    mock.timers.tick(GAME_START_INTERVAL_MS);
    await flush();
  }
  assert.equal(bot.requests.length, 60, "six ticks in two minutes, one request per account");
  // Everyone queues into one game that is already running: one request finds it for all ten.
  const game = spectatorGame(5024, specs.map((spec, index) => ({ puuid: spec.puuids[0], teamId: index < 5 ? 100 : 200, championId: AHRI })),
    { start: 1_899_999_000_000, length: 400 });
  bot.enter(game);
  bot.requests.length = 0;
  for (let elapsed = 0; elapsed < 120_000; elapsed += GAME_START_INTERVAL_MS) {
    bot.advance(GAME_START_INTERVAL_MS);
    mock.timers.tick(GAME_START_INTERVAL_MS);
    await flush();
  }
  assert.deepEqual(bot.requests, ["acct-0"], "one request finds the game, then nobody is asked for five ticks");
  bot.advance(GAME_START_INTERVAL_MS);
  mock.timers.tick(GAME_START_INTERVAL_MS);
  await flush();
  assert.deepEqual(bot.requests, ["acct-0", "acct-0"], "the sixth tick rechecks once");
  assert.equal(bot.sent.length, 0, "a game already running is not announced");
});

test("the only member leaving and rejoining voice during loading gets one 锦囊, not two", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.enter(spectatorGame(7001, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await bot.start();
  await until(() => bot.played.length === 1, "the first line");
  // Leaving stops the session; rejoining starts a new one whose first check sees the same game still loading.
  bot.move(A, null);
  bot.sync();
  assert.equal(bot.monitor.status(GUILD).active, false);
  bot.advance(GAME_START_INTERVAL_MS);
  bot.move(A, "voice-1");
  await bot.start();
  await bot.tick();
  await delay(30);
  assert.equal(bot.requests.length, 2, "the new session did ask");
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.played.length, 1);
  assert.ok(bot.infos.some((line) => line.includes("NA1_7001 is not announced at its start: its 锦囊 already went out in an earlier monitoring session")));
});

test("the guild forgets a 锦囊 15 minutes after it went out", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.settings.voice = false;
  bot.enter(spectatorGame(8100, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  /** The only member is back after a while: a new session, whose first check asks again. */
  const rejoin = async (awayMs: number) => {
    bot.move(A, null);
    bot.sync();
    bot.advance(awayMs);
    bot.move(A, "voice-1");
    await bot.start();
  };
  await bot.start();
  await rejoin(14 * 60_000);
  assert.equal(bot.sent.length, 1, "still remembered after 14 minutes");
  await rejoin(60_000);
  assert.equal(bot.sent.length, 2, "forgotten at 15 minutes");
});

test("the guild remembers at most 50 锦囊, forgetting the oldest first", async () => {
  // Fifty-one members, each loading into their own game; the last one joins voice a moment later.
  const specs = Array.from({ length: 51 }, (_, index) => ({
    id: `3000000000000000${String(index).padStart(2, "0")}`, puuids: [`acct-${index}`], channel: index < 50 ? "voice-1" : null,
  }));
  const bot = harness(specs);
  bot.settings.voice = false;
  for (const [index, spec] of specs.entries()) bot.enter(spectatorGame(8200 + index, [{ puuid: spec.puuids[0], teamId: 100, championId: AHRI }]));
  await bot.start();
  assert.equal(bot.sent.length, 50);
  bot.move(specs[50].id, "voice-1");
  bot.sync();
  await until(() => bot.sent.length === 51, "the fifty-first 锦囊");
  // Everyone leaves; the first member comes back while their game still loads. Their 锦囊 was the oldest, so it is forgotten.
  for (const spec of specs) bot.move(spec.id, null);
  bot.sync();
  bot.advance(GAME_START_INTERVAL_MS);
  bot.move(specs[0].id, "voice-1");
  await bot.start();
  assert.equal(bot.sent.length, 52);
  assert.equal(bot.sent[51].message.content, `<@${specs[0].id}>`);
  // Remembering the first again pushed out the second; the third is still among the newest 50.
  bot.move(specs[2].id, "voice-1");
  bot.sync();
  await bot.monitor.pollGameStart(GUILD);
  await delay(20);
  assert.equal(bot.sent.length, 52);
});

test("a failure inside a tick is logged once and counted; the watcher never rejects", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
    await bot.start();
    bot.settings.failMembers = true;
    assert.deepEqual(await bot.tick(), { started: 0, posted: 0, errors: 1 });
    assert.deepEqual(await bot.tick(), { started: 0, posted: 0, errors: 1 });
    assert.equal(bot.errors.length, 1);
    assert.match(bot.errors[0], /A game start check broke off: SQLITE_BUSY/);
    // The timer fires the tick without waiting for it: nothing may escape that path either.
    bot.settings.failMembers = false;
    bot.move(A, null);
    bot.sync();
    mock.timers.enable({ apis: ["setInterval"] });
    bot.move(A, "voice-1");
    bot.sync();
    await flush();
    bot.settings.failMembers = true;
    for (let tick = 0; tick < 3; tick++) {
      bot.advance(GAME_START_INTERVAL_MS);
      mock.timers.tick(GAME_START_INTERVAL_MS);
      await flush();
    }
    await delay(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("after logged failures, the first check that works says so once", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.games.set("acct-a", new RiotApiError("Riot API returned an invalid active game.", "invalid_response"));
  await bot.start();
  await bot.tick();
  assert.equal(bot.errors.length, 1);
  bot.games.delete("acct-a");
  await bot.tick();
  await bot.tick();
  assert.equal(bot.infos.filter((line) => line.includes("Game start checks work again after invalid_response")).length, 1);
  // A failure after the recovery is logged again.
  bot.games.set("acct-a", new RiotApiError("Riot API returned an invalid active game.", "invalid_response"));
  await bot.tick();
  assert.equal(bot.errors.length, 2);
});

test("the watcher's errors go to its own log, not the match monitor's", async () => {
  const watcherLog: string[] = [];
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }], { watcherLog });
  bot.games.set("acct-a", new RiotApiError("Riot API rejected the key.", "forbidden", 403));
  await bot.start();
  assert.equal(watcherLog.length, 1);
  assert.match(watcherLog[0], /game start checks are off/);
  assert.deepEqual(bot.errors, []);
});

test("the watcher logs with its own prefix, never as a failed match poll", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try {
    logGameStartFailure(new Error("Riot rejected the key for spectator (403), so game start checks are off for this monitoring session."));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Game start check failed: Riot rejected the key/);
  assert.doesNotMatch(lines[0], /Match monitoring failed/);
});

test("a member flapping in and out of voice never pushes an account past six requests in two minutes", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  // B stays, so the session lives and every return of A is an early check.
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }, { id: B, puuids: ["acct-b"], channel: "voice-1" }]);
  bot.sync();
  await flush();
  for (let step = 1; step < 60; step++) {
    // Every 2 seconds A leaves or comes back.
    bot.advance(2_000);
    mock.timers.tick(2_000);
    bot.move(A, step % 2 === 0 ? "voice-1" : null);
    bot.sync();
    await flush();
  }
  const count = (puuid: string) => bot.requests.filter((request) => request === puuid).length;
  assert.ok(count("acct-a") <= 6, `acct-a asked ${count("acct-a")} times`);
  assert.ok(count("acct-b") <= 6, `acct-b asked ${count("acct-b")} times`);

  // The only member flapping: every return starts a new session that checks at once.
  const solo = harness([{ id: C, puuids: ["acct-c"], channel: null }]);
  for (let step = 0; step < 60; step++) {
    solo.advance(2_000);
    mock.timers.tick(2_000);
    solo.move(C, step % 2 === 0 ? "voice-1" : null);
    solo.sync();
    await flush();
  }
  assert.ok(solo.requests.length <= 6, `acct-c asked ${solo.requests.length} times`);
  assert.ok(solo.requests.length >= 5, "but it is still checked about every 20 seconds");
});

// 锦囊回顾: the pick of a posted 锦囊 decorates the finished report's horse embed, text only.

type RecapField = { name: string; value: string };
const isReport = (message: MessageCreateOptions) => embedOf(message).includes("本局马匹鉴定");
const reportMessages = (bot: Harness) => bot.sent.filter((entry) => isReport(entry.message)).map((entry) => entry.message);
const recapFieldOf = (message: MessageCreateOptions): string | undefined =>
  ((message.embeds![0] as { toJSON(): { fields?: RecapField[] } }).toJSON().fields ?? []).find((field) => field.name === RECAP_FIELD_NAME)?.value;
/** The 锦囊回顾 field of the match's one finished report: undefined when the report has none. */
function recapOf(bot: Harness): string | undefined {
  const reports = reportMessages(bot);
  assert.equal(reports.length, 1, "exactly one finished report was posted");
  return recapFieldOf(reports[0]);
}
const reportSpeech = (bot: Harness) => bot.generated.filter((text) => text.includes("本局马匹鉴定"));

/** The game loads and its 锦囊 goes out; the first poll is behind it, so a finished match is announced afterwards. */
async function loadGame(bot: Harness, gameId: number, seats: Seat[]): Promise<ActiveGame> {
  const game = spectatorGame(gameId, seats);
  bot.enter(game);
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await bot.tick();
  return game;
}

/** The game ends and the match poll announces it; `shape` may rearrange the match before it is found. */
async function finishGame(bot: Harness, matchId: string, puuids: string[], shape: (detail: MatchDetail) => void = () => undefined) {
  const detail = testMatch(matchId, puuids);
  detail.info.gameEndTimestamp = Date.now();
  shape(detail);
  bot.matches.set(matchId, detail);
  for (const puuid of puuids) bot.latest.set(puuid, matchId);
  return bot.monitor.poll(bot.client, GUILD);
}

/** Names the player in the match as the report's row shows them; the recap must use this name, not the stored one. */
const named = (names: Record<string, string>) => (detail: MatchDetail) => {
  for (const player of detail.info.participants) if (names[player.puuid]) player.riotIdGameName = names[player.puuid];
};

/** The in-match name of the n-th player: Chinese, so the recap puts no space around it. */
const rowName = (index: number) => `${"甲乙丙丁戊"[index]}马`;

const SOLO_HISTORY: readonly HorseTier[] = ["上等马", "特等马", "特等马"];
const ALL_TIERS: readonly HorseTier[] = ["特等马", "上等马", "中等马", "下等马", "没有马"];

test("the finished report of a game whose 锦囊 had a pick shows the 锦囊回顾, worded by the pick's tier in the match", async () => {
  const seen = new Set<HorseTier>();
  for (let slot = 0; slot < 5; slot++) {
    const members = Array.from({ length: 5 }, (_, index) => ({ id: id(30 + index), puuids: [`acct-${index}`], channel: "voice-1", names: [`旧名${index}`] }));
    const bot = harness(members);
    // Only this member has a history, so the 军师 can only pick them.
    bot.records.set(id(30 + slot), history(id(30 + slot), SOLO_HISTORY));
    const puuids = members.map((member) => member.puuids[0]);
    const matchId = `NA1_${9000 + slot}`;
    await loadGame(bot, 9000 + slot, puuids.map((puuid) => ({ puuid, teamId: 100, championId: AHRI })));
    assert.ok(embedOf(bot.sent[0].message).includes("军师之选"), "the card made a pick");
    await finishGame(bot, matchId, puuids, named(Object.fromEntries(puuids.map((puuid, index) => [puuid, rowName(index)]))));
    const tier = rankTeam(bot.matches.get(matchId)!, puuids[0]).horses.find((horse) => horse.participant.puuid === puuids[slot])!.tier;
    seen.add(tier);
    const recap = recapOf(bot);
    assert.ok(recap, `slot ${slot} has a recap`);
    assert.equal(recap, buildPregameRecap({ matchId, name: rowName(slot), tier }));
    assert.ok(recap.includes(tier) && recap.startsWith(`军师点名的${rowName(slot)}本局`), recap);
    assert.ok(embedOf(reportMessages(bot)[0]).includes(rowName(slot)), "the row above shows the same name");
    for (let other = 0; other < 5; other++) assert.equal(recap.includes(rowName(other)), other === slot, "only the pick is named");
    assert.ok(!recap.includes("旧名") && !recap.includes("Stored-") && !recap.includes("#NA1"), "the row name, never the stored name or a Riot ID");
  }
  assert.deepEqual([...seen].sort(), [...ALL_TIERS].sort(), "every tier was exercised");
});

test("the recap wording by tier: the 军师 owns a bad call, no em dash, sanitized names", () => {
  for (const tier of ALL_TIERS) {
    assert.ok(RECAP_PHRASES[tier].length >= 2, `${tier} has a small pool`);
    for (const phrase of RECAP_PHRASES[tier]) {
      const line = phrase("小明");
      assert.ok(line.startsWith("军师点名的小明") && line.includes(tier) && line.endsWith("。"), line);
      assert.ok(!line.includes("\u2014"), line);
    }
  }
  // A bad call is the 军师's to own after the name: it says so and never blames the player.
  for (const tier of ["下等马", "没有马"] as const) {
    for (const phrase of RECAP_PHRASES[tier]) {
      const verdict = phrase("小明").replace(/^军师点名的小明[^，]*，/u, "");
      assert.match(verdict, /军师/u, verdict);
      assert.ok(!/(菜|废|垃圾|太差|不行|拖累|坑)/u.test(verdict), verdict);
    }
  }
  assert.match(buildPregameRecap({ matchId: "NA1_1", name: "<@123>`*bad*`", tier: "特等马" }), /^军师点名的[^<>`*]+特等马/u);
});

test("the name gets a space only where a letter or digit meets Chinese text", () => {
  const line = (name: string) => buildPregameRecap({ matchId: "NA1_7", name, tier: "特等马" });
  assert.equal(spacedName("小明"), "小明");
  assert.equal(spacedName("Faker"), " Faker ");
  assert.equal(spacedName("小明2"), "小明2 ");
  assert.equal(spacedName("Ab小"), " Ab小");
  assert.equal(spacedName("小_明"), "小_明");
  assert.match(line("Faker"), /^军师点名的 Faker (本局|果然是本局)/u);
  assert.match(line("小明"), /^军师点名的小明(本局|果然是本局)/u);
  for (const tier of ALL_TIERS) {
    for (let index = 0; index < 20; index++) {
      const text = buildPregameRecap({ matchId: `NA1_${index}`, name: "Ab小c", tier });
      assert.ok(text.startsWith("军师点名的 Ab小c ") && text.includes(tier), text);
    }
  }
});

test("the recap is deterministic per match and varies between matches", () => {
  const line = (matchId: string) => buildPregameRecap({ matchId, name: "小明", tier: "特等马" });
  assert.equal(line("NA1_42"), line("NA1_42"));
  const lines = new Set(Array.from({ length: 30 }, (_, index) => line(`NA1_${index}`)));
  assert.ok(lines.size > 1, "different matches do not all get the same wording");
});

test("the recap changes nothing in the spoken report", async () => {
  const run = async (withPick: boolean) => {
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1", names: ["小明"] }]);
    if (withPick) bot.records.set(A, history(A, SOLO_HISTORY));
    await loadGame(bot, 9100, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
    await finishGame(bot, "NA1_9100", ["acct-a"]);
    return bot;
  };
  const decorated = await run(true);
  const plain = await run(false);
  assert.ok(recapOf(decorated), "the text has the recap");
  assert.equal(recapOf(plain), undefined);
  assert.equal(reportSpeech(decorated).length, 1);
  assert.deepEqual(reportSpeech(decorated), reportSpeech(plain), "byte-identical speech");
  assert.ok(!reportSpeech(decorated)[0].includes("军师点名") && !reportSpeech(decorated)[0].includes(RECAP_FIELD_NAME));
});

test("no 锦囊回顾 without a 锦囊, without a pick, or when the pick was for another game", async () => {
  // A finished match with no game start at all (the bot was off, or not watching).
  const none = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  none.records.set(A, history(A, SOLO_HISTORY));
  none.sync();
  await none.monitor.poll(none.client, GUILD);
  await finishGame(none, "NA1_9200", ["acct-a"]);
  assert.equal(recapOf(none), undefined);

  // Cold start: fewer than three records, so the card made no pick.
  const cold = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  cold.records.set(A, history(A, ["特等马", "特等马"]));
  await loadGame(cold, 9201, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
  assert.equal(cold.sent.length, 1, "the card was posted");
  await finishGame(cold, "NA1_9201", ["acct-a"]);
  assert.equal(recapOf(cold), undefined);

  // A pick for another game is not this game's.
  const other = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  other.records.set(A, history(A, SOLO_HISTORY));
  await loadGame(other, 9202, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
  await finishGame(other, "NA1_9203", ["acct-a"]);
  assert.equal(recapOf(other), undefined);
});

test("no 锦囊回顾 once the pick is no longer bound to that member", async () => {
  const setup = async () => {
    const bot = harness([
      { id: A, puuids: ["acct-a"], channel: "voice-1", names: ["小明"] },
      { id: B, puuids: ["acct-b"], channel: "voice-1", names: ["小红"] },
    ]);
    bot.records.set(A, history(A, SOLO_HISTORY));
    await loadGame(bot, 9300, [{ puuid: "acct-a", teamId: 100, championId: AHRI }, { puuid: "acct-b", teamId: 100, championId: LUX }]);
    assert.ok(embedOf(bot.sent[0].message).includes("军师之选"));
    return bot;
  };
  // Unbound: the member keeps another account.
  const unbound = await setup();
  unbound.members = [{ discordUserId: A, accounts: [{ puuid: "acct-a2", gameName: "小明", tagLine: "NA1" }] }, unbound.members[1]];
  await finishGame(unbound, "NA1_9300", ["acct-a", "acct-b"]);
  assert.equal(recapOf(unbound), undefined);

  // Rebound to somebody else: the account now belongs to B.
  const moved = await setup();
  moved.members = [{ discordUserId: A, accounts: [] }, { discordUserId: B, accounts: [moved.members[1].accounts[0], moved.members[0].accounts[0]] }];
  await finishGame(moved, "NA1_9300", ["acct-a", "acct-b"]);
  assert.equal(recapOf(moved), undefined);

  // Control: untouched bindings show it.
  const bound = await setup();
  await finishGame(bound, "NA1_9300", ["acct-a", "acct-b"], named({ "acct-a": "小明" }));
  assert.match(recapOf(bound)!, /小明/);
});

test("no 锦囊回顾 when the pick is on the other team from the report's perspective", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1", names: ["小明"] },
    { id: F, puuids: ["acct-friend"], channel: "voice-1", names: ["路过"] },
  ]);
  bot.records.set(A, history(A, SOLO_HISTORY));
  bot.records.set(F, history(F, ["中等马", "中等马", "中等马"]));
  await loadGame(bot, 9400, [{ puuid: "acct-a", teamId: 100, championId: AHRI }, { puuid: "acct-friend", teamId: 200, championId: LUX }]);
  assert.ok(embedOf(bot.sent[0].message).includes("军师之选"), "the card, from A's side, picked a teammate");
  // Only the friend on the other side is left to hear the report, so it takes their team's view.
  bot.move(A, null);
  bot.sync();
  await finishGame(bot, "NA1_9400", ["acct-a", "acct-friend"], (detail) => {
    // The fixture puts every extra tracked account on the first team; move the friend to the enemy team.
    const [friend, spare] = [detail.info.participants.find((player) => player.puuid === "acct-friend")!, detail.info.participants.find((player) => player.teamId === 200)!];
    friend.puuid = `moved-${friend.puuid}`;
    spare.puuid = "acct-friend";
  });
  assert.equal(reportMessages(bot).length, 1, "the report was posted");
  assert.ok(embedOf(reportMessages(bot)[0]).includes("本局马匹鉴定"));
  assert.equal(recapOf(bot), undefined);
});

test("a mock pick never decorates a real report, nor a real pick a mock one", async () => {
  for (const cardInMock of [true, false]) {
    const options = { mock: cardInMock };
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }], options);
    // The brief reads the records of the current data mode only; both modes have a history here.
    bot.records.set(A, [...history(A, SOLO_HISTORY, true), ...history(A, SOLO_HISTORY, false)]);
    await loadGame(bot, 9500, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
    assert.ok(embedOf(bot.sent[0].message).includes("军师之选"));
    options.mock = !cardInMock;
    await finishGame(bot, "NA1_9500", ["acct-a"]);
    assert.equal(recapOf(bot), undefined, cardInMock ? "mock pick, real report" : "real pick, mock report");
  }
  // Same mode on both sides: a mock game's recap shows, inside an embed that keeps its mock label.
  const options = { mock: true };
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }], options);
  bot.records.set(A, history(A, SOLO_HISTORY, true));
  await loadGame(bot, 9501, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
  await finishGame(bot, "NA1_9501", ["acct-a"]);
  assert.ok(recapOf(bot));
  assert.match(embedOf(reportMessages(bot)[0]), /模拟数据 \/ Mock data/);
});

test("the pick survives a session stop and restart during the game, and outlives the 15 minute 锦囊 memory", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1", names: ["小明"] }]);
  bot.records.set(A, history(A, SOLO_HISTORY));
  const game = await loadGame(bot, 9600, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
  // The only member leaves voice, so the session stops; two hours of a long game later they are back.
  bot.move(A, null);
  bot.sync();
  assert.equal(bot.monitor.status(GUILD).active, false);
  bot.advance(2 * 60 * 60_000);
  bot.leaveGame(game);
  bot.move(A, "voice-1");
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await finishGame(bot, "NA1_9600", ["acct-a"], named({ "acct-a": "小明" }));
  assert.match(recapOf(bot)!, /小明/);
});

test("the pick expires after its lifetime", async () => {
  const outcome = async (elapsed: number) => {
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
    bot.records.set(A, history(A, SOLO_HISTORY));
    await loadGame(bot, 9700, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
    bot.advance(elapsed);
    await finishGame(bot, "NA1_9700", ["acct-a"]);
    return recapOf(bot);
  };
  assert.equal(PICK_MEMORY_MS, 3 * 60 * 60_000);
  // The card goes out at the start of the session, at most one check (20 s) before the clock moves on.
  assert.ok(await outcome(PICK_MEMORY_MS - 60_000), "just inside the lifetime");
  assert.equal(await outcome(PICK_MEMORY_MS + 60_000), undefined, "just past the lifetime");
  assert.equal(await outcome(PICK_MEMORY_MS * 2), undefined, "long past the lifetime");
});

test("a guild remembers at most 50 picks, the oldest dropped first", async () => {
  // Fifty-one members, each alone in their own loading game with a history; the last one joins voice a moment later.
  const specs = Array.from({ length: 51 }, (_, index) => ({
    id: `3100000000000000${String(index).padStart(2, "0")}`, puuids: [`acct-${index}`], channel: index < 50 ? "voice-1" : null,
  }));
  const bot = harness(specs);
  bot.settings.voice = false;
  for (const [index, spec] of specs.entries()) {
    bot.records.set(spec.id, history(spec.id, SOLO_HISTORY));
    bot.enter(spectatorGame(9800 + index, [{ puuid: spec.puuids[0], teamId: 100, championId: AHRI }]));
  }
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await bot.monitor.pollGameStart(GUILD);
  assert.equal(bot.sent.length, 50);
  bot.move(specs[50].id, "voice-1");
  bot.sync();
  await until(() => bot.sent.length === 51, "the fifty-first 锦囊");
  await bot.monitor.poll(bot.client, GUILD);
  const decorated = async (index: number): Promise<boolean> => {
    const before = reportMessages(bot).length;
    await finishGame(bot, `NA1_${9800 + index}`, [specs[index].puuids[0]]);
    const posted = reportMessages(bot);
    assert.equal(posted.length, before + 1, `the report of game ${index} was posted`);
    return recapFieldOf(posted.at(-1)!) !== undefined;
  };
  assert.equal(await decorated(0), false, "the oldest pick was dropped");
  assert.equal(await decorated(1), true, "the second oldest is kept");
  assert.equal(await decorated(50), true, "the newest is kept");
});

test("a pick nobody saw is not recapped: the card failed to post and its voice never played", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.records.set(A, history(A, SOLO_HISTORY));
  bot.settings.voice = false;
  const channel = bot.channel("voice-1");
  const send = channel.send;
  let failed = false;
  channel.send = async (message) => {
    if (!failed) {
      failed = true;
      throw new Error("Missing Permissions");
    }
    return send(message);
  };
  bot.enter(spectatorGame(9900, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await bot.tick();
  assert.ok(failed && bot.sent.length === 0, "the card could not be posted");
  assert.equal(bot.errors.filter((line) => line.includes("was not posted")).length, 1);
  await finishGame(bot, "NA1_9900", ["acct-a"]);
  assert.equal(reportMessages(bot).length, 1, "the report itself was posted");
  assert.equal(recapOf(bot), undefined);
});

test("a pick whose card failed to post but whose voice line played is recapped", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  bot.records.set(A, history(A, SOLO_HISTORY));
  const channel = bot.channel("voice-1");
  const send = channel.send;
  let failed = false;
  channel.send = async (message) => {
    if (!failed) {
      failed = true;
      throw new Error("Missing Permissions");
    }
    return send(message);
  };
  bot.enter(spectatorGame(9901, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await bot.tick();
  await until(() => bot.played.length === 1, "the voice line");
  await finishGame(bot, "NA1_9901", ["acct-a"]);
  assert.ok(recapOf(bot));
});

test("a remake or an aborted game has no 锦囊回顾, however good the pick was", async () => {
  const cases: Array<[string, (detail: MatchDetail) => void]> = [
    ["remake", (detail) => { detail.info.earlySurrender = true; }],
    ["aborted", (detail) => { detail.info.aborted = true; }],
    ["too short", (detail) => { detail.info.gameDuration = 120; }],
  ];
  for (const [index, [label, shape]] of cases.entries()) {
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
    bot.records.set(A, history(A, SOLO_HISTORY));
    await loadGame(bot, 9910 + index, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
    await finishGame(bot, `NA1_${9910 + index}`, ["acct-a"], shape);
    assert.equal(reportMessages(bot).length, 1, `${label}: the report was posted`);
    assert.equal(recapOf(bot), undefined, label);
  }
});

// LP: a ranked game's start is the before-value of its 段位变化 row.

const solo = (tier: string, division: string, leaguePoints: number, wins = 10, losses = 10): RankedEntry =>
  ({ queueType: "RANKED_SOLO_5x5", tier, rank: division, leaguePoints, wins, losses });

/** A real tracker on a fake league-v4, on the harness clock. Set before the session starts, so its watcher has it. */
function rankOn(bot: Harness) {
  const league = new Map<string, readonly RankedEntry[]>();
  const reads: string[] = [];
  /** Accounts whose league-v4 reads time out, the way a slow Riot answers. */
  const failing = new Set<string>();
  bot.dependencies.rank = new RankTracker({
    readEntries: async (puuid) => {
      reads.push(puuid);
      if (failing.has(puuid)) throw new RiotApiError("Riot API request timed out.", "timeout");
      return league.get(puuid) ?? [];
    },
    mock: () => false,
    log: () => undefined,
    info: () => undefined,
    now: bot.now,
  });
  return { league, reads, failing };
}

const rankFieldOfReport = (bot: Harness): string | undefined =>
  ((reportMessages(bot)[0].embeds![0] as { toJSON(): { fields?: RecapField[] } }).toJSON().fields ?? []).find((field) => field.name === "段位变化")?.value;

test("a ranked game's start reads every bound player's rank, so a dodge before it never shows as this game's LP", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: F, puuids: ["acct-f"], channel: "voice-1" },
  ]);
  const { league, reads } = rankOn(bot);
  league.set("acct-a", [solo("GOLD", "II", 64)]);
  league.set("acct-f", [solo("SILVER", "I", 31)]);
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await until(() => reads.length === 2, "the monitoring baselines");

  // A dodge costs 5 LP and no game; then a ranked game loads with the friend on the other side.
  league.set("acct-a", [solo("GOLD", "II", 59)]);
  bot.advance(5 * 60_000);
  bot.enter(spectatorGame(7001, [
    { puuid: "acct-a", teamId: 100, championId: AHRI },
    { puuid: "acct-f", teamId: 200, championId: LUX },
  ]));
  await bot.tick();
  await until(() => reads.length === 4, "the game start reads");
  assert.deepEqual(reads.slice(2).sort(), ["acct-a", "acct-f"], "both teams' bound players, no stranger or enemy");

  league.set("acct-a", [solo("GOLD", "II", 81, 11, 10)]);
  league.set("acct-f", [solo("SILVER", "I", 12, 10, 11)]);
  bot.advance(25 * 60_000);
  await finishGame(bot, "NA1_7001", ["acct-a"], (detail) => {
    // On the tracker's clock, which is the watcher's fake one.
    detail.info.gameEndTimestamp = bot.now();
    detail.info.participants[5].puuid = "acct-f";
    detail.metadata.participants = detail.info.participants.map((player) => player.puuid);
  });
  assert.equal(rankFieldOfReport(bot), `<@${A}> 单双排 黄金 II · 81 LP · 本局 +22`, "the dodge is not in this game's LP");
});

test("a ranked game first seen in progress is read too; a game without LP is not", async () => {
  const bot = harness([
    { id: A, puuids: ["acct-a"], channel: "voice-1" },
    { id: B, puuids: ["acct-b"], channel: "voice-1" },
    { id: C, puuids: ["acct-c"], channel: "voice-1" },
  ]);
  const { reads } = rankOn(bot);
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await until(() => reads.length === 3, "the monitoring baselines");
  bot.advance(5 * 60_000);
  // Already five minutes in: skipped for the 锦囊, but LP has not moved, so it is still read.
  bot.enter(spectatorGame(7002, [{ puuid: "acct-a", teamId: 100, championId: AHRI }], { start: bot.now() - 300_000, length: 300 }));
  // A flex game reads; a normal draft game has no LP.
  bot.enter(spectatorGame(7003, [{ puuid: "acct-b", teamId: 100, championId: LUX }], { queue: 440 }));
  bot.enter(spectatorGame(7004, [{ puuid: "acct-c", teamId: 100, championId: LEE_SIN }], { queue: 400 }));
  await bot.tick();
  await until(() => reads.length === 5, "the game start reads");
  await delay(30);
  assert.deepEqual(reads.slice(3).sort(), ["acct-a", "acct-b"]);
  assert.ok(bot.infos.some((line) => line.startsWith("Game NA1_7002 is not announced at its start: it was already 300 s in")));
});

test("a game-start LP read that fails is retried on the next in-game recheck, so a dodge is not counted in the game", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  const { league, reads, failing } = rankOn(bot);
  league.set("acct-a", [solo("GOLD", "II", 64)]);
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await until(() => reads.length === 1, "the monitoring baseline");

  // A dodge costs 5 LP and no game. The game then loads, but its first read times out.
  league.set("acct-a", [solo("GOLD", "II", 59)]);
  failing.add("acct-a");
  bot.advance(5 * 60_000);
  bot.enter(spectatorGame(7101, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await bot.tick();
  await until(() => reads.length === 2, "the first game start read");
  await delay(30);

  // Riot recovers. The account is asked about its game again after the in-game recheck interval, and that tick reads the rank.
  failing.delete("acct-a");
  for (let tick = 0; tick < 4; tick++) await bot.tick();
  assert.equal(reads.length, 2, "no retry before the recheck");
  await bot.tick();
  await bot.tick();
  await until(() => reads.length === 3, "the retried game start read");

  league.set("acct-a", [solo("GOLD", "II", 81, 11, 10)]);
  bot.advance(25 * 60_000);
  await finishGame(bot, "NA1_7101", ["acct-a"], (detail) => { detail.info.gameEndTimestamp = bot.now(); });
  assert.equal(rankFieldOfReport(bot), `<@${A}> 单双排 黄金 II · 81 LP · 本局 +22`, "the dodge is not in this game's LP");

  // Once the start read exists, later rechecks read nothing more.
  assert.equal(reads.length, 4, "one baseline, two start reads and one after-read");
});

/** The session's watcher with its private start-read bookkeeping, for the cleanup tests. */
const startWatcher = (bot: Harness) => (bot.monitor as unknown as {
  sessions: Map<string, { watcher: { rankStarts: Map<string, unknown>; stop(): void } }>;
}).sessions.get(GUILD)!.watcher;

test("a game whose start read never succeeds is asked at most four times and its LP change is unattributable", async () => {
  const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }]);
  const { league, reads, failing } = rankOn(bot);
  league.set("acct-a", [solo("GOLD", "II", 64)]);
  bot.sync();
  await bot.monitor.poll(bot.client, GUILD);
  await until(() => reads.length === 1, "the monitoring baseline");

  // A dodge costs 5 LP, and then every read of the game times out.
  league.set("acct-a", [solo("GOLD", "II", 59)]);
  failing.add("acct-a");
  bot.advance(5 * 60_000);
  bot.enter(spectatorGame(7102, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]));
  await bot.tick();
  await until(() => reads.length === 2, "the first start read");
  for (let tick = 0; tick < 18; tick++) await bot.tick();
  await until(() => reads.length === 5, "the three retries");
  for (let tick = 0; tick < 12; tick++) await bot.tick();
  await delay(30);
  assert.equal(reads.length, 5, "one baseline, the first start read and three retries, and no more");

  // Riot recovers for the after-read, which holds the game's +22 on top of the dodge.
  failing.delete("acct-a");
  league.set("acct-a", [solo("GOLD", "II", 81, 11, 10)]);
  bot.advance(25 * 60_000);
  await finishGame(bot, "NA1_7102", ["acct-a"], (detail) => { detail.info.gameEndTimestamp = bot.now(); });
  const row = rankFieldOfReport(bot);
  assert.match(row!, /黄金 II · 81 LP · 赛前段位没读到或中间隔了几局，本局变化算不出来/);
  assert.doesNotMatch(row!, /本局 [+-]\d/, "no LP change from the older read is reported");
});

test("a game's start-read bookkeeping goes when its accounts leave the game, leave voice, or the watcher stops", async () => {
  const startGame = async (gameId: number) => {
    // A second member stays in voice, so the session itself outlives the first member leaving.
    const bot = harness([{ id: A, puuids: ["acct-a"], channel: "voice-1" }, { id: B, puuids: ["acct-b"], channel: "voice-1" }]);
    const { league, reads, failing } = rankOn(bot);
    league.set("acct-a", [solo("GOLD", "II", 64)]);
    bot.sync();
    await bot.monitor.poll(bot.client, GUILD);
    await until(() => reads.length === 2, "the monitoring baselines");
    failing.add("acct-a");
    bot.advance(5 * 60_000);
    const game = spectatorGame(gameId, [{ puuid: "acct-a", teamId: 100, championId: AHRI }]);
    bot.enter(game);
    await bot.tick();
    assert.equal(startWatcher(bot).rankStarts.size, 1, "the failed start read is still being waited for");
    return { bot, game };
  };

  // The account leaves its game: the next in-game recheck finds it out of any game.
  const over = await startGame(7103);
  over.bot.leaveGame(over.game);
  for (let tick = 0; tick < 6; tick++) await over.bot.tick();
  assert.equal(startWatcher(over.bot).rankStarts.size, 0);

  // The member leaves voice and the watcher forgets the account.
  const left = await startGame(7104);
  left.bot.move(A, null);
  left.bot.sync();
  assert.equal(startWatcher(left.bot).rankStarts.size, 0);

  const stopped = await startGame(7105);
  startWatcher(stopped.bot).stop();
  assert.equal(startWatcher(stopped.bot).rankStarts.size, 0);
});
