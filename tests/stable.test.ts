import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import stableCommand from "../src/commands/stable";
import stableEraseCommand from "../src/commands/stableErase";
import { closeAppeal, isAppealClosed } from "../src/store/appealStore";
import { removeTrackedMember, setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import { countMemberHorseRecords } from "../src/store/horseRecordStore";
import type { HorseRecord } from "../src/store/horseRecordStore";
import { listRankResults, recordRankResults } from "../src/store/rankStore";
import type { HorseTier } from "../src/services/horseRanking";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

const GUILD = "stable-guild";
let directory: string;
let saved: Record<string, string | undefined>;
let savedLog: typeof console.log;
const logs: string[] = [];

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-stable-"));
  saved = { DATABASE_PATH: process.env.DATABASE_PATH, RIOT_MODE: process.env.RIOT_MODE };
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.RIOT_MODE = "real";
  savedLog = console.log;
  logs.length = 0;
  console.log = (line: string) => { logs.push(String(line)); };
});

afterEach(() => {
  closeDatabase();
  console.log = savedLog;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

interface Reply { content?: string; flags?: number; allowedMentions?: unknown; embeds?: Array<{ toJSON: () => { title?: string; description?: string; footer?: { text: string }; fields?: Array<{ name: string; value: string }> } }> }

function interaction(options: { userId?: string; target?: string; admin?: boolean; guild?: boolean; confirm?: boolean | null } = {}) {
  const replies: Reply[] = [];
  const stub = {
    guildId: options.guild === false ? null : GUILD,
    user: { id: options.userId ?? "caller" },
    inGuild: () => options.guild !== false,
    memberPermissions: { has: () => options.admin !== false },
    options: {
      getUser: (_name: string, required?: boolean) => options.target ? { id: options.target } : required ? { id: "missing" } : null,
      getBoolean: () => options.confirm ?? null,
    },
    reply: async (payload: Reply) => { replies.push(payload); },
  };
  return { stub: stub as unknown as Parameters<typeof stableCommand.execute>[0], replies };
}

const embedOf = (reply: Reply) => reply.embeds![0].toJSON();
const fieldText = (reply: Reply, name: string) => embedOf(reply).fields!.find((field) => field.name.startsWith(name))?.value;
const NO_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false };

const DIMENSIONS = { damage: 0.8, teamfight: 0.6, survival: 0.5, economy: 0.3, frontline: 0, vision: 0, objectives: 0.55, utility: 0, matchup: 0.7 };

function seed(results: Array<[HorseTier, number]>, overrides: Partial<HorseRecord> = {}): HorseRecord[] {
  return results.map(([tier, score], index) => makeHorseRecord({
    guildId: GUILD,
    discordUserId: "friend",
    puuid: `puuid-${overrides.discordUserId ?? "friend"}`,
    matchId: `NA1_STABLE_${overrides.mock ? "M" : "R"}${index}`,
    playedAt: 1_800_000_000_000 + index * 3_600_000,
    tier,
    score,
    dimensions: DIMENSIONS,
    ...overrides,
  }));
}

const FULL: Array<[HorseTier, number]> = [
  ["特等马", 9], ["特等马", 9.5], ["上等马", 7], ["没有马", 1], ["没有马", 0.5],
  ["中等马", 5], ["特等马", 9], ["特等马", 9.2], ["特等马", 8.8], ["没有马", 1.6],
];

test("/stable shows a clear empty state for a tracked member without games", async () => {
  setMemberAccounts(GUILD, "caller", [{ puuid: "p1", gameName: "Caller", tagLine: "NA1" }]);
  const { stub, replies } = interaction();
  await stableCommand.execute(stub);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, undefined, "the profile is a public reply");
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
  const embed = embedOf(replies[0]);
  assert.equal(embed.title, "马厩档案 · 策马军师");
  assert.match(embed.description!, /<@caller> 的马厩还是空的/);
  assert.match(embed.description!, /打完第一把就有了/);
  assert.equal(embed.fields, undefined);
  assert.equal(embed.footer?.text, "Riot 实时数据 • 策马军师");
});

test("/stable explains an empty profile of someone who was never bound", async () => {
  const { stub, replies } = interaction({ target: "stranger" });
  await stableCommand.execute(stub);
  assert.match(embedOf(replies[0]).description!, /<@stranger> 的马厩还是空的/);
  assert.match(embedOf(replies[0]).description!, /还没有被绑定.*\/bind/);
});

