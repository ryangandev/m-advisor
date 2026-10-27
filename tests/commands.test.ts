import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageFlags, PermissionFlagsBits, VoiceChannel } from "discord.js";
import type { BotCommand } from "../src/types";
import { listTrackedMembers, setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase, getDatabase } from "../src/store/database";
import { getAnnouncerState, getPregameVoiceEnabled, setLastMatchId } from "../src/store/announcerStore";
import { getAccountByRiotId } from "../src/utils/riotApi";
import { getLatestSRMatchId, getMatchDetail } from "../src/utils/riotMatchApi";
import { resetMockData } from "../src/services/riotData";
import { isSyntheticAccount, mergeBoundAccount } from "../src/utils/bindingAccounts";

const firstMember = (guildId: string) => listTrackedMembers(guildId)[0];
const memberIds = (guildId: string) => listTrackedMembers(guildId).map((member) => member.discordUserId);

const loader = createRequire(__filename);
const calls = {
  starts: [] as Array<{ guildId: string; channelId: string }>,
  /** Every sync's present member IDs, as the real lifecycle computes them. */
  syncs: [] as string[][],
  stops: [] as string[],
  polls: [] as string[],
  pollChannels: [] as Array<string | undefined>,
  played: [] as Array<{ channelId: string; text: string; style: string }>,
};
const baselines = new Map<string, string>();
let voiceFailure: Error | undefined;
let beforePlayback: (() => void) | undefined;
let pollFailure = false;
let onPoll: (() => Promise<void>) | undefined;
const savedModules = new Map<string, NodeJS.Module | undefined>();

function stubModule(relativePath: string, exports: Record<string, unknown>): void {
  const file = loader.resolve(relativePath);
  savedModules.set(file, loader.cache[file]);
  loader.cache[file] = { id: file, filename: file, path: dirname(file), loaded: true,
    exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

interface FakeMember {
  id: string;
  voice: { channelId: string | null; channel: VoiceChannel | null };
}
type FakeClient = { guilds: { cache: Map<string, { members: { cache: Map<string, FakeMember> } }> } };

// Install stubs before loading commands or monitorLifecycle, keeping GPU and voice/network code out of this process.
stubModule("../src/services/voiceAnnouncements.ts", {
  announceTextInVoiceChannel: async (channel: VoiceChannel, text: string, style: string, canPlay: () => boolean) => {
    beforePlayback?.();
    if (!canPlay()) throw new Error("Member left before playback.");
    if (voiceFailure) throw voiceFailure;
    calls.played.push({ channelId: channel.id, text, style });
  },
});
stubModule("../src/services/gameMonitor.ts", {
  POLL_INTERVAL_MS: 45_000,
  getMonitorStatus: () => ({ active: calls.starts.length > 0, startedAt: 1, lastPollAt: 2, announced: new Set(),
    presentMemberIds: calls.syncs.at(-1) ?? [] }),
  // The real lifecycle passes the tracked members in voice; record the first one's channel as the session's start.
  syncMonitoring: (client: FakeClient, guildId: string, memberIds: string[]) => {
    calls.syncs.push(memberIds);
    if (memberIds.length === 0) { calls.stops.push(guildId); return; }
    const member = client.guilds.cache.get(guildId)!.members.cache.get(memberIds[0])!;
    calls.starts.push({ guildId, channelId: member.voice.channelId! });
  },
  stopPolling: (guildId: string) => calls.stops.push(guildId),
  // Each member's first account takes a baseline, then announces whatever changed since.
  pollGuildNow: async (_client: unknown, guildId: string, expectedChannelId?: string) => {
    const latest: Array<{ puuid: string; matchId: string }> = [];
    for (const member of listTrackedMembers(guildId)) {
      const puuid = member.accounts[0].puuid;
      const matchId = (await getLatestSRMatchId(puuid))!;
      calls.polls.push(matchId);
      latest.push({ puuid, matchId });
    }
    calls.pollChannels.push(expectedChannelId);
    await onPoll?.();
    if (pollFailure) return { announced: 0, errors: 1 };
    let announced = 0;
    for (const { puuid, matchId } of latest) {
      const previous = baselines.get(puuid);
      baselines.set(puuid, matchId);
      setLastMatchId(guildId, puuid, matchId);
      if (!previous || previous === matchId) continue;
      const detail = await getMatchDetail(matchId);
      const tracked = detail.info.participants.find(player => player.puuid === puuid)!;
      calls.played.push({ channelId: calls.starts.at(-1)!.channelId,
        text: `模拟数据：${tracked.win ? "胜利" : "失败"}`, style: "sweet" });
      announced++;
    }
    return { announced, errors: 0 };
  },
});

const commands = Object.fromEntries(["testvoice", "simulate", "bind", "unbind", "bindings", "announcer", "recent"].map(name =>
  [name, loader(`../src/commands/${name}.ts`).default as BotCommand])) as Record<string, BotCommand>;
after(() => {
  for (const [file, original] of savedModules) {
    if (original) loader.cache[file] = original;
    else delete loader.cache[file];
  }
});

let directory: string;
let guildId: string;
let counter = 0;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let savedConsoleError: typeof console.error;
let savedConsoleLog: typeof console.log;
const errorLogs: unknown[][] = [];
const infoLogs: string[] = [];
const envKeys = ["DATABASE_PATH", "TEST_GUILD_ID", "TEST_VOICE_CHANNEL_ID", "RIOT_MODE", "RIOT_API_KEY"];

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-commands-"));
  guildId = `command-guild-${++counter}`;
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.TEST_GUILD_ID = guildId;
  process.env.TEST_VOICE_CHANNEL_ID = "test-channel";
  process.env.RIOT_MODE = "mock";
  delete process.env.RIOT_API_KEY;
  resetMockData();
  baselines.clear();
  for (const list of Object.values(calls)) list.length = 0;
  voiceFailure = undefined;
  beforePlayback = undefined;
  pollFailure = false;
  onPoll = undefined;
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Command test attempted a network request."); };
  savedConsoleError = console.error;
  errorLogs.length = 0;
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  savedConsoleLog = console.log;
  infoLogs.length = 0;
  console.log = (line: string) => { infoLogs.push(line); };
});
afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = savedFetch;
  console.error = savedConsoleError;
  console.log = savedConsoleLog;
});


