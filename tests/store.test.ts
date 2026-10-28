import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import {
  AccountBoundToOtherMemberError,
  GuildAccountLimitError,
  MAX_ACCOUNTS_PER_GUILD,
  findAccountOwner,
  getTrackedMember,
  listAllTracking,
  listTrackedMembers,
  removeTrackedMember,
  setMemberAccounts,
} from "../src/store/bindingStore";
import {
  getAnnouncerState,
  getLastMatchId,
  resetAnnouncerRuntime,
  clearLastMatchIds,
  setLastMatchId,
  setPollingInterval,
  setVoiceStyle,
} from "../src/store/announcerStore";
import { SCHEMA_VERSION, closeDatabase, getDatabase, getDatabasePath } from "../src/store/database";
import { closeAppeal } from "../src/store/appealStore";
import { countMemberHorseRecords, eraseMemberHorseRecords } from "../src/store/horseRecordStore";
import { recordRankResults } from "../src/store/rankStore";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";
import { backupLine, captureConsole } from "./helpers/captureConsole";

let temporaryDirectory: string;
let savedDatabasePath: string | undefined;
let savedDataDirectory: string | undefined;

const accountA = { puuid: "account-a", gameName: "玩家 A", tagLine: "NA1" };
const accountB = { puuid: "account-b", gameName: "Player B", tagLine: "NA2" };

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  savedDataDirectory = process.env.BOT_DATA_DIR;
  temporaryDirectory = mkdtempSync(join(tmpdir(), "m-advisor-store-"));
  process.env.DATABASE_PATH = join(temporaryDirectory, "private", "bot.sqlite3");
  delete process.env.BOT_DATA_DIR;
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  if (savedDataDirectory === undefined) delete process.env.BOT_DATA_DIR;
  else process.env.BOT_DATA_DIR = savedDataDirectory;
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function runSeparateProcess(source: string): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("store module imports do not create a database", () => {
  runSeparateProcess(`
    require('./src/store/bindingStore.ts');
    require('./src/store/announcerStore.ts');
    require('./src/store/database.ts');
  `);
  assert.equal(existsSync(process.env.DATABASE_PATH!), false);
  assert.equal(existsSync(join(temporaryDirectory, "private")), false);
});

test("members and accounts persist in order, isolate guilds, and return independent values", () => {
  assert.deepEqual(listTrackedMembers("first-guild"), []);
  setMemberAccounts("first-guild", "first-user", [accountB, accountA]);
  setMemberAccounts("second-guild", "second-user", [accountA]);
  const [first] = listTrackedMembers("first-guild");
  assert.deepEqual(first, { discordUserId: "first-user", accounts: [accountB, accountA] });
  first.accounts[0].gameName = "Changed outside the store";
  first.accounts.pop();
  assert.deepEqual(getTrackedMember("first-guild", "first-user")?.accounts, [accountB, accountA]);
  assert.deepEqual(listAllTracking(), [
    { guildId: "first-guild", members: [{ discordUserId: "first-user", accounts: [accountB, accountA] }] },
    { guildId: "second-guild", members: [{ discordUserId: "second-user", accounts: [accountA] }] },
  ]);
  closeDatabase();
  assert.deepEqual(listTrackedMembers("first-guild"), [{ discordUserId: "first-user", accounts: [accountB, accountA] }]);
  assert.equal(getDatabase().pragma("integrity_check", { simple: true }), "ok");
});

test("several members keep bind order, and re-saving a member keeps their place", () => {
  const accountC = { puuid: "account-c", gameName: "Player C", tagLine: "NA3" };
  setMemberAccounts("team-guild", "zed", [accountA]);
  setMemberAccounts("team-guild", "amy", [accountB, accountC]);
  setMemberAccounts("other-guild", "solo", [accountA]);
  setMemberAccounts("team-guild", "zed", [accountA, { puuid: "account-d", gameName: "Player D", tagLine: "NA4" }]);
  assert.deepEqual(listTrackedMembers("team-guild").map((member) => member.discordUserId), ["zed", "amy"]);
  assert.deepEqual(getTrackedMember("team-guild", "amy")?.accounts, [accountB, accountC]);
  assert.deepEqual(getTrackedMember("team-guild", "zed")?.accounts.map((account) => account.puuid), ["account-a", "account-d"]);
  assert.equal(getTrackedMember("team-guild", "solo"), undefined);
  assert.deepEqual(listTrackedMembers("other-guild").map((member) => member.discordUserId), ["solo"]);
  assert.equal(findAccountOwner("team-guild", "account-c"), "amy");
  assert.equal(findAccountOwner("team-guild", "missing"), undefined);
  // The same Riot account is independent across guilds.
  assert.equal(findAccountOwner("other-guild", "account-a"), "solo");
  assert.deepEqual(listAllTracking().map((guild) => guild.guildId), ["other-guild", "team-guild"]);
  closeDatabase();
  assert.deepEqual(listTrackedMembers("team-guild").map((member) => member.discordUserId), ["zed", "amy"]);
});