test("/stable shows the full profile of the chosen member from stored records", async () => {
  setMemberAccounts(GUILD, "friend", [{ puuid: "p2", gameName: "Friend", tagLine: "NA1" }]);
  recordTracked(seed(FULL));
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  const embed = embedOf(replies[0]);
  assert.equal(embed.title, "马厩档案 · 策马军师");
  assert.equal(embed.description, "<@friend> · 共鉴定 **10** 局 · 10 胜 0 负 · 平均 **6.1** 分");
  assert.equal(fieldText(replies[0], "马匹分布"), [
    "👑 特等马 5 次 (50%)", "🐎 上等马 1 次 (10%)", "🐴 中等马 1 次 (10%)", "🫏 下等马 0 次 (0%)", "🪦 没有马 3 次 (30%)",
  ].join("\n"));
  assert.equal(fieldText(replies[0], "连续纪录"), "👑 特等马：当前连续 0 局，最长 3 局\n🪦 没有马：当前连续 1 局，最长 2 局");
  assert.equal(fieldText(replies[0], "近 10 局"), "🪦 👑 👑 👑 🐴 🪦 🪦 🐎 👑 👑");
  assert.equal(fieldText(replies[0], "强弱项"), "最强：输出，平均超过 80% 的同位置玩家（10 局）\n最弱：经济，平均超过 30% 的同位置玩家（10 局）");
  assert.match(fieldText(replies[0], "军师批注")!, /没有马率30%，经济常年垫底，/);
  const recent = fieldText(replies[0], "最近 5 局")!.split("\n");
  assert.equal(recent.length, 5);
  assert.match(recent[0], /^🪦 没有马 · 阿狸 · 5\/3\/8 · 1\.6 分 · .* · <t:\d+:R>$/);
  assert.match(recent[1], /^👑 特等马 /);
});

test("/stable defaults to the caller", async () => {
  recordTracked(seed(FULL.slice(0, 3), { discordUserId: "caller" }));
  const { stub, replies } = interaction();
  await stableCommand.execute(stub);
  assert.match(embedOf(replies[0]).description!, /^<@caller> · 共鉴定 \*\*3\*\* 局/);
});

test("a short history says the sample is too small instead of naming a strongest dimension", async () => {
  recordTracked(seed(FULL.slice(0, 2)));
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  assert.match(fieldText(replies[0], "强弱项")!, /每个维度至少要 3 局/);
  assert.match(fieldText(replies[0], "军师批注")!, /才鉴定了几局|样本太少/);
  assert.equal(fieldText(replies[0], "最近 2 局")!.split("\n").length, 2);
});

test("history stays visible after /unbind, with a note about erasing it", async () => {
  setMemberAccounts(GUILD, "friend", [{ puuid: "p2", gameName: "Friend", tagLine: "NA1" }]);
  recordTracked(seed(FULL.slice(0, 4)));
  removeTrackedMember(GUILD, "friend");
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  assert.match(embedOf(replies[0]).description!, /共鉴定 \*\*4\*\* 局/);
  assert.match(embedOf(replies[0]).description!, /已经解除绑定.*\/stable-erase/);
});

test("in real mode mock games never count, and the profile says where they went", async () => {
  recordTracked([...seed(FULL.slice(0, 3)), ...seed([["没有马", 0.1], ["没有马", 0.2]], { mock: true })]);
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  const embed = embedOf(replies[0]);
  assert.match(embed.description!, /共鉴定 \*\*3\*\* 局/);
  assert.match(embed.description!, /另有 2 局模拟数据的记录，不计入真实档案/);
  assert.ok(!embed.title!.includes("模拟"));
  assert.equal(fieldText(replies[0], "马匹分布")!.includes("没有马 0 次"), true);
});

test("in mock mode only mock games show, visibly labeled", async () => {
  process.env.RIOT_MODE = "mock";
  recordTracked([...seed(FULL.slice(0, 3)), ...seed([["没有马", 0.1], ["没有马", 0.2]], { mock: true })]);
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  const embed = embedOf(replies[0]);
  assert.equal(embed.title, "模拟数据 · 马厩档案");
  assert.equal(embed.footer?.text, "模拟数据 / Mock data • 策马军师");
  assert.match(embed.description!, /共鉴定 \*\*2\*\* 局/);
  assert.match(embed.description!, /另有 3 局真实对局的档案，模拟模式下不显示/);
  assert.equal(fieldText(replies[0], "马匹分布")!.includes("没有马 2 次 (100%)"), true);
});

test("in mock mode with only real games the profile is empty and says so", async () => {
  process.env.RIOT_MODE = "mock";
  setMemberAccounts(GUILD, "friend", [{ puuid: "p2", gameName: "Friend", tagLine: "NA1" }]);
  recordTracked(seed(FULL.slice(0, 3)));
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  assert.match(embedOf(replies[0]).description!, /还是空的/);
  assert.match(embedOf(replies[0]).description!, /另有 3 局真实对局的档案/);
});