function interactionFixture(options: { admin?: boolean; voice?: boolean; permissions?: boolean; channelId?: string; riotId?: string; outcome?: string; style?: string | null; pregameVoice?: boolean; targetId?: string; count?: number } = {}) {
  const channelId = options.channelId ?? "test-channel";
  const members = new Map<string, FakeMember>();
  const guild = {
    id: guildId,
    members: { cache: members, fetch: async (id: string) => {
      const member = members.get(id);
      if (!member) throw new Error("Member not found.");
      return member;
    } },
  };
  const channel = Object.create(VoiceChannel.prototype) as VoiceChannel;
  Object.defineProperties(channel, {
    id: { value: channelId },
    guild: { value: guild },
    permissionsFor: { value: () => ({ has: (permissions: unknown) => {
      assert.deepEqual(permissions, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
      return options.permissions !== false;
    } }) },
  });
  const member = { id: "admin-user", voice: { channelId: options.voice === false ? null : channelId,
    channel: options.voice === false ? null : channel } };
  const tracked = { id: "tracked-user", voice: { channelId, channel } };
  members.set(member.id, member);
  members.set(tracked.id, tracked);
  const replies: unknown[] = [];
  const deferred: unknown[] = [];
  const client = { user: { id: "bot-user" }, guilds: { cache: new Map([[guildId, guild]]) } };
  const interaction = {
    guildId, guild, client, user: { id: member.id },
    inGuild: () => true,
    memberPermissions: { has: () => options.admin !== false },
    options: {
      // A required user option always has a value; /recent's optional one is set only when the test names a target.
      getUser: (_name: string, required?: boolean) => required || options.targetId
        ? { id: options.targetId ?? tracked.id, username: options.targetId ?? "tracked-name" } : null,
      getString: (name: string) => ({ riotid: options.riotId ?? "MockWin#NA1", outcome: options.outcome ?? "win", style: options.style === undefined ? "old" : options.style })[name],
      getBoolean: (name: string) => (name === "pregame_voice" ? options.pregameVoice ?? null : null),
      getInteger: () => options.count ?? null,
    },
    deferReply: async (payload: unknown) => { deferred.push(payload); },
    reply: async (payload: unknown) => { replies.push(payload); },
    editReply: async (payload: unknown) => { replies.push(payload); },
  };
  return { interaction: interaction as unknown as Parameters<BotCommand["execute"]>[0],
    channel, guild, client, member, tracked, members, replies, deferred };
}

function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  const payload = reply as { content?: string; embeds?: Array<{ toJSON: () => unknown }> };
  return JSON.stringify({ content: payload.content, embeds: payload.embeds?.map(embed => embed.toJSON()) });
}

async function seedBinding(): Promise<string> {
  const account = await getAccountByRiotId("MockWin", "NA1");
  setMemberAccounts(guildId, "tracked-user", [account]);
  return account.puuid;
}