test("a member added after others is bound last even when an earlier member was removed", () => {
  setMemberAccounts("gap-guild", "one", [accountA]);
  setMemberAccounts("gap-guild", "two", [accountB]);
  assert.equal(removeTrackedMember("gap-guild", "one"), true);
  setMemberAccounts("gap-guild", "three", [accountA]);
  assert.deepEqual(listTrackedMembers("gap-guild").map((member) => member.discordUserId), ["two", "three"]);
});

test("an account owned by another member is rejected and rolls back everything", () => {
  setMemberAccounts("owner-guild", "owner", [accountA]);
  setMemberAccounts("owner-guild", "other", [accountB]);
  assert.throws(
    () => setMemberAccounts("owner-guild", "other", [accountB, { puuid: "account-new", gameName: "New", tagLine: "NA9" }, accountA]),
    (error: unknown) => error instanceof AccountBoundToOtherMemberError && error.puuid === "account-a" && error.ownerId === "owner",
  );
  assert.throws(() => setMemberAccounts("owner-guild", "newcomer", [accountA]), AccountBoundToOtherMemberError);
  assert.deepEqual(listTrackedMembers("owner-guild"), [
    { discordUserId: "owner", accounts: [accountA] },
    { discordUserId: "other", accounts: [accountB] },
  ]);
  assert.equal(getTrackedMember("owner-guild", "newcomer"), undefined);
  assert.equal(findAccountOwner("owner-guild", "account-new"), undefined);
});

test("a failed account replacement rolls back both member and account changes", () => {
  setMemberAccounts("rollback-guild", "original-user", [accountA]);
  const before = listTrackedMembers("rollback-guild");
  assert.throws(() => setMemberAccounts("rollback-guild", "original-user", [
    accountB,
    { ...accountB, gameName: "Same PUUID" },
  ]), /UNIQUE constraint failed/);
  assert.throws(() => setMemberAccounts("rollback-guild", "brand-new", [
    accountB,
    { ...accountB, gameName: "Same PUUID" },
  ]), /UNIQUE constraint failed/);
  assert.deepEqual(listTrackedMembers("rollback-guild"), before);
  closeDatabase();
  assert.deepEqual(listTrackedMembers("rollback-guild"), before);
});

test("a guild can track at most ten accounts in total, counting every member", () => {
  const accounts = Array.from({ length: MAX_ACCOUNTS_PER_GUILD + 1 }, (_, index) => ({ puuid: `cap-${index}`, gameName: `Cap ${index}`, tagLine: "NA1" }));
  setMemberAccounts("cap-guild", "first", accounts.slice(0, 6));
  setMemberAccounts("cap-guild", "second", accounts.slice(6, 10));
  assert.equal(MAX_ACCOUNTS_PER_GUILD, 10);
  assert.throws(() => setMemberAccounts("cap-guild", "second", accounts.slice(6)), GuildAccountLimitError);
  assert.throws(() => setMemberAccounts("cap-guild", "third", [accounts[10]]), GuildAccountLimitError);
  assert.equal(getTrackedMember("cap-guild", "third"), undefined);
  assert.equal(getTrackedMember("cap-guild", "second")?.accounts.length, 4);
  // Replacing a member's own accounts does not count the old ones twice, and other guilds have their own budget.
  setMemberAccounts("cap-guild", "second", accounts.slice(6, 10).reverse());
  setMemberAccounts("cap-guild", "first", accounts.slice(0, 6).reverse());
  setMemberAccounts("another-guild", "solo", accounts.slice(0, 10));
  assert.equal(getTrackedMember("another-guild", "solo")?.accounts.length, 10);
});