test("the 军师 remark reads a hot streak and stays about play", async () => {
  recordTracked(seed([["没有马", 1], ["特等马", 9], ["特等马", 9], ["特等马", 9]]));
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  assert.match(fieldText(replies[0], "军师批注")!, /连着3局特等马/);
  const cold = interaction({ target: "friend" });
  recordTracked(seed([["没有马", 1], ["没有马", 1], ["没有马", 1]], { matchId: "NA1_COLD" }).map((record, index) => ({ ...record, matchId: `NA1_COLD_${index}`, playedAt: 1_900_000_000_000 + index * 1000 })));
  await stableCommand.execute(cold.stub);
  assert.match(fieldText(cold.replies[0], "军师批注")!, /连着3局没有马/);
});

test("/stable refuses direct messages", async () => {
  const { stub, replies } = interaction({ guild: false });
  await stableCommand.execute(stub);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(embedOf(replies[0]).description!, /只能在服务器里使用/);
});

test("/stable-erase needs an administrator and erases nothing without one", async () => {
  recordTracked(seed(FULL.slice(0, 3)));
  const { stub, replies } = interaction({ target: "friend", admin: false, confirm: true });
  await stableEraseCommand.execute(stub);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[0].content!, /Administrator/);
  assert.deepEqual(countMemberHorseRecords(GUILD, "friend"), { real: 3, mock: 0 });
});