for (const name of ["testvoice", "simulate"]) {
  for (const denial of ["admin", "guild", "voice", "channel", "permissions"]) {
    test(`/${name} denies ${denial} before speech or match simulation`, async () => {
      const puuid = await seedBinding();
      const previous = await getLatestSRMatchId(puuid);
      const f = interactionFixture({ admin: denial !== "admin", voice: denial !== "voice",
        channelId: denial === "channel" ? "other-channel" : undefined, permissions: denial !== "permissions" });
      if (denial === "guild") process.env.TEST_GUILD_ID = "other-guild";
      await commands[name].execute(f.interaction);
      assert.deepEqual(f.deferred, [{ flags: MessageFlags.Ephemeral }]);
      assert.ok(f.replies.length === 1);
      assert.match(replyText(f.replies[0]), /管理员|TEST_GUILD_ID|语音频道|View Channel/);
      assert.equal(calls.played.length, 0);
      assert.equal(calls.starts.length, 0);
      assert.equal(calls.polls.length, 0);
      assert.equal(await getLatestSRMatchId(puuid), previous);
    });
  }
  test(`/${name} rejects direct messages and a missing TEST_GUILD_ID`, async () => {
    const f = interactionFixture();
    (f.interaction as unknown as { guildId: null; guild: null }).guildId = null;
    (f.interaction as unknown as { guildId: null; guild: null }).guild = null;
    await commands[name].execute(f.interaction);
    assert.match(replyText(f.replies.at(-1)), /TEST_GUILD_ID/);
    const server = interactionFixture();
    delete process.env.TEST_GUILD_ID;
    await commands[name].execute(server.interaction);
    assert.match(replyText(server.replies.at(-1)), /TEST_GUILD_ID/);
    assert.equal(calls.played.length, 0);
    assert.equal(calls.starts.length, 0);
  });
}

test("/testvoice plays through the shared pipeline with persisted voice style and a live membership guard", async () => {
  const f = interactionFixture();
  await commands.announcer.execute(f.interaction);
  await commands.testvoice.execute(f.interaction);
  assert.equal(calls.played.length, 1);
  assert.equal(calls.played[0].channelId, f.channel.id);
  assert.equal(calls.played[0].style, "old");
  assert.match(calls.played[0].text, /策马军师语音测试/);
  assert.match(replyText(f.replies.at(-1)), /实际听到了播报/);
});

test("/testvoice handles a departing member and hides private speech errors", async () => {
  const f = interactionFixture();
  beforePlayback = () => { f.member.voice.channelId = null; };
  await commands.testvoice.execute(f.interaction);
  assert.equal(calls.played.length, 0);
  assert.match(replyText(f.replies.at(-1)), /测试失败/);
  beforePlayback = undefined;
  f.member.voice.channelId = f.channel.id;
  voiceFailure = new Error("private-model-path and speech transcript");
  await commands.testvoice.execute(f.interaction);
  assert.equal(calls.played.length, 0);
  assert.doesNotMatch(replyText(f.replies.at(-1)), /private-model|transcript/);
  assert.doesNotMatch(JSON.stringify(errorLogs), /private-model|transcript/);
});

for (const outcome of ["win", "loss"]) {
  test(`/simulate ${outcome} establishes a baseline before inserting a match through the normal provider`, async () => {
    const puuid = await seedBinding();
    const baseline = await getLatestSRMatchId(puuid);
    const f = interactionFixture({ outcome });
    await commands.simulate.execute(f.interaction);
    const latest = await getLatestSRMatchId(puuid);
    assert.notEqual(latest, baseline);
    assert.deepEqual(calls.starts, [{ guildId, channelId: f.channel.id }]);
    assert.deepEqual(calls.polls, [baseline, latest]);
    assert.deepEqual(calls.pollChannels, [f.channel.id, f.channel.id]);
    assert.equal(calls.played.length, 1);
    assert.match(calls.played[0].text, outcome === "win" ? /模拟数据：胜利/ : /模拟数据：失败/);
    assert.match(replyText(f.replies.at(-1)), /模拟数据.*不是实际战绩/);
    assert.deepEqual((f.replies.at(-1) as { allowedMentions?: unknown }).allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  });
}

test("/simulate rejects real mode, missing binding, and absent tracked member before mutation", async () => {
  const puuid = await seedBinding();
  const baseline = await getLatestSRMatchId(puuid);
  const f = interactionFixture();
  process.env.RIOT_MODE = "real";
  await commands.simulate.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /RIOT_MODE=mock/);
  process.env.RIOT_MODE = "mock";
  assert.equal(await getLatestSRMatchId(puuid), baseline);
  f.tracked.voice.channelId = "different-channel";
  await commands.simulate.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /被追踪成员/);
  assert.equal(await getLatestSRMatchId(puuid), baseline);
  assert.equal(calls.polls.length, 0);
  loader("../src/store/bindingStore.ts").removeTrackedMember(guildId, "tracked-user");
  await commands.simulate.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /\/bind/);
  assert.equal(calls.played.length, 0);
});