test("removing a member cascades only their accounts and keeps the voice preference", () => {
  setMemberAccounts("remove-guild", "old-user", [accountA, accountB]);
  setMemberAccounts("remove-guild", "kept-user", [{ puuid: "account-kept", gameName: "Kept", tagLine: "NA1" }]);
  setVoiceStyle("remove-guild", "sweet");
  assert.equal(removeTrackedMember("remove-guild", "old-user"), true);
  assert.equal(removeTrackedMember("remove-guild", "old-user"), false);
  assert.equal(getTrackedMember("remove-guild", "old-user"), undefined);
  assert.deepEqual(listTrackedMembers("remove-guild").map((member) => member.discordUserId), ["kept-user"]);
  const accountCounts = getDatabase().prepare("SELECT discord_user_id, count(*) AS count FROM member_accounts WHERE guild_id = ? GROUP BY discord_user_id").all("remove-guild");
  assert.deepEqual(accountCounts, [{ discord_user_id: "kept-user", count: 1 }]);
  assert.equal(removeTrackedMember("remove-guild", "kept-user"), true);
  assert.deepEqual(listTrackedMembers("remove-guild"), []);
  assert.deepEqual(listAllTracking(), []);
  assert.equal(getAnnouncerState("remove-guild").voiceStyle, "sweet");
  // The freed account can be bound again by a different member.
  setMemberAccounts("remove-guild", "new-user", [accountA]);
  assert.equal(findAccountOwner("remove-guild", "account-a"), "new-user");
});

test("fresh processes restore members and voice styles with empty monitoring state", () => {
  runSeparateProcess(`
    const binding = require('./src/store/bindingStore.ts');
    const announcer = require('./src/store/announcerStore.ts');
    binding.setMemberAccounts('restart-guild', 'member-1', ${JSON.stringify([accountA, accountB])});
    announcer.setVoiceStyle('restart-guild', 'sweet');
    announcer.setLastMatchId('restart-guild', 'account-a', 'NA1_historical');
    require('./src/store/database.ts').closeDatabase();
  `);
  const restored = JSON.parse(runSeparateProcess(`
    const binding = require('./src/store/bindingStore.ts');
    const announcer = require('./src/store/announcerStore.ts');
    const state = announcer.getAnnouncerState('restart-guild');
    console.log(JSON.stringify({
      members: binding.listTrackedMembers('restart-guild'),
      style: state.voiceStyle,
      matchIds: [...state.lastMatchIds],
      pollingInterval: state.pollingInterval,
      otherStyle: announcer.getAnnouncerState('untouched-guild').voiceStyle,
    }));
    require('./src/store/database.ts').closeDatabase();
  `));
  assert.deepEqual(restored, {
    members: [{ discordUserId: "member-1", accounts: [accountA, accountB] }],
    style: "sweet",
    matchIds: [],
    pollingInterval: null,
    otherStyle: "old",
  });
});

test("runtime reset clears timers and match baseline while retaining voice preference", async () => {
  const guildId = "runtime-reset-guild";
  setVoiceStyle(guildId, "sweet");
  setLastMatchId(guildId, "puuid", "NA1_match");
  let pollingCalls = 0;
  const interval = setInterval(() => { pollingCalls += 1; }, 5);
  setPollingInterval(guildId, interval);
  resetAnnouncerRuntime(guildId);
  const state = getAnnouncerState(guildId);
  assert.equal(state.voiceStyle, "sweet");
  assert.equal(getLastMatchId(guildId, "puuid"), undefined);
  assert.equal(state.pollingInterval, null);
  await delay(20);
  assert.equal(pollingCalls, 0);
});

test("clearing named baselines keeps every other account's baseline", () => {
  const guildId = "partial-clear-guild";
  setLastMatchId(guildId, "leaving", "NA1_left");
  setLastMatchId(guildId, "staying", "NA1_stay");
  clearLastMatchIds(guildId, ["leaving", "never-set"]);
  assert.equal(getLastMatchId(guildId, "leaving"), undefined);
  assert.equal(getLastMatchId(guildId, "staying"), "NA1_stay");
});

