import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import reportCommand from "../src/commands/report";
import reportSettingsCommand from "../src/commands/reportSettings";
import { setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import {
  getReportMark,
  getReportSettings,
  setReportChannel,
  setReportRoleHolders,
  setReportRoles,
} from "../src/store/reportStore";
import { periodOf } from "../src/services/reports";
import { HIERARCHY_PROBLEM, MISSING_MANAGE_ROLES, NONE_ROLE_NAME, TOP_ROLE_NAME } from "../src/services/reportRoles";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";
import { FakeRoleGuild, discordError } from "./helpers/fakeRoleGuild";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

const GUILD = "command-guild";
const NO_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false };
let directory: string;
let saved: Record<string, string | undefined>;
let savedLog: typeof console.log;
let savedError: typeof console.error;

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-report-commands-"));
  saved = { DATABASE_PATH: process.env.DATABASE_PATH, RIOT_MODE: process.env.RIOT_MODE };
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.RIOT_MODE = "real";
  savedLog = console.log;
  console.log = () => undefined;
  savedError = console.error;
  console.error = () => undefined;
});

afterEach(() => {
  closeDatabase();
  console.log = savedLog;
  console.error = savedError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

interface Reply { content?: string; flags?: number; allowedMentions?: unknown; embeds?: Array<{ toJSON: () => { title?: string; description?: string; footer?: { text: string }; fields?: Array<{ name: string; value: string }> } }> }

/** Channel permissions the bot has in the fake channel. */
interface Setup {
  admin?: boolean;
  guild?: boolean;
  channelPermissions?: bigint[];
  channelKind?: "text" | "thread" | "missing";
  roles?: FakeRoleGuild;
}

function discordGuild(fake: FakeRoleGuild, setup: Setup) {
  const has = (flag: bigint) => (setup.channelPermissions ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]).includes(flag);
  return {
    id: GUILD,
    members: {
      me: fake.standing
        ? { permissions: { has: (flag: bigint) => fake.standing!.manageRoles && flag === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: fake.standing.highestRolePosition } } }
        : null,
      fetchMe: async () => { throw new Error("not found"); },
      fetch: async (id: string) => {
        const member = await fake.fetchMember(id);
        if (!member) throw discordError(10007, "Unknown Member");
        return member;
      },
    },
    roles: {
      fetch: async (id: string) => fake.fetchRole(id),
      create: async (options: { name: string; reason: string }) => fake.createRole(options.name, options.reason),
    },
    channels: {
      fetch: async (id: string) => {
        if (setup.channelKind === "missing") return null;
        return {
          id,
          isTextBased: () => true,
          isDMBased: () => false,
          isThread: () => setup.channelKind === "thread",
          permissionsFor: () => ({ has }),
        };
      },
    },
  };
}

function settingsInteraction(subcommand: string, values: { channel?: string; enabled?: boolean; top?: string; none?: string } = {}, setup: Setup = {}) {
  const replies: Reply[] = [];
  const fake = setup.roles ?? new FakeRoleGuild();
  let deferred = false;
  const stub = {
    guildId: setup.guild === false ? null : GUILD,
    guild: setup.guild === false ? null : discordGuild(fake, setup),
    inGuild: () => setup.guild !== false,
    memberPermissions: { has: () => setup.admin !== false },
    get deferred() { return deferred; },
    replied: false,
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => ({ id: values.channel ?? "channel-1" }),
      getBoolean: () => values.enabled ?? null,
      getRole: (name: string) => {
        const id = name === "top-role" ? values.top : values.none;
        return id ? { id } : null;
      },
    },
    reply: async (payload: Reply) => { replies.push(payload); },
    deferReply: async () => { deferred = true; },
    editReply: async (payload: Reply) => { replies.push({ ...payload, flags: MessageFlags.Ephemeral }); },
  };
  return { stub: stub as unknown as Parameters<typeof reportSettingsCommand.execute>[0], replies, fake };
}

const run = async (...args: Parameters<typeof settingsInteraction>) => {
  const made = settingsInteraction(...args);
  await reportSettingsCommand.execute(made.stub);
  return made;
};

test("the settings command is Administrator-only both in its definition and when run", async () => {
  const json = reportSettingsCommand.data.toJSON();
  assert.equal(json.name, "report-settings");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.deepEqual(json.options!.map((option) => option.name), ["show", "channel", "channel-clear", "daily", "weekly", "roles"]);
  const { replies } = await run("channel", {}, { admin: false });
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[0].content!, /Administrator/);
  assert.equal(getReportSettings(GUILD), undefined);
  const dm = await run("show", {}, { guild: false });
  assert.equal(dm.replies.length, 1);
  assert.deepEqual(dm.replies[0].allowedMentions, NO_MENTIONS, "even the error reply sets allowedMentions");
});