test("/simulate refuses when members are tracked but none is in the test channel", async () => {
  setMemberAccounts(guildId, "away-user", [await getAccountByRiotId("MockLoss", "NA1")]);
  setMemberAccounts(guildId, "tracked-user", [await getAccountByRiotId("MockWin", "NA1")]);
  setMemberAccounts(guildId, "gone-user", [await getAccountByRiotId("MockThird", "NA1")]);
  const puuids = listTrackedMembers(guildId).map((member) => member.accounts[0].puuid);
  const before = await Promise.all(puuids.map((puuid) => getLatestSRMatchId(puuid)));
  const f = interactionFixture();
  f.members.set("away-user", { id: "away-user", voice: { channelId: "elsewhere", channel: null } });
  f.tracked.voice.channelId = "different-channel";
  // gone-user is not in the guild's member list at all, so fetching them fails.
  await commands.simulate.execute(f.interaction);
  const reply = f.replies.at(-1) as { content?: string; allowedMentions?: unknown };
  assert.equal(reply.content, "请先让被追踪成员进入同一个测试语音频道。");
  assert.deepEqual(reply.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  assert.deepEqual(calls.syncs, []);
  assert.deepEqual(calls.polls, []);
  assert.equal(calls.played.length, 0);
  assert.deepEqual(await Promise.all(puuids.map((puuid) => getLatestSRMatchId(puuid))), before);
});

test("/simulate does not claim success when the monitor fails", async () => {
  const puuid = await seedBinding();
  const baseline = await getLatestSRMatchId(puuid);
  const f = interactionFixture();
  pollFailure = true;
  await commands.simulate.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /暂未播报成功/);
  assert.equal(calls.played.length, 0);
  assert.deepEqual(calls.polls, [baseline], "failed baseline must stop before a new match is inserted");
  assert.equal(await getLatestSRMatchId(puuid), baseline);
});

test("concurrent /simulate requests cannot mix outcomes or mutate a second match", async () => {
  const puuid = await seedBinding();
  const baseline = await getLatestSRMatchId(puuid);
  const first = interactionFixture({ outcome: "win" });
  const second = interactionFixture({ outcome: "loss" });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const firstPoll = new Promise<void>(resolve => { entered = resolve; });
  let firstCall = true;
  onPoll = async () => {
    if (!firstCall) return;
    firstCall = false;
    entered();
    await blocked;
  };
  const running = commands.simulate.execute(first.interaction);
  try {
    await firstPoll;
    await commands.simulate.execute(second.interaction);
    assert.match(replyText(second.replies.at(-1)), /模拟测试正在进行/);
    assert.doesNotMatch(replyText(second.replies.at(-1)), /失败比赛播报完成/);
    assert.equal(await getLatestSRMatchId(puuid), baseline);
    assert.equal(calls.starts.length, 1);
  } finally { release(); await running; }
  assert.equal(calls.played.length, 1);
  assert.match(calls.played[0].text, /胜利/);
  assert.match(replyText(first.replies.at(-1)), /胜利比赛播报完成/);
});

test("/bind starts monitoring when the tracked member is already in voice and labels mock data", async () => {
  const f = interactionFixture();
  await commands.bind.execute(f.interaction);
  assert.equal(firstMember(guildId)?.discordUserId, f.tracked.id);
  assert.match(firstMember(guildId)!.accounts[0].puuid, /^MOCK-/);
  assert.deepEqual(calls.starts, [{ guildId, channelId: f.channel.id }]);
  assert.match(replyText(f.replies.at(-1)), /模拟数据/);
  await commands.bindings.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /模拟数据/);
  assert.match(replyText(f.replies.at(-1)), /MockWin#NA1（模拟账号）/);
  process.env.RIOT_MODE = "real";
  await commands.bindings.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /MockWin#NA1（模拟账号，真实模式下不监听；用 \/bind 绑定真实 Riot ID 后会自动移除）/);
});

test("/bind rejects non-admins and malformed IDs without starting monitoring", async () => {
  const unauthorized = interactionFixture({ admin: false });
  await commands.bind.execute(unauthorized.interaction);
  assert.match(replyText(unauthorized.replies[0]), /Administrator/);
  assert.equal(firstMember(guildId), undefined);
  const malformed = interactionFixture({ riotId: "invalid-id" });
  await commands.bind.execute(malformed.interaction);
  assert.match(replyText(malformed.replies[0]), /Invalid Riot ID/);
  assert.equal(firstMember(guildId), undefined);
  assert.equal(calls.starts.length, 0);
});

