import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";
import type { HorseRecord } from "../src/store/horseRecordStore";
import type { HorseTier } from "../src/services/horseRanking";
import { ReportChannelError, ReportScheduler, MAX_SEND_ATTEMPTS, REPORT_TICK_MS } from "../src/services/reportScheduler";
import type { ReportPayload, ReportSchedulerDeps } from "../src/services/reportScheduler";
import { REPORT_GRACE_MS } from "../src/services/reports";
import { NONE_ROLE_NAME, TOP_ROLE_NAME } from "../src/services/reportRoles";
import {
  getReportMark,
  getReportSettings,
  markReportHandled,
  setReportChannel,
  setReportKindEnabled,
  setReportRoles,
} from "../src/store/reportStore";
import { pacificDay, pacificWeek } from "../src/utils/pacificTime";
import { FakeRoleGuild, discordError } from "./helpers/fakeRoleGuild";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

const utc = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const GUILD = "scheduler-guild";
const CHANNEL = "report-channel";
// Wednesday 2026-10-28 00:10 PDT: Tuesday 10-27 has just become due, and so has the week of 10-19 to 10-25.
const NOW = utc("2026-10-28T07:10:00Z");
const DUE_DAY = pacificDay(utc("2026-10-27T19:00:00Z"));
const DUE_WEEK = pacificWeek(utc("2026-10-21T19:00:00Z"));

let directory: string;
let saved: Record<string, string | undefined>;
let savedConsole: { log: typeof console.log; error: typeof console.error };
const output: string[] = [];

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-scheduler-"));
  saved = { DATABASE_PATH: process.env.DATABASE_PATH, RIOT_MODE: process.env.RIOT_MODE };
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.RIOT_MODE = "real";
  savedConsole = { log: console.log, error: console.error };
  output.length = 0;
  console.log = (line: string) => { output.push(String(line)); };
  console.error = (line: string) => { output.push(String(line)); };
  setMemberAccounts(GUILD, "alice", [{ puuid: "puuid-alice", gameName: "Alice", tagLine: "NA1" }]);
  setMemberAccounts(GUILD, "bob", [{ puuid: "puuid-bob", gameName: "Bob", tagLine: "NA1" }]);
  setReportChannel(GUILD, CHANNEL);
});