test("setting the channel checks the bot can post there and saves nothing when it cannot", async () => {
  const blocked = await run("channel", {}, { channelPermissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(blocked.replies[0].content!, /<#channel-1>.*Send Messages.*Embed Links/s);
  assert.equal(getReportSettings(GUILD), undefined);
  for (const channelKind of ["thread", "missing"] as const) {
    const bad = await run("channel", {}, { channelKind });
    assert.match(bad.replies[0].content!, /文字频道/);
  }
  assert.equal(getReportSettings(GUILD), undefined);
});

test("a first channel starts reports from the next period instead of replaying the last one", async () => {
  const before = Date.now();
  const { replies } = await run("channel");
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
  assert.match(replies[0].content!, /已设置马报频道 <#channel-1>/);
  assert.equal(getReportSettings(GUILD)?.channelId, "channel-1");
  for (const mock of [false, true]) {
    assert.equal(getReportMark(GUILD, mock, "day"), periodOf("day", periodOf("day", before).start - 1).start);
    assert.equal(getReportMark(GUILD, mock, "week"), periodOf("week", periodOf("week", before).start - 1).start);
  }
  // Moving it later keeps everything else and says so.
  const moved = await run("channel", { channel: "channel-2" });
  assert.match(moved.replies[0].content!, /已改到马报频道 <#channel-2>/);
  assert.equal(getReportSettings(GUILD)?.channelId, "channel-2");
});

test("the channel can be cleared and the daily and weekly switches change independently", async () => {
  await run("channel");
  const off = await run("daily", { enabled: false });
  assert.match(off.replies[0].content!, /每日马报已关闭/);
  assert.match(off.replies[0].content!, /每日马报：关 · 每周马报：开/);
  assert.equal(getReportSettings(GUILD)?.dailyEnabled, false);
  assert.equal(getReportSettings(GUILD)?.weeklyEnabled, true);
  const weeklyOff = await run("weekly", { enabled: false });
  assert.match(weeklyOff.replies[0].content!, /每周马报已关闭/);
  const on = await run("daily", { enabled: true });
  assert.match(on.replies[0].content!, /已开启，从下一个结算时间开始发/);
  assert.equal(getReportSettings(GUILD)?.dailyEnabled, true);
  const cleared = await run("channel-clear");
  assert.match(cleared.replies[0].content!, /已清除/);
  assert.equal(getReportSettings(GUILD)?.channelId, null);
  assert.match((await run("channel-clear")).replies[0].content!, /本来就没有/);
  assert.match((await run("show")).replies[0].content!, /频道：未设置/);
});

test("enabling roles without Manage Roles explains the fix privately and changes nothing", async () => {
  const roles = new FakeRoleGuild();
  roles.standing = { manageRoles: false, highestRolePosition: 5 };
  const { replies } = await run("roles", { enabled: true }, { roles });
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[0].content!, /什么都没有改动/);
  assert.ok(replies[0].content!.includes(MISSING_MANAGE_ROLES));
  assert.deepEqual(roles.changes, []);
  assert.equal(getReportSettings(GUILD)?.rolesEnabled ?? false, false);
});

test("enabling roles creates the two roles below the bot, saves them and explains how they rotate", async () => {
  const roles = new FakeRoleGuild();
  const { replies } = await run("roles", { enabled: true }, { roles });
  assert.deepEqual(roles.changes, [`create:${TOP_ROLE_NAME}`, `create:${NONE_ROLE_NAME}`]);
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.rolesEnabled, settings.topRoleId, settings.noneRoleId], [true, "created-1", "created-2"]);
  assert.match(replies[0].content!, /已开启每周身份组：<@&created-1> 和 <@&created-2>/);
  assert.match(replies[0].content!, /还没有设置马报频道/);
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
});

test("enabling roles can reuse existing roles, and refuses ones the bot cannot manage", async () => {
  const roles = new FakeRoleGuild();
  roles.addRole("mine-top", "头马", 2);
  roles.addRole("mine-none", "垫底", 3);
  roles.addRole("too-high", "老大", 20);
  const same = await run("roles", { enabled: true, top: "mine-top", none: "mine-top" }, { roles });
  assert.match(same.replies[0].content!, /两个不同/);
  const high = await run("roles", { enabled: true, top: "too-high", none: "mine-none" }, { roles });
  assert.match(high.replies[0].content!, /什么都没有改动/);
  assert.match(high.replies[0].content!, /不低于机器人的最高身份组/);
  assert.equal(getReportSettings(GUILD)?.rolesEnabled ?? false, false);
  const good = await run("roles", { enabled: true, top: "mine-top", none: "mine-none" }, { roles });
  assert.match(good.replies[0].content!, /<@&mine-top> 和 <@&mine-none>/);
  assert.deepEqual(roles.changes, [], "existing roles are reused, nothing is created");
  assert.equal(getReportSettings(GUILD)?.topRoleId, "mine-top");
});

test("previously configured roles that rose above the bot are reported instead of silently enabled", async () => {
  const roles = new FakeRoleGuild();
  roles.addRole("old-top", TOP_ROLE_NAME, 30);
  roles.addRole("old-none", NONE_ROLE_NAME, 1);
  setReportChannel(GUILD, "channel-1");
  setReportRoles(GUILD, { enabled: true, topRoleId: "old-top", noneRoleId: "old-none" });
  setReportRoles(GUILD, { enabled: false });
  const { replies } = await run("roles", { enabled: true }, { roles });
  assert.ok(replies[0].content!.includes(HIERARCHY_PROBLEM));
  assert.equal(getReportSettings(GUILD)?.rolesEnabled, false);
});

test("a Discord refusal while creating the roles becomes a private explanation, not an error", async () => {
  const roles = new FakeRoleGuild();
  roles.failures.create = discordError(50013);
  const { replies } = await run("roles", { enabled: true }, { roles });
  assert.match(replies[0].content!, /没能完成身份组设置/);
  assert.match(replies[0].content!, /Manage Roles|权限/);
  assert.equal(getReportSettings(GUILD)?.rolesEnabled ?? false, false);
});

test("disabling roles takes them back from the members the bot gave them to and keeps the role ids", async () => {
  const roles = new FakeRoleGuild();
  roles.addRole("role-top", TOP_ROLE_NAME, 1);
  roles.addRole("role-none", NONE_ROLE_NAME, 1);
  roles.addMember("alice", ["role-top"]);
  roles.addMember("bob", ["role-none"]);
  setReportChannel(GUILD, "channel-1");
  setReportRoles(GUILD, { enabled: true, topRoleId: "role-top", noneRoleId: "role-none" });
  setReportRoleHolders(GUILD, { top: ["alice"], none: ["bob"] });
  const { replies } = await run("roles", { enabled: false }, { roles });
  assert.match(replies[0].content!, /已关闭每周身份组，并从机器人发过身份组的成员身上收回了它们/);
  assert.deepEqual(roles.changes, ["remove:role-top:alice", "remove:role-none:bob"]);
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.rolesEnabled, settings.topRoleId, settings.topHolderIds, settings.noneHolderIds], [false, "role-top", [], []]);
  assert.match((await run("roles", { enabled: false }, { roles })).replies[0].content!, /本来就是关闭的/);
});

