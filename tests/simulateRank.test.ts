import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { VoiceChannel } from "discord.js";
import type { MessageCreateOptions } from "discord.js";
import type { BotCommand } from "../src/types";
import { setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import { getAccountByRiotId } from "../src/utils/riotApi";
import { resetMockData } from "../src/services/riotData";

/**
 * /simulate 晋级 and 掉段 through the real command, lifecycle, monitor, rank tracker and voice queue contract. Only the
 * speech and playback are replaced: the voice queue is a stub that records the lines it would speak.
 */
const loader = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const spoken: string[] = [];

function stubModule(relativePath: string, exports: Record<string, unknown>): void {
  const file = loader.resolve(relativePath);
  savedModules.set(file, loader.cache[file]);
  loader.cache[file] = { id: file, filename: file, path: dirname(file), loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

class AnnouncementCancelledError extends Error {}
class AnnouncementQueueFullError extends Error {}
stubModule("../src/services/voiceAnnouncements.ts", {
  AnnouncementCancelledError,
  AnnouncementQueueFullError,
  announceTextInVoiceChannel: async () => undefined,
  announceTextToCurrentChannel: async (_guildId: string, text: string, _style: string, resolveChannel: () => VoiceChannel | null, canPlay?: () => boolean) => {
    if (canPlay && !canPlay()) throw new AnnouncementCancelledError();
    const channel = resolveChannel();
    if (!channel) throw new AnnouncementCancelledError();
    spoken.push(text);
    return channel;
  },
});
const simulate = loader("../src/commands/simulate.ts").default as BotCommand;
const { stopPolling } = loader("../src/services/gameMonitor.ts") as typeof import("../src/services/gameMonitor");
after(() => {
  for (const [file, original] of savedModules) {
    if (original) loader.cache[file] = original;
    else delete loader.cache[file];
  }
});

const GUILD = "simulate-rank-guild";
const CHANNEL = "test-channel";
const envKeys = ["DATABASE_PATH", "TEST_GUILD_ID", "TEST_VOICE_CHANNEL_ID", "RIOT_MODE", "RIOT_API_KEY"];
let directory: string;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let savedConsoleLog: typeof console.log;
let savedConsoleError: typeof console.error;
const sent: MessageCreateOptions[] = [];

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-simulate-rank-"));
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.TEST_GUILD_ID = GUILD;
  process.env.TEST_VOICE_CHANNEL_ID = CHANNEL;
  process.env.RIOT_MODE = "mock";
  delete process.env.RIOT_API_KEY;
  resetMockData();
  spoken.length = 0;
  sent.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("The simulate rank test attempted a network request."); };
  savedConsoleLog = console.log;
  savedConsoleError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
});
afterEach(() => {
  stopPolling(GUILD);
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = savedFetch;
  console.log = savedConsoleLog;
  console.error = savedConsoleError;
});

function fixture() {
  const members = new Map<string, { id: string; voice: { channelId: string; channel: VoiceChannel } }>();
  const guild = { id: GUILD, members: { cache: members, fetch: async (id: string) => members.get(id)! } };
  const channel = Object.create(VoiceChannel.prototype) as VoiceChannel;
  Object.defineProperties(channel, {
    id: { value: CHANNEL },
    guild: { value: guild },
    joinable: { value: true },
    speakable: { value: true },
    members: { value: new Map([["tracked-user", { user: { bot: false } }]]) },
    permissionsFor: { value: () => ({ has: () => true }) },
    send: { value: async (message: MessageCreateOptions) => { sent.push(message); return { edit: async () => ({}) }; } },
  });
  for (const id of ["admin-user", "tracked-user"]) members.set(id, { id, voice: { channelId: CHANNEL, channel } });
  const client = { user: { id: "bot-user" }, guilds: { cache: new Map([[GUILD, guild]]) } };
  const run = async (outcome: string) => {
    const replies: unknown[] = [];
    const interaction = {
      guildId: GUILD, guild, client, user: { id: "admin-user" },
      inGuild: () => true,
      memberPermissions: { has: () => true },
      options: { getString: () => outcome },
      deferReply: async () => undefined,
      reply: async (payload: unknown) => { replies.push(payload); },
      editReply: async (payload: unknown) => { replies.push(payload); },
    };
    await simulate.execute(interaction as unknown as Parameters<BotCommand["execute"]>[0]);
    return replies;
  };
  return { run };
}

const embedJson = (message: MessageCreateOptions) => (message.embeds![0] as { toJSON: () => { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }).toJSON();
const rankField = (message: MessageCreateOptions) => embedJson(message).fields?.find((field) => field.name === "段位变化")?.value;

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("/simulate 晋级 twice and then 掉段 each produce the 段位变化 row and a 段位播报 with its voice line, through the real monitor", async () => {
  const account = await getAccountByRiotId("MockWin", "NA1");
  setMemberAccounts(GUILD, "tracked-user", [account]);
  const { run } = fixture();

  // The same promotion twice in a row: the second one is still a promotion, not a plain change.
  for (const round of [1, 2]) {
    const replies = await run("promote");
    assert.match(JSON.stringify(replies.at(-1)), /晋级比赛播报完成/, `round ${round}`);
    await until(() => sent.length === round * 2 && spoken.length === round * 2, `round ${round}'s report, 段位播报 and both voice lines`);
    const report = sent[(round - 1) * 2];
    const cast = sent[(round - 1) * 2 + 1];
    assert.equal(rankField(report), "<@tracked-user> 单双排 铂金 IV · 12 LP · 本局 +22 · 晋级！", `round ${round}`);
    assert.equal(embedJson(cast).title, "模拟数据 · 段位播报");
    assert.equal(embedJson(cast).description, "<@tracked-user> 单双排 晋级：黄金 I → 铂金 IV · 12 LP");
    assert.deepEqual(cast.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
    assert.doesNotMatch(spoken[(round - 1) * 2], /段位/, "the report's own speech never mentions LP");
    assert.match(spoken[(round - 1) * 2 + 1], /^模拟段位播报，.*铂金四/);
  }

  const replies = await run("demote");
  assert.match(JSON.stringify(replies.at(-1)), /掉段比赛播报完成/);
  await until(() => sent.length === 6 && spoken.length === 6, "the demotion's report, 段位播报 and voice line");
  assert.equal(rankField(sent[4]), "<@tracked-user> 单双排 白银 I · 86 LP · 本局掉段");
  assert.equal(embedJson(sent[5]).description, "<@tracked-user> 单双排 掉段：黄金 IV → 白银 I · 86 LP");
  assert.match(spoken[5], /^模拟段位播报，.*白银一/);
});