test("a failed preference write does not update the runtime voice style", () => {
  const guildId = "failed-preference-guild";
  setVoiceStyle(guildId, "sweet");
  getDatabase().pragma("query_only = ON");
  assert.throws(() => setVoiceStyle(guildId, "old"), /readonly/);
  assert.equal(getAnnouncerState(guildId).voiceStyle, "sweet");
  getDatabase().pragma("query_only = OFF");
  assert.deepEqual(getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId), { voice_style: "sweet" });
});

test("invalid store inputs fail before creating a database", () => {
  assert.throws(() => setMemberAccounts("", "user", [accountA]), /Guild ID/);
  assert.throws(() => setMemberAccounts("guild", " ", [accountA]), /Discord user ID/);
  assert.throws(() => setMemberAccounts("guild", "user", []), /at least one/);
  assert.throws(() => setMemberAccounts("guild", "user", [{ ...accountA, puuid: "" }]), /PUUID/);
  assert.throws(() => removeTrackedMember(" ", "user"), /Guild ID/);
  assert.throws(() => findAccountOwner("guild", ""), /PUUID/);
  assert.throws(() => setVoiceStyle("guild", "unknown" as "sweet"), /Voice style/);
  assert.throws(() => getAnnouncerState(" "), /Guild ID/);
  assert.equal(existsSync(process.env.DATABASE_PATH!), false);
});

test("path precedence and defaults are explicit", () => {
  process.env.DATABASE_PATH = "relative-test.sqlite3";
  process.env.BOT_DATA_DIR = "ignored-data";
  assert.equal(getDatabasePath(), resolve("relative-test.sqlite3"));
  delete process.env.DATABASE_PATH;
  assert.equal(getDatabasePath(), resolve("ignored-data", "bot.sqlite3"));
  delete process.env.BOT_DATA_DIR;
  assert.equal(getDatabasePath(), resolve(".data", "bot.sqlite3"));
  process.env.DATABASE_PATH = ":memory:";
  assert.equal(getDatabasePath(), ":memory:");
  setMemberAccounts("memory-guild", "user", [accountA]);
  assert.deepEqual(getTrackedMember("memory-guild", "user")?.accounts, [accountA]);
});

test("database uses foreign keys, WAL, full durability, and private filesystem permissions", () => {
  const db = getDatabase();
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5_000);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("synchronous", { simple: true }), 2);
  if (process.platform !== "win32") {
    assert.equal(statSync(process.env.DATABASE_PATH!).mode & 0o777, 0o600);
    assert.equal(statSync(join(temporaryDirectory, "private")).mode & 0o777, 0o700);
  }
});

// The schema exactly as version 1 of the bot created it.
const SCHEMA_V1 = `
  CREATE TABLE guild_bindings (
    guild_id TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL CHECK(length(trim(discord_user_id)) > 0)
  ) STRICT;
  CREATE TABLE bound_accounts (
    guild_id TEXT NOT NULL REFERENCES guild_bindings(guild_id) ON DELETE CASCADE,
    puuid TEXT NOT NULL CHECK(length(trim(puuid)) > 0),
    game_name TEXT NOT NULL CHECK(length(trim(game_name)) > 0),
    tag_line TEXT NOT NULL CHECK(length(trim(tag_line)) > 0),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY (guild_id, puuid),
    UNIQUE (guild_id, position)
  ) STRICT;
  CREATE TABLE guild_preferences (
    guild_id TEXT PRIMARY KEY,
    voice_style TEXT NOT NULL CHECK(voice_style IN ('sweet', 'old'))
  ) STRICT;
  PRAGMA user_version = 1;
`;

/**
 * Writes the way a running v1 bot leaves its file: WAL journal mode, and a process that exits without
 * closing the connection, so the rows sit in an uncheckpointed -wal file next to the main file.
 */
function writeVersionOneDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec(${JSON.stringify(SCHEMA_V1)});
    db.exec(${JSON.stringify(`
      INSERT INTO guild_bindings VALUES ('guild-one', 'member-one'), ('guild-two', 'member-two');
      INSERT INTO bound_accounts VALUES
        ('guild-one', 'account-b', 'Player B', 'NA2', 0),
        ('guild-one', 'account-a', '玩家 A', 'NA1', 1),
        ('guild-two', 'account-a', '玩家 A', 'NA1', 0);
      INSERT INTO guild_preferences VALUES ('guild-one', 'sweet'), ('guild-two', 'old');
    `)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

function lastLine(output: string): string {
  return output.split("\n").at(-1)!;
}

function backupFiles(filePath: string): string[] {
  const prefix = `${basename(filePath)}.v`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
}

test("a version 1 database upgrades in place when a separate process opens it", () => {
  const filePath = join(temporaryDirectory, "v1.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionOneDatabase(filePath);
  if (process.platform !== "win32") chmodSync(filePath, 0o644);

  const migrated = JSON.parse(lastLine(runSeparateProcess(`
    const binding = require('./src/store/bindingStore.ts');
    const announcer = require('./src/store/announcerStore.ts');
    const database = require('./src/store/database.ts');
    const tracking = binding.listAllTracking();
    const db = database.getDatabase();
    console.log(JSON.stringify({
      tracking,
      styles: ['guild-one', 'guild-two'].map((guild) => announcer.getAnnouncerState(guild).voiceStyle),
      version: db.pragma('user_version', { simple: true }),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      rankIndexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rank_results' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
    }));
    database.closeDatabase();
  `)));
  assert.deepEqual(migrated, {
    tracking: [
      { guildId: "guild-one", members: [{ discordUserId: "member-one", accounts: [accountB, accountA] }] },
      { guildId: "guild-two", members: [{ discordUserId: "member-two", accounts: [accountA] }] },
    ],
    styles: ["sweet", "old"],
    version: SCHEMA_VERSION,
    tables: ["appeal_cases", "guild_preferences", "horse_records", "member_accounts", "pregame_settings", "rank_results", "report_marks", "report_settings", "tracked_members"],
    rankIndexes: ["rank_results_by_member", "rank_results_by_time"],
  });
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(backupFiles(filePath), ["v1.sqlite3.v1.bak"]);

  // The upgraded file behaves like any current file: another member can join the first guild.
  setMemberAccounts("guild-one", "member-three", [{ puuid: "account-c", gameName: "Player C", tagLine: "NA3" }]);
  assert.deepEqual(listTrackedMembers("guild-one").map((member) => member.discordUserId), ["member-one", "member-three"]);
});

test("upgrading writes a private consistent backup first and a second open adds none", (t) => {
  const log = captureConsole(t);
  const filePath = join(temporaryDirectory, "v1-backup.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionOneDatabase(filePath);
  // Rows that exist only in the uncheckpointed -wal must be in the backup.
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const backupPath = `${filePath}.v1.bak`;
  assert.deepEqual(backupFiles(filePath), ["v1-backup.sqlite3.v1.bak"]);
  assert.equal(log.lines.filter((line) => backupLine(1, filePath).test(line)).length, 1, "the backup is announced once");
  if (process.platform !== "win32") assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  const backup = new Database(backupPath, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(backup.prepare("SELECT guild_id, discord_user_id FROM guild_bindings ORDER BY guild_id").all(), [
      { guild_id: "guild-one", discord_user_id: "member-one" },
      { guild_id: "guild-two", discord_user_id: "member-two" },
    ]);
    assert.deepEqual(backup.prepare("SELECT puuid FROM bound_accounts WHERE guild_id = 'guild-one' ORDER BY position").all(), [
      { puuid: "account-b" },
      { puuid: "account-a" },
    ]);
    assert.deepEqual(backup.prepare("SELECT voice_style FROM guild_preferences ORDER BY guild_id").all(), [
      { voice_style: "sweet" },
      { voice_style: "old" },
    ]);
  } finally {
    backup.close();
  }
  closeDatabase();
  getDatabase();
  closeDatabase();
  assert.deepEqual(backupFiles(filePath), ["v1-backup.sqlite3.v1.bak"]);
  assert.equal(log.lines.length, 1, "the second open logs nothing more");
});

test("a fresh database and an in-memory database are not backed up", () => {
  const filePath = process.env.DATABASE_PATH!;
  getDatabase();
  closeDatabase();
  assert.deepEqual(backupFiles(filePath), []);
  process.env.DATABASE_PATH = ":memory:";
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(backupFiles(filePath), []);
});

test("an existing backup is never overwritten", (t) => {
  const log = captureConsole(t);
  const filePath = join(temporaryDirectory, "v1-existing.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionOneDatabase(filePath);
  writeFileSync(`${filePath}.v1.bak`, "older backup, keep me");
  getDatabase();
  assert.equal(readFileSync(`${filePath}.v1.bak`, "utf8"), "older backup, keep me");
  assert.deepEqual(backupFiles(filePath), ["v1-existing.sqlite3.v1.2.bak", "v1-existing.sqlite3.v1.bak"]);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /Backed up the version 1 database to .*v1-existing\.sqlite3\.v1\.2\.bak before upgrading it\./);
  const backup = new Database(`${filePath}.v1.2.bak`, { readonly: true });
  try {
    assert.equal((backup.prepare("SELECT count(*) AS count FROM bound_accounts").get() as { count: number }).count, 3);
  } finally {
    backup.close();
  }
});

test("two processes opening the same version 1 file at once both succeed and migrate once", async () => {
  const filePath = join(temporaryDirectory, "v1-concurrent.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionOneDatabase(filePath);
  const startAt = Date.now() + 1500;
  const source = `
    const binding = require('./src/store/bindingStore.ts');
    const database = require('./src/store/database.ts');
    while (Date.now() < ${startAt}) { /* open at the same moment as the other process */ }
    const db = database.getDatabase();
    console.log(JSON.stringify({
      version: db.pragma('user_version', { simple: true }),
      members: binding.listAllTracking().flatMap((guild) => guild.members.map((member) => member.discordUserId)),
    }));
    database.closeDatabase();
  `;
  const runs = await Promise.all([0, 1].map(() => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], { cwd: resolve(__dirname, ".."), env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  })));
  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    const lastLine = run.stdout.trim().split("\n").at(-1)!;
    assert.deepEqual(JSON.parse(lastLine), { version: SCHEMA_VERSION, members: ["member-one", "member-two"] });
  }
  assert.equal(getDatabase().pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(listAllTracking().map((guild) => guild.members.length), [1, 1]);
});

test("a failed migration rolls back completely and leaves the version 1 database intact", (t) => {
  const log = captureConsole(t);
  const filePath = join(temporaryDirectory, "v1-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  // A stray table with the new name makes the second migration step fail midway.
  writeVersionOneDatabase(filePath, "CREATE TABLE tracked_members (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*tracked_members/);
  assert.deepEqual(backupFiles(filePath), ["v1-conflict.sqlite3.v1.bak"]);
  assert.equal(log.lines.filter((line) => backupLine(1, filePath).test(line)).length, 1, "the backup is announced once");

  const verifyDb = new Database(filePath, { readonly: true });
  try {
    assert.equal(verifyDb.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(
      verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      [{ name: "bound_accounts" }, { name: "guild_bindings" }, { name: "guild_preferences" }, { name: "tracked_members" }],
    );
    assert.deepEqual(verifyDb.prepare("SELECT guild_id, discord_user_id FROM guild_bindings ORDER BY guild_id").all(), [
      { guild_id: "guild-one", discord_user_id: "member-one" },
      { guild_id: "guild-two", discord_user_id: "member-two" },
    ]);
    assert.equal((verifyDb.prepare("SELECT count(*) AS count FROM bound_accounts").get() as { count: number }).count, 3);
    assert.equal((verifyDb.prepare("SELECT count(*) AS count FROM tracked_members").get() as { count: number }).count, 0);
  } finally {
    verifyDb.close();
  }
});

test("reopening a current-version database changes nothing", () => {
  setMemberAccounts("stable-guild", "member", [accountA, accountB]);
  setVoiceStyle("stable-guild", "sweet");
  const schemaBefore = getDatabase().prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  closeDatabase();
  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(getDatabase().prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), schemaBefore);
  assert.deepEqual(listTrackedMembers("stable-guild"), [{ discordUserId: "member", accounts: [accountA, accountB] }]);
  assert.equal(getAnnouncerState("stable-guild").voiceStyle, "sweet");
});

test("a database from a newer bot is rejected without replacing its contents", () => {
  process.env.DATABASE_PATH = join(temporaryDirectory, "future.sqlite3");
  const futureDb = new Database(process.env.DATABASE_PATH);
  futureDb.exec("CREATE TABLE future_marker (value TEXT); INSERT INTO future_marker VALUES ('keep-me'); PRAGMA user_version = 99;");
  futureDb.close();
  assert.throws(() => getDatabase(), /schema 99 is newer/);
  const verifyDb = new Database(process.env.DATABASE_PATH, { readonly: true });
  try {
    assert.equal(verifyDb.pragma("user_version", { simple: true }), 99);
    assert.deepEqual(verifyDb.prepare("SELECT value FROM future_marker").get(), { value: "keep-me" });
  } finally {
    verifyDb.close();
  }
});

test("corrupt databases fail visibly and are never silently replaced", () => {
  process.env.DATABASE_PATH = join(temporaryDirectory, "corrupt.sqlite3");
  const original = Buffer.from("this is not a SQLite database");
  writeFileSync(process.env.DATABASE_PATH, original);
  assert.throws(() => listTrackedMembers("any-guild"), /Could not open the bot database/);
  assert.deepEqual(readFileSync(process.env.DATABASE_PATH), original);
});

const MARKER = "NA1_ERASED_MARKER_8f3a1c";

/** 20 horse records, LP results and appeal cases for one member, all carrying the marker in their match IDs. */
function storeMarkedRows(): void {
  const rankResult = {
    guildId: "guild-one", discordUserId: "member-one", mock: false, puuid: "account-a", queueType: "solo" as const,
    recordedAt: 1_800_000_060_000, kind: "change" as const, tier: "GOLD", division: "II", leaguePoints: 86,
    lpDelta: 22, beforeTier: "GOLD", beforeDivision: "II", beforeLeaguePoints: 64,
  };
  recordTracked(Array.from({ length: 20 }, (_, index) => makeHorseRecord({ matchId: `${MARKER}_H${index}` })));
  recordRankResults(Array.from({ length: 20 }, (_, index) => ({ ...rankResult, matchId: `${MARKER}_R${index}`, playedAt: 1_800_000_000_000 + index })));
  for (let index = 0; index < 20; index += 1) closeAppeal({ guildId: "guild-one", discordUserId: "member-one", matchId: `${MARKER}_A${index}`, mock: false });
}

const fileText = (suffix: string): string => {
  const file = `${process.env.DATABASE_PATH}${suffix}`;
  return existsSync(file) ? readFileSync(file).toString("latin1") : "";
};

test("an erase leaves no trace of freshly stored rows in the database file or its WAL", () => {
  storeMarkedRows();
  assert.ok((fileText("") + fileText("-wal")).includes(MARKER), "the marker is stored before the erase");

  assert.equal(getDatabase().pragma("secure_delete", { simple: true }), 1);
  assert.equal(eraseMemberHorseRecords("guild-one", "member-one"), 20);
  assert.equal((fileText("") + fileText("-wal")).includes(MARKER), false, "erased rows must not stay readable in free pages or the WAL");
  assert.equal(statSync(`${process.env.DATABASE_PATH}-wal`).size, 0, "the WAL is truncated after the erase");
});

test("an erase also scrubs rows that were already checkpointed into the main file", () => {
  storeMarkedRows();
  closeDatabase();
  assert.ok(fileText("").includes(MARKER), "after the checkpoint at close, the marker is in the main file");

  assert.equal(eraseMemberHorseRecords("guild-one", "member-one"), 20);
  assert.equal(fileText("").includes(MARKER), false, "the main file no longer holds the erased rows");
  assert.equal(fileText("-wal").includes(MARKER), false, "neither does the WAL");
});

test("an erase does not wait for another connection that is reading, and still commits", (t) => {
  const log = captureConsole(t);
  storeMarkedRows();
  const reader = new Database(process.env.DATABASE_PATH!);
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM horse_records").get();

    const started = performance.now();
    assert.equal(eraseMemberHorseRecords("guild-one", "member-one"), 20);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `the erase took ${Math.round(elapsed)} ms with a reader open`);
    assert.deepEqual(countMemberHorseRecords("guild-one", "member-one"), { real: 0, mock: 0 });
    assert.equal(getDatabase().pragma("busy_timeout", { simple: true }), 5000, "the normal timeout is restored");
    assert.equal(log.lines.filter((line) => line.includes("another process is reading the database")).length, 1, "the skipped WAL truncation is warned about");
    reader.exec("COMMIT");
  } finally {
    reader.close();
  }
  // Once the reader is gone, the shutdown checkpoint clears what the busy one could not.
  closeDatabase();
  assert.equal(fileText("-wal").includes(MARKER), false);
  assert.equal(fileText("").includes(MARKER), false);
});