test("disabling roles keeps holders that could not be released and says what to do", async () => {
  const roles = new FakeRoleGuild();
  roles.addRole("role-top", TOP_ROLE_NAME, 1);
  roles.addRole("role-none", NONE_ROLE_NAME, 1);
  roles.addMember("alice", ["role-top"]);
  setReportRoles(GUILD, { enabled: true, topRoleId: "role-top", noneRoleId: "role-none" });
  setReportRoleHolders(GUILD, { top: ["alice"], none: [] });
  roles.failures.remove = discordError(50013);
  const { replies } = await run("roles", { enabled: false }, { roles });
  assert.match(replies[0].content!, /没能收回全部身份组/);
  assert.deepEqual(getReportSettings(GUILD)?.topHolderIds, ["alice"]);
  assert.equal(getReportSettings(GUILD)?.rolesEnabled, false);
});

function reportInteraction(kind: "day" | "week", when: string | null, guild = true) {
  const replies: Reply[] = [];
  const stub = {
    guildId: guild ? GUILD : null,
    options: { getSubcommand: () => kind, getString: () => when },
    reply: async (payload: Reply) => { replies.push(payload); },
  };
  return { stub: stub as unknown as Parameters<typeof reportCommand.execute>[0], replies };
}

function seed(range: { start: number }, extra: { mock?: boolean } = {}): void {
  setMemberAccounts(GUILD, "alice", [{ puuid: "puuid-alice", gameName: "Alice", tagLine: "NA1" }]);
  setMemberAccounts(GUILD, "bob", [{ puuid: "puuid-bob", gameName: "Bob", tagLine: "NA1" }]);
  recordTracked([
    makeHorseRecord({ guildId: GUILD, discordUserId: "alice", puuid: "puuid-alice", tier: "特等马", score: 9, playedAt: range.start + 1000, ...extra }),
    makeHorseRecord({ guildId: GUILD, discordUserId: "bob", puuid: "puuid-bob", tier: "没有马", score: 1, playedAt: range.start + 2000, ...extra }),
  ]);
}