afterEach(() => {
  closeDatabase();
  console.log = savedConsole.log;
  console.error = savedConsole.error;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

let counter = 0;
function game(user: string, tier: HorseTier, score: number, at: number, extra: Partial<HorseRecord> = {}): HorseRecord {
  counter += 1;
  return makeHorseRecord({ guildId: GUILD, discordUserId: user, puuid: `puuid-${user}`, matchId: `NA1_S${counter}`, tier, score, playedAt: at, ...extra });
}

/** Alice clearly better than Bob over `count` games starting at `start`. */
function seedGames(start: number, count = 3, extra: Partial<HorseRecord> = {}): void {
  const records: HorseRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    records.push(game("alice", "特等马", 9, start + index * HOUR, extra), game("bob", "没有马", 1, start + index * HOUR + 60_000, extra));
  }
  recordTracked(records);
}

interface Sent { guildId: string; channelId: string; payload: ReportPayload }

function harness(options: { now?: number; mock?: boolean } = {}) {
  const state = {
    now: options.now ?? NOW,
    mock: options.mock ?? false,
    sent: [] as Sent[],
    failures: [] as Error[],
    roleGuild: null as FakeRoleGuild | null,
    stopped: false,
    timers: [] as Array<{ callback: () => void; delay: number; cleared: boolean }>,
  };
  const deps: ReportSchedulerDeps = {
    now: () => state.now,
    mock: () => state.mock,
    async send(guildId, channelId, payload) {
      const failure = state.failures.shift();
      if (failure) throw failure;
      state.sent.push({ guildId, channelId, payload });
    },
    roleGuild: () => state.roleGuild,
    stopped: () => state.stopped,
    setTimer: (callback, delay) => { state.timers.push({ callback, delay, cleared: false }); return state.timers.length - 1; },
    clearTimer: (handle) => { state.timers[handle as number].cleared = true; },
  };
  return { state, deps, scheduler: new ReportScheduler(deps) };
}

const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const titles = (sent: Sent[]) => sent.map((message) => message.payload.embeds?.[0]?.toJSON().title);
const reports = (sent: Sent[]) => sent.filter((message) => message.payload.embeds);

test("a due day and week are posted once to the configured channel, with no way to ping anyone", async () => {
  seedGames(DUE_DAY.start + HOUR);
  seedGames(DUE_WEEK.start + 5 * HOUR);
  const { state, scheduler } = harness();
  await scheduler.runDue();
  assert.deepEqual(titles(state.sent), ["每日马报 · 2026-10-27 周二", "每周马报 · 2026-10-19 至 2026-10-25"]);
  for (const message of state.sent) {
    assert.equal(message.guildId, GUILD);
    assert.equal(message.channelId, CHANNEL);
    assert.deepEqual(message.payload.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  }
  const weekly = state.sent[1].payload.embeds![0].toJSON();
  assert.match(weekly.fields!.find((field) => field.name.includes("排行榜"))!.value, /<@alice>.*\n.*<@bob>/);

  // Running again, or restarting the whole scheduler, posts nothing more.
  await scheduler.runDue();
  const restarted = harness();
  await restarted.scheduler.runDue();
  assert.equal(state.sent.length, 2);
  assert.equal(restarted.state.sent.length, 0);
});

test("after a long outage only the latest missed day and the latest missed week are posted", async () => {
  // Three weeks of daily games, and the bot was last up before all of them.
  for (let day = 0; day < 21; day += 1) seedGames(DUE_DAY.start - day * 24 * HOUR + HOUR, 3);
  const { state, scheduler } = harness();
  await scheduler.runDue();
  assert.deepEqual(titles(state.sent), ["每日马报 · 2026-10-27 周二", "每周马报 · 2026-10-19 至 2026-10-25"]);
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start);
  assert.equal(getReportMark(GUILD, false, "week"), DUE_WEEK.start);
  // A later start finds nothing older to catch up on.
  const again = harness({ now: NOW + 3 * HOUR });
  await again.scheduler.runDue();
  assert.equal(again.state.sent.length, 0);
});

test("a period with no games is skipped silently and marked, and the next period still posts", async () => {
  const { state, scheduler } = harness();
  await scheduler.runDue();
  assert.deepEqual(state.sent, []);
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start);
  assert.equal(getReportMark(GUILD, false, "week"), DUE_WEEK.start);
  seedGames(DUE_DAY.end + HOUR);
  state.now = NOW + 24 * HOUR;
  await scheduler.runDue();
  assert.deepEqual(titles(state.sent), ["每日马报 · 2026-10-28 周三"]);
});

test("a report waits for the grace period so a game that just ended is not lost", async () => {
  seedGames(DUE_DAY.start + HOUR);
  const { state, scheduler } = harness({ now: DUE_DAY.end + REPORT_GRACE_MS - 1 });
  await scheduler.runDue();
  assert.deepEqual(reports(state.sent), [], "five minutes have not passed since midnight");
  state.now = DUE_DAY.end + REPORT_GRACE_MS;
  await scheduler.runDue();
  assert.equal(reports(state.sent).length, 1);
});

test("mock mode reports only labeled mock games and never uses up a real report", async () => {
  seedGames(DUE_DAY.start + HOUR, 3, { mock: true });
  const mock = harness({ mock: true });
  await mock.scheduler.runDue();
  assert.equal(mock.state.sent.length, 1);
  const embed = mock.state.sent[0].payload.embeds![0].toJSON();
  assert.match(embed.title!, /^模拟数据 · 每日马报/);
  assert.match(embed.footer!.text, /模拟数据/);

  // Real mode sees no real games for that day, so it posts nothing, and the mock rehearsal cannot have counted for it.
  const real = harness({ mock: false });
  await real.scheduler.runDue();
  assert.deepEqual(real.state.sent, []);
  assert.equal(getReportMark(GUILD, true, "day"), DUE_DAY.start);
});

test("a rehearsal's mock games never appear in a real report", async () => {
  seedGames(DUE_DAY.start + HOUR, 3, { mock: false });
  seedGames(DUE_DAY.start + 5 * HOUR, 4, { mock: true });
  const { state, scheduler } = harness({ mock: false });
  await scheduler.runDue();
  const embed = state.sent[0].payload.embeds![0].toJSON();
  assert.doesNotMatch(embed.title!, /模拟/);
  assert.match(embed.description!, /共 \*\*6\*\* 局/);
});

