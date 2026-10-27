import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Client, MessageCreateOptions, VoiceChannel } from "discord.js";
import type { ActiveGame, ActiveGameParticipant, MatchDetail, TrackedMember } from "../src/types";
import { GameMonitor, type MonitorDependencies } from "../src/services/gameMonitor";
import { GAME_START_INTERVAL_MS, GAME_START_WINDOW_MS } from "../src/services/gameStartWatcher";
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
function harness(specs: MemberSpec[], options: { mock?: boolean; realSpectator?: boolean } = {}) {
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
  const settings = { voice: true };
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
    members: () => members,
    resolveChannel: (_client, _guildId, userId) => {
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
    monitor, client, channel, move, blocked, games, requests, records, latest, matches, generated, played, errors, infos, settings, sent, order, enter, leaveGame,
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
    /** One more check, as the 20 second timer would run it. */
    tick: async () => (await monitor.pollGameStart(GUILD)).tick,
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
  assert.equal(bot.errors.filter((line) => line.includes("Game start checks are off")).length, 1);
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
    mock.timers.tick(GAME_START_INTERVAL_MS);
    await flush();
  }
  assert.deepEqual(bot.requests, ["acct-0"], "one request finds the game, then nobody is asked for five ticks");
  mock.timers.tick(GAME_START_INTERVAL_MS);
  await flush();
  assert.deepEqual(bot.requests, ["acct-0", "acct-0"], "the sixth tick rechecks once");
  assert.equal(bot.sent.length, 0, "a game already running is not announced");
});