test("/report is public, shows the day in progress by default and never pings", async () => {
  assert.equal(reportCommand.data.toJSON().default_member_permissions, undefined, "anyone can run it");
  seed(pacificDay(Date.now()));
  const { stub, replies } = reportInteraction("day", null);
  await reportCommand.execute(stub);
  assert.equal(replies[0].flags, undefined);
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
  const embed = replies[0].embeds![0].toJSON();
  assert.match(embed.title!, /^每日马报 · \d{4}-\d{2}-\d{2} 周.（进行中）$/);
  assert.match(embed.fields!.find((field) => field.name.includes("今日特等马"))!.value, /^<@alice>/);
  assert.match(embed.fields!.find((field) => field.name.includes("今日没有马"))!.value, /^<@bob>/);
});

test("/report week previous shows the finished week and a day with no games says so", async () => {
  const lastWeek = pacificWeek(pacificWeek(Date.now()).start - 1);
  seed(lastWeek);
  const { stub, replies } = reportInteraction("week", "previous");
  await reportCommand.execute(stub);
  const embed = replies[0].embeds![0].toJSON();
  assert.ok(!embed.title!.includes("进行中"));
  assert.match(embed.description!, /共 \*\*2\*\* 局/);
  const empty = reportInteraction("day", "previous");
  await reportCommand.execute(empty.stub);
  assert.match(empty.replies[0].embeds![0].toJSON().description!, /没有任何对局入档/);
});

test("/report in mock mode shows only labeled mock games", async () => {
  process.env.RIOT_MODE = "mock";
  seed(pacificDay(Date.now()), { mock: false });
  const { stub, replies } = reportInteraction("day", null);
  await reportCommand.execute(stub);
  const embed = replies[0].embeds![0].toJSON();
  assert.match(embed.title!, /^模拟数据 · /);
  assert.match(embed.description!, /没有任何对局入档/, "real games are not shown in mock mode");
  assert.match(embed.footer!.text, /模拟数据/);
});

test("/report works only in a server", async () => {
  const { stub, replies } = reportInteraction("day", null, false);
  await reportCommand.execute(stub);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
});

/** A server with both weekly roles in place and holders recorded, as after a rotation. */
function rolesInUse(): FakeRoleGuild {
  const roles = new FakeRoleGuild();
  roles.addRole("role-top", TOP_ROLE_NAME, 1);
  roles.addRole("role-none", NONE_ROLE_NAME, 1);
  roles.addMember("alice", ["role-top"]);
  roles.addMember("bob", ["role-none"]);
  setReportChannel(GUILD, "channel-1");
  setReportRoles(GUILD, { enabled: true, topRoleId: "role-top", noneRoleId: "role-none" });
  setReportRoleHolders(GUILD, { top: ["alice"], none: ["bob"] });
  return roles;
}

test("switching to other roles takes the old ones back from their holders first", async () => {
  const roles = rolesInUse();
  roles.addRole("new-top", "头马", 2);
  const { replies } = await run("roles", { enabled: true, top: "new-top" }, { roles });
  assert.deepEqual(roles.changes, ["remove:role-top:alice"], "only the replaced role is released; the unchanged one keeps its holder");
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.topRoleId, settings.noneRoleId, settings.topHolderIds, settings.noneHolderIds], ["new-top", "role-none", [], ["bob"]]);
  assert.match(replies[0].content!, /已开启每周身份组：<@&new-top> 和 <@&role-none>/);
  assert.ok(!roles.members.get("alice")!.has("role-top"));
});

test("holders who cannot be released from a replaced role are listed for manual cleanup", async () => {
  const roles = rolesInUse();
  roles.addRole("new-top", "头马", 2);
  roles.failures.remove = discordError(50013);
  const { replies } = await run("roles", { enabled: true, top: "new-top" }, { roles });
  assert.match(replies[0].content!, /还拿着换下来的身份组 <@&role-top>，请手动收回：<@alice>/);
  assert.equal(getReportSettings(GUILD)?.topRoleId, "new-top");
});