test("servers without a channel, or with a kind switched off, post only what is enabled", async () => {
  seedGames(DUE_DAY.start + HOUR);
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const { state, scheduler } = harness();
  await scheduler.runDue();
  assert.deepEqual(titles(state.sent), ["每周马报 · 2026-10-19 至 2026-10-25"]);
  setReportChannel(GUILD, null);
  const cleared = harness({ now: NOW + 7 * 24 * HOUR });
  await cleared.scheduler.runDue();
  assert.deepEqual(cleared.state.sent, []);
});

test("a permission failure gives up on that period once instead of retrying forever", async () => {
  seedGames(DUE_DAY.start + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness();
  state.failures.push(discordError(50013, "Missing Permissions"));
  await scheduler.runDue();
  assert.deepEqual(state.sent, []);
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start, "the period is closed");
  assert.ok(output.some((line) => line.includes("giving up") && line.includes("code 50013")));
  await scheduler.runDue();
  assert.deepEqual(state.sent, []);
});

test("a channel that is gone is a permanent failure too", async () => {
  seedGames(DUE_DAY.start + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness();
  state.failures.push(new ReportChannelError());
  await scheduler.runDue();
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start);
  assert.ok(output.some((line) => line.includes("giving up")));
});

test("a temporary failure is retried and then posted exactly once", async () => {
  seedGames(DUE_DAY.start + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness();
  state.failures.push(new Error("network down"));
  await scheduler.runDue();
  assert.equal(getReportMark(GUILD, false, "day"), undefined, "not marked, so the next check tries again");
  assert.ok(output.some((line) => line.includes("will retry")));
  await scheduler.runDue();
  assert.equal(state.sent.length, 1);
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start);
  await scheduler.runDue();
  assert.equal(state.sent.length, 1);
});

test("a failure that never goes away is dropped after a few attempts", async () => {
  seedGames(DUE_DAY.start + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness();
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS + 2; attempt += 1) state.failures.push(new Error("still down"));
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) await scheduler.runDue();
  assert.equal(getReportMark(GUILD, false, "day"), DUE_DAY.start);
  assert.deepEqual(state.sent, []);
});

test("one server failing does not stop the next server's report", async () => {
  setMemberAccounts("other-guild", "carol", [{ puuid: "puuid-carol", gameName: "Carol", tagLine: "NA1" }]);
  setMemberAccounts("other-guild", "dave", [{ puuid: "puuid-dave", gameName: "Dave", tagLine: "NA1" }]);
  setReportChannel("other-guild", "other-channel");
  seedGames(DUE_DAY.start + HOUR);
  recordTracked([
    game("carol", "特等马", 8, DUE_DAY.start + HOUR, { guildId: "other-guild", matchId: "NA1_OTHER1" }),
    game("dave", "没有马", 2, DUE_DAY.start + 2 * HOUR, { guildId: "other-guild", matchId: "NA1_OTHER2" }),
  ]);
  setReportKindEnabled(GUILD, "week", false);
  setReportKindEnabled("other-guild", "week", false);
  const { state, scheduler } = harness();
  state.failures.push(new ReportChannelError());
  await scheduler.runDue();
  // Servers run in ID order, so the failing send belongs to other-guild and scheduler-guild must still be served.
  assert.deepEqual(state.sent.map((message) => message.guildId), ["scheduler-guild"]);
});

test("the timer wakes at most a minute ahead and exactly at the next due time when that is closer", async () => {
  const { state, scheduler } = harness({ now: NOW });
  scheduler.start();
  await settle();
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].delay, REPORT_TICK_MS, "far from the next midnight it only ticks, so waking from sleep is noticed");
  await scheduler.stop();

  const close = harness({ now: utc("2026-10-29T06:59:30Z") });
  close.scheduler.start();
  await settle();
  // Midnight is 07:00:00Z and the report is due five minutes later, which is more than a tick away.
  assert.equal(close.state.timers[0].delay, REPORT_TICK_MS);
  await close.scheduler.stop();

  const nearDue = harness({ now: utc("2026-10-29T07:04:45Z") });
  nearDue.scheduler.start();
  await settle();
  assert.equal(nearDue.state.timers[0].delay, 15_000);
  await nearDue.scheduler.stop();
});