test("/bind adds a second member after the first and reconciles monitoring for both", async () => {
  await seedBinding();
  const f = interactionFixture({ targetId: "second-user", riotId: "MockLoss#NA1" });
  f.members.set("second-user", { id: "second-user", voice: { channelId: f.channel.id, channel: f.channel } });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(memberIds(guildId), ["tracked-user", "second-user"]);
  assert.deepEqual(listTrackedMembers(guildId)[1].accounts.map((account) => account.gameName), ["MockLoss"]);
  assert.deepEqual(listTrackedMembers(guildId)[0].accounts.map((account) => account.gameName), ["MockWin"], "the first member is untouched");
  assert.deepEqual(calls.syncs, [["tracked-user", "second-user"]]);
  const reply = f.replies.at(-1) as { allowedMentions?: unknown };
  assert.match(replyText(reply), /Bound MockLoss#NA1 to <@second-user>/);
  assert.deepEqual(reply.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
});

test("/bind rejects an account another member owns, names the owner and changes nothing", async () => {
  await seedBinding();
  const f = interactionFixture({ targetId: "second-user", riotId: "MockWin#NA1" });
  await commands.bind.execute(f.interaction);
  const reply = f.replies.at(-1) as { allowedMentions?: unknown };
  assert.match(replyText(reply), /That Riot account is already bound to <@tracked-user>; \/unbind them first\./);
  assert.deepEqual(reply.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  assert.deepEqual(memberIds(guildId), ["tracked-user"]);
  assert.deepEqual(calls.syncs, [], "a rejected bind does not touch monitoring");
});

test("/bind in real mode removes only the target member's mock accounts", async () => {
  await seedBinding();
  const otherMock = await getAccountByRiotId("MockLoss", "NA1");
  setMemberAccounts(guildId, "second-user", [otherMock]);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json({ puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" });
  const f = interactionFixture({ riotId: "RealName#NA1" });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(listTrackedMembers(guildId), [
    { discordUserId: "tracked-user", accounts: [{ puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" }] },
    { discordUserId: "second-user", accounts: [otherMock] },
  ]);
  assert.match(replyText(f.replies.at(-1)), /Removed the simulated account MockWin#NA1/);
  assert.doesNotMatch(replyText(f.replies.at(-1)), /MockLoss/);
});

test("/bind replaces a persisted synthetic identity with a real fetched PUUID for the same Riot ID", async () => {
  const synthetic = await seedBinding();
  assert.match(synthetic, /^MOCK-/);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    assert.match(input.toString(), /accounts\/by-riot-id\/MockWin\/NA1$/);
    assert.deepEqual(init?.headers, { "X-Riot-Token": "test-key" });
    return Response.json({ puuid: "real-puuid", gameName: "MockWin", tagLine: "NA1" });
  };
  const f = interactionFixture();
  await commands.bind.execute(f.interaction);
  assert.deepEqual(firstMember(guildId)?.accounts, [{ puuid: "real-puuid", gameName: "MockWin", tagLine: "NA1" }]);
  closeDatabase();
  assert.equal(firstMember(guildId)?.accounts[0].puuid, "real-puuid");
  assert.doesNotMatch(replyText(f.replies.at(-1)), /Removed/, "a refreshed identity is not reported as removed");
  await commands.bindings.execute(f.interaction);
  assert.doesNotMatch(replyText(f.replies.at(-1)), /模拟账号|模拟数据/);
});

test("/bind in real mode removes saved mock accounts, says so and logs the change", async () => {
  await seedBinding();
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json({ puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" });
  const f = interactionFixture({ riotId: "RealName#NA1" });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(firstMember(guildId)?.accounts, [{ puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" }]);
  assert.match(replyText(f.replies.at(-1)), /Bound RealName#NA1 to <@tracked-user>\\nRemoved the simulated account MockWin#NA1, which real mode does not monitor\./);
  assert.match(infoLogs.join("\n"), /\] Bound RealName#NA1 to Discord member tracked-name; removed the mock account MockWin#NA1, which real mode does not monitor\.$/m);
  assert.deepEqual(calls.starts, [{ guildId, channelId: "test-channel" }], "monitoring restarts with the cleaned binding");
});

test("/bind in real mode cleans mock accounts even when the real account is already bound", async () => {
  const mock = await getAccountByRiotId("MockWin", "NA1");
  const real = { puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" };
  setMemberAccounts(guildId, "tracked-user", [real, mock]);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json(real);
  const f = interactionFixture({ riotId: "RealName#NA1" });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(firstMember(guildId)?.accounts, [real]);
  assert.match(replyText(f.replies.at(-1)), /Removed the simulated account MockWin#NA1/);
  await commands.bind.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /^\{"content":"This account is already bound\."/);
});

test("/bind at the 10-account server limit explains the limit instead of a Riot lookup failure", async () => {
  const full = Array.from({ length: 10 }, (_, index) => ({ puuid: `full-${index}`, gameName: `Full${index}`, tagLine: "NA1" }));
  setMemberAccounts(guildId, "tracked-user", full);
  const f = interactionFixture({ riotId: "MockWin#NA1" });
  await commands.bind.execute(f.interaction);
  const reply = replyText(f.replies.at(-1));
  assert.match(reply, /at most 10 Riot accounts/);
  assert.doesNotMatch(reply, /Riot lookup/);
  assert.deepEqual(firstMember(guildId)?.accounts, full);
  assert.deepEqual(calls.starts, [], "a rejected bind does not touch monitoring");
});

test("/bind in mock mode keeps the other mock accounts", async () => {
  await seedBinding();
  const f = interactionFixture({ riotId: "MockLoss#NA1" });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(firstMember(guildId)?.accounts.map((account) => account.gameName), ["MockWin", "MockLoss"]);
  assert.doesNotMatch(replyText(f.replies.at(-1)), /Removed/);
  assert.match(infoLogs.join("\n"), /\] Bound MockLoss#NA1 to Discord member tracked-name\.$/m);
});

test("account merge refreshes identity in place and deduplicates old mock entries without mutating input", () => {
  const synthetic = { puuid: "MOCK-primary", gameName: "Player", tagLine: "NA1" };
  const alternative = { puuid: "real-alt", gameName: "Alternative", tagLine: "NA1" };
  const stale = { puuid: "MOCK-stale", gameName: "player", tagLine: "na1" };
  const replacement = { puuid: "real-primary", gameName: "PLAYER", tagLine: "NA1" };
  const original = [alternative, synthetic, stale];
  assert.deepEqual(mergeBoundAccount(original, replacement), [alternative, replacement]);
  assert.deepEqual(original, [alternative, synthetic, stale]);
  assert.equal(isSyntheticAccount(synthetic), true);
  assert.equal(isSyntheticAccount(replacement), false);
});

test("/bind refreshes a renamed Riot ID with the same real PUUID", async () => {
  setMemberAccounts(guildId, "tracked-user", [{ puuid: "real-renamed", gameName: "OldName", tagLine: "NA1" }]);
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json({ puuid: "real-renamed", gameName: "NewName", tagLine: "NA1" });
  const f = interactionFixture({ riotId: "NewName#NA1" });
  await commands.bind.execute(f.interaction);
  assert.deepEqual(firstMember(guildId)?.accounts, [{ puuid: "real-renamed", gameName: "NewName", tagLine: "NA1" }]);
  assert.match(replyText(f.replies.at(-1)), /Binding Updated.*NewName#NA1/);
});

test("/unbind rejects non-admins and the wrong member without deleting an active binding", async () => {
  await seedBinding();
  const unauthorized = interactionFixture({ admin: false });
  await commands.unbind.execute(unauthorized.interaction);
  assert.match(replyText(unauthorized.replies.at(-1)), /Administrator/);
  const wrong = interactionFixture({ targetId: "other-member" });
  await commands.unbind.execute(wrong.interaction);
  assert.match(replyText(wrong.replies.at(-1)), /No binding found/);
  assert.equal(firstMember(guildId)?.discordUserId, "tracked-user");
  assert.equal(calls.stops.length, 0);
});

test("/unbind of one member keeps the others and reconciles monitoring for them", async () => {
  await seedBinding();
  setMemberAccounts(guildId, "second-user", [await getAccountByRiotId("MockLoss", "NA1")]);
  const f = interactionFixture({ targetId: "tracked-user" });
  f.members.set("second-user", { id: "second-user", voice: { channelId: f.channel.id, channel: f.channel } });
  await commands.announcer.execute(f.interaction);
  await commands.unbind.execute(f.interaction);
  assert.deepEqual(memberIds(guildId), ["second-user"]);
  assert.deepEqual(calls.syncs, [["second-user"]], "the session is reconciled to the remaining member, not stopped");
  assert.deepEqual(calls.stops, []);
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "old" });
  const reply = f.replies.at(-1) as { allowedMentions?: unknown };
  assert.match(replyText(reply), /Removed all bindings for <@tracked-user>/);
  assert.deepEqual(reply.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
});

test("/unbind of the last member stops monitoring and deletes accounts while preserving the voice preference", async () => {
  await seedBinding();
  const f = interactionFixture();
  await commands.announcer.execute(f.interaction);
  await commands.unbind.execute(f.interaction);
  assert.equal(firstMember(guildId), undefined);
  assert.deepEqual(calls.stops, [guildId]);
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "old" });
  assert.match(replyText(f.replies.at(-1)), /Binding Removed/);
  assert.match(infoLogs.join("\n"), /\] Removed the binding of MockWin#NA1 from Discord member tracked-name\.$/m);
});

test("/announcer writes selected style to SQLite and rejects DMs", async () => {
  const f = interactionFixture({ style: "old" });
  await commands.announcer.execute(f.interaction);
  closeDatabase();
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "old" });
  (f.interaction as unknown as { guildId: null }).guildId = null;
  await commands.announcer.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /only be used in a server/);
});

test("/bindings shows one field per member in bind order with the mention in the value", async () => {
  await seedBinding();
  setMemberAccounts(guildId, "second-user", [await getAccountByRiotId("MockLoss", "NA1"), { puuid: "real-alt", gameName: "Alt", tagLine: "NA1" }]);
  const f = interactionFixture();
  await commands.bindings.execute(f.interaction);
  const reply = f.replies.at(-1) as { embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }>; allowedMentions?: unknown };
  assert.deepEqual(reply.embeds[0].toJSON().fields, [
    { name: "Tracked Member 1", value: "<@tracked-user>\n• MockWin#NA1（模拟账号）", inline: false },
    { name: "Tracked Member 2", value: "<@second-user>\n• MockLoss#NA1（模拟账号）\n• Alt#NA1", inline: false },
  ]);
  assert.deepEqual(reply.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
});

test("/announcer pregame_voice alone changes only the switch and states both settings", async () => {
  const style = interactionFixture({ style: "sweet" });
  await commands.announcer.execute(style.interaction);
  const off = interactionFixture({ style: null, pregameVoice: false });
  await commands.announcer.execute(off.interaction);
  const reply = off.replies.at(-1) as { flags: unknown; allowedMentions: unknown };
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.match(replyText(reply), /Sweet Girl/);
  assert.match(replyText(reply), /Pre-game voice line: off/);
  closeDatabase();
  assert.equal(getPregameVoiceEnabled(guildId), false);
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "sweet" });
  const on = interactionFixture({ style: null, pregameVoice: true });
  await commands.announcer.execute(on.interaction);
  assert.match(replyText(on.replies.at(-1)), /Pre-game voice line: on/);
  assert.equal(getPregameVoiceEnabled(guildId), true);
});

test("/announcer style alone leaves the pregame switch unchanged", async () => {
  await commands.announcer.execute(interactionFixture({ style: null, pregameVoice: false }).interaction);
  const f = interactionFixture({ style: "sweet" });
  await commands.announcer.execute(f.interaction);
  assert.equal(getPregameVoiceEnabled(guildId), false);
  assert.equal(getAnnouncerState(guildId).voiceStyle, "sweet");
  assert.match(replyText(f.replies.at(-1)), /Sweet Girl/);
  assert.match(replyText(f.replies.at(-1)), /Pre-game voice line: off/);
});

test("/announcer with neither option is a private error and changes nothing", async () => {
  const f = interactionFixture({ style: null });
  await commands.announcer.execute(f.interaction);
  const reply = f.replies.at(-1) as { flags: unknown; allowedMentions: unknown };
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(replyText(reply), /at least one/);
  for (const table of ["guild_preferences", "pregame_settings"]) {
    assert.equal((getDatabase().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  }
});

test("/announcer rejects a non-admin toggle, even with a style, and writes nothing", async () => {
  for (const style of [null, "sweet"]) {
    const f = interactionFixture({ admin: false, style, pregameVoice: false });
    await commands.announcer.execute(f.interaction);
    const reply = f.replies.at(-1) as { flags: unknown; allowedMentions: unknown };
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    assert.match(replyText(reply), /Administrator/);
  }
  for (const table of ["guild_preferences", "pregame_settings"]) {
    assert.equal((getDatabase().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  }
  assert.equal(getAnnouncerState(guildId).voiceStyle, "old");
});

test("/announcer still lets a non-admin change the style", async () => {
  const f = interactionFixture({ admin: false, style: "sweet" });
  await commands.announcer.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /Sweet Girl/);
  assert.equal(getAnnouncerState(guildId).voiceStyle, "sweet");
  assert.equal(getPregameVoiceEnabled(guildId), true);
});

test("/announcer lets an admin toggle the switch together with the style", async () => {
  const f = interactionFixture({ style: "sweet", pregameVoice: false });
  await commands.announcer.execute(f.interaction);
  closeDatabase();
  assert.equal(getPregameVoiceEnabled(guildId), false);
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "sweet" });
});

test("/bindings labels even an empty mock server and restricts non-admins", async () => {
  const f = interactionFixture();
  await commands.bindings.execute(f.interaction);
  assert.match(replyText(f.replies[0]), /No bindings.*模拟数据/);
  const unauthorized = interactionFixture({ admin: false });
  await commands.bindings.execute(unauthorized.interaction);
  assert.match(replyText(unauthorized.replies[0]), /Administrator/);
});

test("/recent asks for a binding first and replies privately", async () => {
  const f = interactionFixture();
  await commands.recent.execute(f.interaction);
  assert.deepEqual(f.deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.match(replyText(f.replies[0]), /还没有绑定玩家/);
});

test("/recent lists the bound account's recent matches with the monitor's baseline", async () => {
  const puuid = await seedBinding();
  const baseline = (await getLatestSRMatchId(puuid))!;
  setLastMatchId(guildId, puuid, baseline);
  calls.starts.push({ guildId, channelId: "test-channel" });
  const f = interactionFixture({ count: 3 });
  await commands.recent.execute(f.interaction);
  const reply = replyText(f.replies[0]);
  assert.match(reply, /模拟数据 · 最近对局/);
  assert.match(reply, /🟢 正在监听 · 每 45 秒检查一次/);
  assert.match(reply, /1\. <@tracked-user> · <#test-channel>/);
  assert.match(reply, /"name":"1\. MockWin#NA1"/);
  assert.match(reply, /📍 监听起点/);
});

test("/recent lists every member by default and one member when asked", async () => {
  await seedBinding();
  setMemberAccounts(guildId, "second-user", [await getAccountByRiotId("MockLoss", "NA1")]);
  calls.starts.push({ guildId, channelId: "test-channel" });
  calls.syncs.push(["tracked-user"]);
  const all = interactionFixture();
  await commands.recent.execute(all.interaction);
  const everyone = replyText(all.replies[0]);
  assert.match(everyone, /1\. <@tracked-user> · <#test-channel> · 监听中/);
  assert.match(everyone, /2\. <@second-user> · 不在语音 · 未监听/);
  assert.match(everyone, /"name":"1\. MockWin#NA1"/);
  assert.match(everyone, /"name":"2\. MockLoss#NA1"/);
  assert.deepEqual((all.replies[0] as { allowedMentions?: unknown }).allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });

  const one = interactionFixture({ targetId: "second-user" });
  await commands.recent.execute(one.interaction);
  const filtered = replyText(one.replies[0]);
  assert.match(filtered, /2\. <@second-user> · 不在语音 · 未监听/);
  assert.doesNotMatch(filtered, /tracked-user|MockWin/);
  assert.match(filtered, /"name":"2\. MockLoss#NA1"/);

  const stranger = interactionFixture({ targetId: "stranger" });
  await commands.recent.execute(stranger.interaction);
  assert.match(replyText(stranger.replies[0]), /<@stranger> 不是这个服务器的被追踪成员/);
});

test("/recent flags a mock account in real mode without calling Riot", async () => {
  await seedBinding();
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "RGAPI-test-key";
  const f = interactionFixture();
  await commands.recent.execute(f.interaction);
  const reply = replyText(f.replies[0]);
  assert.match(reply, /最近对局 · 策马军师/);
  assert.match(reply, /这是模拟账号，真实模式下监听会跳过它。用 \/bind 绑定真实 Riot ID 后会自动移除它。/);
});

test("/simulate uses the earliest-bound tracked member who is in the test channel and their first account", async () => {
  // The first member is in another channel; the second and third are in the test channel.
  setMemberAccounts(guildId, "away-user", [await getAccountByRiotId("MockLoss", "NA1")]);
  setMemberAccounts(guildId, "tracked-user", [await getAccountByRiotId("MockWin", "NA1"), await getAccountByRiotId("MockAlt", "NA1")]);
  setMemberAccounts(guildId, "third-user", [await getAccountByRiotId("MockThird", "NA1")]);
  const [away, chosen, third] = listTrackedMembers(guildId);
  const before = await Promise.all([away, third].map((member) => getLatestSRMatchId(member.accounts[0].puuid)));
  const alternate = await getLatestSRMatchId(chosen.accounts[1].puuid);
  const f = interactionFixture({ outcome: "loss" });
  f.members.set("away-user", { id: "away-user", voice: { channelId: "elsewhere", channel: null } });
  f.members.set("third-user", { id: "third-user", voice: { channelId: f.channel.id, channel: f.channel } });
  await commands.simulate.execute(f.interaction);
  assert.match(replyText(f.replies.at(-1)), /失败比赛播报完成/);
  assert.equal(calls.played.length, 1);
  assert.match(calls.played[0].text, /失败/);
  assert.match((await getLatestSRMatchId(chosen.accounts[0].puuid))!, /_1$/, "the simulated match went to the chosen member's first account");
  assert.equal(await getLatestSRMatchId(chosen.accounts[1].puuid), alternate);
  assert.deepEqual(await Promise.all([away, third].map((member) => getLatestSRMatchId(member.accounts[0].puuid))), before);
  assert.deepEqual(calls.syncs, [["away-user", "tracked-user", "third-user"]], "monitoring was reconciled before the poll");
});