test("clearing the channel while roles are on takes the roles back and turns them off", async () => {
  const roles = rolesInUse();
  const { replies } = await run("channel-clear", {}, { roles });
  assert.deepEqual(roles.changes, ["remove:role-top:alice", "remove:role-none:bob"]);
  assert.match(replies[0].content!, /已清除马报频道/);
  assert.doesNotMatch(replies[0].content!, /其余设置保留/, "the roles were switched off, so not every other setting is kept");
  assert.match(replies[0].content!, /每周身份组跟着每周马报换人，所以也一并关闭了/);
  assert.match(replies[0].content!, /\/report-settings roles/);
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.channelId, settings.rolesEnabled, settings.topRoleId, settings.topHolderIds], [null, false, "role-top", []]);
});

test("switching weekly reports off while roles are on does the same, and switching them on again does not", async () => {
  const roles = rolesInUse();
  const { replies } = await run("weekly", { enabled: false }, { roles });
  assert.deepEqual(roles.changes, ["remove:role-top:alice", "remove:role-none:bob"]);
  assert.match(replies[0].content!, /每周马报已关闭/);
  assert.match(replies[0].content!, /一并关闭了/);
  assert.deepEqual([getReportSettings(GUILD)!.weeklyEnabled, getReportSettings(GUILD)!.rolesEnabled], [false, false]);
  await run("weekly", { enabled: true }, { roles });
  assert.equal(getReportSettings(GUILD)!.rolesEnabled, false, "roles stay off until they are enabled again");
});

test("clearing the channel or switching weekly off without roles touches no roles", async () => {
  const roles = new FakeRoleGuild();
  setReportChannel(GUILD, "channel-1");
  await run("weekly", { enabled: false }, { roles });
  const cleared = await run("channel-clear", {}, { roles });
  assert.deepEqual(roles.changes, []);
  assert.match(cleared.replies[0].content!, /已清除马报频道，不会再自动发马报。其余设置保留。/, "nothing else was switched off, so the settings are kept");
});

test("a failed release when clearing the channel is reported and the holders stay recorded", async () => {
  const roles = rolesInUse();
  roles.failures.remove = discordError(50013);
  const { replies } = await run("channel-clear", {}, { roles });
  assert.match(replies[0].content!, /没能收回全部身份组/);
  assert.doesNotMatch(replies[0].content!, /其余设置保留/);
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.channelId, settings.rolesEnabled, settings.topHolderIds], [null, false, ["alice"]]);
});

test("only an off-to-on switch skips the finished periods, so saying on again never drops a due report", async () => {
  setReportChannel(GUILD, "channel-1");
  await run("daily", { enabled: true });
  await run("weekly", { enabled: true });
  assert.equal(getReportMark(GUILD, false, "day"), undefined, "already on, nothing skipped");
  assert.equal(getReportMark(GUILD, false, "week"), undefined);
  await run("daily", { enabled: false });
  const on = await run("daily", { enabled: true });
  assert.match(on.replies[0].content!, /开启，从下一个结算时间开始发/);
  const now = Date.now();
  assert.equal(getReportMark(GUILD, false, "day"), periodOf("day", periodOf("day", now).start - 1).start);
  assert.equal(getReportMark(GUILD, false, "week"), undefined, "the other kind is untouched");
});

test("enabling inside the grace window skips the period that just ended instead of posting it", async () => {
  // Ten minutes after Pacific midnight the day that just ended is not yet due, and a switch-on still must not queue it.
  const justAfterMidnight = pacificDay(Date.now()).start + 10 * 60_000;
  const { skipFinishedPeriods } = await import("../src/services/reports");
  skipFinishedPeriods(GUILD, ["day"], justAfterMidnight);
  assert.equal(getReportMark(GUILD, false, "day"), pacificDay(pacificDay(justAfterMidnight).start - 1).start);
  assert.equal(getReportMark(GUILD, true, "day"), pacificDay(pacificDay(justAfterMidnight).start - 1).start);
});

test("a role created before a failure is remembered, and the next try reuses it", async () => {
  const roles = new FakeRoleGuild();
  roles.createLimit = 1;
  const first = await run("roles", { enabled: true }, { roles });
  assert.match(first.replies[0].content!, /没能完成身份组设置/);
  assert.deepEqual(roles.changes, [`create:${TOP_ROLE_NAME}`]);
  const afterFailure = getReportSettings(GUILD)!;
  assert.deepEqual([afterFailure.rolesEnabled, afterFailure.topRoleId, afterFailure.noneRoleId], [false, "created-1", null]);
  roles.createLimit = undefined;
  roles.changes.length = 0;
  const second = await run("roles", { enabled: true }, { roles });
  assert.deepEqual(roles.changes, [`create:${NONE_ROLE_NAME}`], "the first role is reused, not created twice");
  assert.match(second.replies[0].content!, /<@&created-1> 和 <@&created-2>/);
  assert.equal(getReportSettings(GUILD)?.rolesEnabled, true);
});