test("the scheduler posts the finished day when its timer fires after midnight", async () => {
  seedGames(DUE_DAY.end + HOUR);
  const nextDay = pacificDay(DUE_DAY.end + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness({ now: nextDay.end - 60_000 });
  markReportHandled(GUILD, false, "day", DUE_DAY.start, 1);
  scheduler.start();
  await settle();
  assert.deepEqual(state.sent, [], "the day has not ended yet");
  state.now = nextDay.end + REPORT_GRACE_MS;
  state.timers.at(-1)!.callback();
  await settle();
  assert.deepEqual(titles(state.sent), ["每日马报 · 2026-10-28 周三"]);
  assert.equal(state.timers.length, 2, "the scheduler arms a new timer after every check");
  await scheduler.stop();
});

test("the day daylight saving ends is reported whole, 25 hours long", async () => {
  const day = pacificDay(utc("2026-11-01T12:00:00Z"));
  assert.equal((day.end - day.start) / HOUR, 25);
  recordTracked([
    game("alice", "特等马", 9, day.start, { matchId: "NA1_DST_FIRST" }), // 00:00 PDT
    game("bob", "没有马", 1, day.end - 1, { matchId: "NA1_DST_LAST" }), // 23:59:59.999 PST, after the repeated hour
  ]);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness({ now: day.end + REPORT_GRACE_MS });
  await scheduler.runDue();
  const embed = state.sent[0].payload.embeds![0].toJSON();
  assert.equal(embed.title, "每日马报 · 2026-11-01 周日");
  assert.match(embed.description!, /共 \*\*2\*\* 局/);
});

test("the day daylight saving starts is reported whole, 23 hours long", async () => {
  const day = pacificDay(utc("2026-03-08T20:00:00Z"));
  assert.equal((day.end - day.start) / HOUR, 23);
  recordTracked([
    game("alice", "特等马", 9, day.start, { matchId: "NA1_SPRING_FIRST" }),
    game("bob", "没有马", 1, day.end - 1, { matchId: "NA1_SPRING_LAST" }),
    game("bob", "没有马", 1, day.end, { matchId: "NA1_SPRING_NEXT" }),
  ]);
  setReportKindEnabled(GUILD, "week", false);
  const { state, scheduler } = harness({ now: day.end + REPORT_GRACE_MS });
  await scheduler.runDue();
  assert.match(state.sent[0].payload.embeds![0].toJSON().description!, /共 \*\*2\*\* 局/);
  assert.equal(state.sent[0].payload.embeds![0].toJSON().title, "每日马报 · 2026-03-08 周日");
});

test("stopping cancels the timer, waits for work in progress and sends nothing afterwards", async () => {
  seedGames(DUE_DAY.start + HOUR);
  setReportKindEnabled(GUILD, "week", false);
  const { state, deps, scheduler } = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = deps.send;
  deps.send = async (...args) => { await gate; await send(...args); };
  scheduler.start();
  await settle();
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false, "stop waits for the report being sent");
  release();
  await stopping;
  assert.equal(state.sent.length, 1);
  assert.ok(state.timers.every((timer) => timer.cleared || timer.callback), "no timer is left armed");
  assert.equal(state.timers.length, 0, "a stopped scheduler never schedules again");
  scheduler.start();
  await settle();
  assert.equal(state.timers.length, 0, "and cannot be restarted");
});

test("the shutdown flag stops a run before the next server", async () => {
  seedGames(DUE_DAY.start + HOUR);
  const { state, scheduler } = harness();
  state.stopped = true;
  await scheduler.runDue();
  assert.deepEqual(state.sent, []);
});

function enableRoles(): FakeRoleGuild {
  const guild = new FakeRoleGuild();
  guild.id = GUILD;
  guild.addRole("role-top", TOP_ROLE_NAME, 3);
  guild.addRole("role-none", NONE_ROLE_NAME, 2);
  for (const user of ["alice", "bob", "carol"]) guild.addMember(user);
  setReportRoles(GUILD, { enabled: true, topRoleId: "role-top", noneRoleId: "role-none" });
  return guild;
}