test("/stable-erase counts first and erases only on confirmation", async () => {
  recordTracked([
    ...seed(FULL.slice(0, 3)),
    ...seed(FULL.slice(0, 1), { mock: true }),
    ...seed(FULL.slice(0, 2), { discordUserId: "someone-else" }),
  ]);
  const dry = interaction({ target: "friend" });
  await stableEraseCommand.execute(dry.stub);
  assert.equal(dry.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(dry.replies[0].allowedMentions, NO_MENTIONS);
  assert.match(dry.replies[0].content!, /3 局真实记录和 1 局模拟记录.*confirm/);
  assert.deepEqual(countMemberHorseRecords(GUILD, "friend"), { real: 3, mock: 1 });

  const refused = interaction({ target: "friend", confirm: false });
  await stableEraseCommand.execute(refused.stub);
  assert.deepEqual(countMemberHorseRecords(GUILD, "friend"), { real: 3, mock: 1 });

  const real = interaction({ target: "friend", confirm: true });
  await stableEraseCommand.execute(real.stub);
  assert.deepEqual(real.replies[0].allowedMentions, NO_MENTIONS);
  assert.match(real.replies[0].content!, /已清除 <@friend> 的全部马厩档案（3 局真实记录和 1 局模拟记录）/);
  assert.deepEqual(countMemberHorseRecords(GUILD, "friend"), { real: 0, mock: 0 });
  assert.deepEqual(countMemberHorseRecords(GUILD, "someone-else"), { real: 2, mock: 0 });
  assert.ok(logs.some((line) => /Erased 4 horse records/.test(line)));

  const again = interaction({ target: "friend", confirm: true });
  await stableEraseCommand.execute(again.stub);
  assert.match(again.replies[0].content!, /没有马厩档案/);

  // The profile is empty again afterwards.
  const profile = interaction({ target: "friend" });
  await stableCommand.execute(profile.stub);
  assert.match(embedOf(profile.replies[0]).description!, /还是空的/);
});

test("a profile prints scores with the announcement's rounding", async () => {
  recordTracked(seed([["没有马", 0.15], ["没有马", 0.15], ["没有马", 0.15]]));
  const { stub, replies } = interaction({ target: "friend" });
  await stableCommand.execute(stub);
  assert.match(embedOf(replies[0]).description!, /平均 \*\*0\.2\*\* 分/);
  assert.match(fieldText(replies[0], "最近 3 局")!, /· 0\.2 分 ·/);
});

test("the rate remark never says 你 on someone else's profile", async () => {
  const rows = seed([["没有马", 1], ["没有马", 1], ["没有马", 1], ["上等马", 7], ["上等马", 7]], { discordUserId: "caller" });
  recordTracked(rows.map((record, index) => ({ ...record, playedAt: 1_800_000_000_000 + index * 1000 })));
  const mine = interaction({ userId: "caller" });
  await stableCommand.execute(mine.stub);
  const others = interaction({ userId: "viewer", target: "caller" });
  await stableCommand.execute(others.stub);
  assert.match(fieldText(mine.replies[0], "军师批注")!, /没有马率60%/);
  assert.match(fieldText(others.replies[0], "军师批注")!, /没有马率60%/);
  assert.ok(!fieldText(others.replies[0], "军师批注")!.includes("你"));
});

test("the streak remark names someone else but speaks to the member", async () => {
  recordTracked(seed([["特等马", 9], ["没有马", 1], ["没有马", 1], ["没有马", 1]], { discordUserId: "caller" }));
  const mine = interaction({ userId: "caller" });
  await stableCommand.execute(mine.stub);
  const others = interaction({ userId: "viewer", target: "caller" });
  await stableCommand.execute(others.stub);
  assert.match(fieldText(mine.replies[0], "军师批注")!, /军师替你捏了一把汗/);
  assert.match(fieldText(others.replies[0], "军师批注")!, /军师替<@caller>捏了一把汗/);
  assert.ok(!fieldText(others.replies[0], "军师批注")!.includes("你"));
});

test("常年垫底 needs an average percentile of 0.3 or below, and a milder phrase fits up to 0.4", async () => {
  const withEconomy = (economy: number) => seed(FULL, { dimensions: { ...DIMENSIONS, economy } });
  recordTracked(withEconomy(0.3));
  const bottom = interaction({ target: "friend" });
  await stableCommand.execute(bottom.stub);
  assert.match(fieldText(bottom.replies[0], "军师批注")!, /经济常年垫底/);
  closeDatabase();
  process.env.DATABASE_PATH = join(directory, "second.sqlite3");

  recordTracked(withEconomy(0.35));
  const middling = interaction({ target: "friend" });
  await stableCommand.execute(middling.stub);
  const remarkText = fieldText(middling.replies[0], "军师批注")!;
  assert.match(remarkText, /经济是明显的短板/);
  assert.ok(!remarkText.includes("常年垫底"));
  closeDatabase();
  process.env.DATABASE_PATH = join(directory, "third.sqlite3");

  recordTracked(withEconomy(0.45).map((record) => ({ ...record, dimensions: { ...record.dimensions, damage: 0.9 } })));
  const fine = interaction({ target: "friend" });
  await stableCommand.execute(fine.stub);
  const fineText = fieldText(fine.replies[0], "军师批注")!;
  assert.ok(!fineText.includes("常年垫底") && !fineText.includes("短板"), fineText);
});

test("/stable-erase counts and erases a member who has only LP results or appeal cases", async () => {
  const rankResult = {
    guildId: GUILD, discordUserId: "friend", matchId: "NA1_R", mock: false, puuid: "account-a", queueType: "solo" as const,
    playedAt: 1_800_000_000_000, recordedAt: 1_800_000_060_000, kind: "change" as const, tier: "GOLD", division: "II", leaguePoints: 86,
    lpDelta: 22, beforeTier: "GOLD", beforeDivision: "II", beforeLeaguePoints: 64,
  };
  // No horse record at all, for example because that write failed.
  recordRankResults([rankResult, { ...rankResult, matchId: "NA1_S", mock: true }, { ...rankResult, discordUserId: "someone-else" }]);
  closeAppeal({ guildId: GUILD, discordUserId: "friend", matchId: "NA1_R", mock: false });
  assert.deepEqual(countMemberHorseRecords(GUILD, "friend"), { real: 0, mock: 0 });

  const dry = interaction({ target: "friend" });
  await stableEraseCommand.execute(dry.stub);
  assert.doesNotMatch(dry.replies[0].content!, /没有马厩档案/);
  assert.match(dry.replies[0].content!, /0 局真实记录和 0 局模拟记录，以及 1 个上诉案件和 2 条段位记录.*confirm/);
  assert.equal(listRankResults(GUILD, { mock: false, discordUserId: "friend" }).length, 1, "a dry run erases nothing");

  const real = interaction({ target: "friend", confirm: true });
  await stableEraseCommand.execute(real.stub);
  assert.match(real.replies[0].content!, /已清除 <@friend> 的全部马厩档案（.*1 个上诉案件和 2 条段位记录）/);
  assert.deepEqual(listRankResults(GUILD, { mock: false, discordUserId: "friend" }), []);
  assert.deepEqual(listRankResults(GUILD, { mock: true, discordUserId: "friend" }), []);
  assert.equal(isAppealClosed({ guildId: GUILD, discordUserId: "friend", matchId: "NA1_R", mock: false }), false);
  assert.equal(listRankResults(GUILD, { mock: false, discordUserId: "someone-else" }).length, 1, "another member is untouched");

  const again = interaction({ target: "friend", confirm: true });
  await stableEraseCommand.execute(again.stub);
  assert.match(again.replies[0].content!, /没有马厩档案/);

  // Only an appeal case is enough as well.
  closeAppeal({ guildId: GUILD, discordUserId: "lonely", matchId: "NA1_A", mock: false });
  const lonely = interaction({ target: "lonely" });
  await stableEraseCommand.execute(lonely.stub);
  assert.match(lonely.replies[0].content!, /以及 1 个上诉案件。/);
});

test("/stable-erase is hidden from non-administrators by default", () => {
  assert.equal(stableEraseCommand.data.toJSON().default_member_permissions, String(PermissionFlagsBits.Administrator));
});