test("the weekly report is followed by the role rotation, and the holders are remembered", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  guild.members.get("carol")!.add("role-top");
  const { state, scheduler } = harness();
  state.roleGuild = guild;
  setReportRoles(GUILD, { enabled: true, topRoleId: "role-top", noneRoleId: "role-none" });
  await scheduler.runDue();
  assert.equal(state.sent.length, 1, "no problem note when everything worked");
  assert.deepEqual(guild.changes, ["add:role-top:alice", "add:role-none:bob"]);
  const settings = getReportSettings(GUILD)!;
  assert.deepEqual([settings.topHolderIds, settings.noneHolderIds], [["alice"], ["bob"]]);
  assert.ok(guild.members.get("carol")!.has("role-top"), "a role the bot did not give is left alone");

  // The next week the champions swap and the old holders lose their roles.
  guild.changes.length = 0;
  const nextWeek = pacificWeek(DUE_WEEK.end + HOUR);
  recordTracked([
    ...[0, 1, 2].map((index) => game("bob", "特等马", 9.5, nextWeek.start + (index + 1) * HOUR, { matchId: `NA1_NEXT_B${index}` })),
    ...[0, 1, 2].map((index) => game("alice", "没有马", 0.5, nextWeek.start + (index + 5) * HOUR, { matchId: `NA1_NEXT_A${index}` })),
  ]);
  const later = harness({ now: nextWeek.end + REPORT_GRACE_MS });
  later.state.roleGuild = guild;
  await later.scheduler.runDue();
  assert.deepEqual(guild.changes, ["remove:role-top:alice", "add:role-top:bob", "remove:role-none:bob", "add:role-none:alice"]);
  assert.deepEqual([getReportSettings(GUILD)!.topHolderIds, getReportSettings(GUILD)!.noneHolderIds], [["bob"], ["alice"]]);
});

test("a weekly role failure is logged and reported once in the channel, and the report still counts as posted", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  guild.standing = { manageRoles: false, highestRolePosition: 10 };
  const { state, scheduler } = harness();
  state.roleGuild = guild;
  await scheduler.runDue();
  assert.equal(state.sent.length, 2);
  assert.ok(state.sent[0].payload.embeds, "the report goes out first");
  const note = state.sent[1].payload;
  assert.equal(note.embeds, undefined);
  assert.match(note.content!, /没有更新完整/);
  assert.match(note.content!, /Manage Roles/);
  assert.ok(!note.content!.includes("@everyone"));
  assert.deepEqual(note.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  assert.deepEqual(guild.changes, []);
  assert.equal(getReportMark(GUILD, false, "week"), DUE_WEEK.start);
  assert.ok(output.some((line) => line.includes("not fully updated")));
  // Running again does not repeat the note.
  await scheduler.runDue();
  assert.equal(state.sent.length, 2);
});

test("a role failure that cannot be told to the channel is still only logged", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  guild.failures.add = discordError(50013);
  const { state, deps, scheduler } = harness();
  state.roleGuild = guild;
  const send = deps.send;
  let calls = 0;
  deps.send = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("cannot post the note");
    await send(...args);
  };
  await scheduler.runDue();
  assert.equal(state.sent.length, 1);
  assert.ok(output.some((line) => line.includes("Could not tell server")));
});

test("a failed weekly post does not touch the roles", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  const { state, scheduler } = harness();
  state.roleGuild = guild;
  state.failures.push(new Error("network down"));
  await scheduler.runDue();
  assert.deepEqual(guild.changes, []);
  assert.equal(getReportMark(GUILD, false, "week"), undefined);
});

test("mock mode never changes who holds the weekly roles", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR, 3, { mock: true });
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  const { state, scheduler } = harness({ mock: true });
  state.roleGuild = guild;
  await scheduler.runDue();
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].payload.embeds![0].toJSON().title!, /^模拟数据/);
  assert.deepEqual(guild.changes, []);
});

test("a deleted weekly role is created again and the new id is saved", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  const guild = enableRoles();
  guild.roles.delete("role-none");
  const { state, scheduler } = harness();
  state.roleGuild = guild;
  await scheduler.runDue();
  assert.equal(getReportSettings(GUILD)!.noneRoleId, "created-1");
  assert.equal(getReportSettings(GUILD)!.topRoleId, "role-top");
  assert.deepEqual(getReportSettings(GUILD)!.noneHolderIds, ["bob"]);
});

test("when the bot has left the server the report is posted and roles are skipped", async () => {
  seedGames(DUE_WEEK.start + 5 * HOUR);
  setReportKindEnabled(GUILD, "day", false);
  enableRoles();
  const { state, scheduler } = harness();
  state.roleGuild = null;
  await scheduler.runDue();
  assert.equal(state.sent.length, 1);
  assert.ok(output.some((line) => line.includes("no longer in that server")));
});
