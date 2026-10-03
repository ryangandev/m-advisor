import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { clearBinding, getBinding, listBindings, setBinding } from "../src/store/bindingStore";
import {
  getAnnouncerState,
  getLastMatchId,
  resetAnnouncerRuntime,
  setActiveVoiceChannel,
  setLastMatchId,
  setPollingInterval,
  setVoiceStyle,
} from "../src/store/announcerStore";
import { closeDatabase, getDatabase, getDatabasePath } from "../src/store/database";

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

test("bindings persist in order, isolate guilds, and return independent values", () => {
  assert.equal(getBinding("first-guild"), undefined);
  setBinding("first-guild", { discordUserId: "first-user", accounts: [accountB, accountA] });
  setBinding("second-guild", { discordUserId: "second-user", accounts: [accountA] });
  const first = getBinding("first-guild")!;
  assert.deepEqual(first, { discordUserId: "first-user", accounts: [accountB, accountA] });
  first.accounts[0].gameName = "Changed outside the store";
  first.accounts.pop();
  assert.deepEqual(getBinding("first-guild")?.accounts, [accountB, accountA]);
  assert.deepEqual(listBindings(), [
    { guildId: "first-guild", binding: { discordUserId: "first-user", accounts: [accountB, accountA] } },
    { guildId: "second-guild", binding: { discordUserId: "second-user", accounts: [accountA] } },
  ]);
  closeDatabase();
  assert.deepEqual(getBinding("first-guild"), { discordUserId: "first-user", accounts: [accountB, accountA] });
  assert.equal(getDatabase().pragma("integrity_check", { simple: true }), "ok");
});

test("a failed account replacement rolls back both member and account changes", () => {
  const original = { discordUserId: "original-user", accounts: [accountA] };
  setBinding("rollback-guild", original);
  assert.throws(() => setBinding("rollback-guild", {
    discordUserId: "replacement-user",
    accounts: [accountB, { ...accountB, gameName: "Same PUUID" }],
  }), /UNIQUE constraint failed/);
  assert.deepEqual(getBinding("rollback-guild"), original);
  closeDatabase();
  assert.deepEqual(getBinding("rollback-guild"), original);
});

test("binding replacement and removal cascade account rows without removing other settings", () => {
  setBinding("remove-guild", { discordUserId: "old-user", accounts: [accountA, accountB] });
  setVoiceStyle("remove-guild", "sweet");
  setBinding("remove-guild", { discordUserId: "new-user", accounts: [accountB] });
  assert.deepEqual(getBinding("remove-guild"), { discordUserId: "new-user", accounts: [accountB] });
  clearBinding("remove-guild");
  clearBinding("remove-guild");
  assert.equal(getBinding("remove-guild"), undefined);
  const remainingAccounts = getDatabase().prepare("SELECT count(*) AS count FROM bound_accounts WHERE guild_id = ?").get("remove-guild") as { count: number };
  assert.equal(remainingAccounts.count, 0);
  assert.equal(getAnnouncerState("remove-guild").voiceStyle, "sweet");
});

test("fresh processes restore bindings and voice styles with empty monitoring state", () => {
  runSeparateProcess(`
    const binding = require('./src/store/bindingStore.ts');
    const announcer = require('./src/store/announcerStore.ts');
    binding.setBinding('restart-guild', { discordUserId: 'member-1', accounts: ${JSON.stringify([accountA, accountB])} });
    announcer.setVoiceStyle('restart-guild', 'sweet');
    announcer.setLastMatchId('restart-guild', 'account-a', 'NA1_historical');
    announcer.setActiveVoiceChannel('restart-guild', 'voice-channel-1');
    require('./src/store/database.ts').closeDatabase();
  `);
  const restored = JSON.parse(runSeparateProcess(`
    const binding = require('./src/store/bindingStore.ts');
    const announcer = require('./src/store/announcerStore.ts');
    const state = announcer.getAnnouncerState('restart-guild');
    console.log(JSON.stringify({
      binding: binding.getBinding('restart-guild'),
      style: state.voiceStyle,
      matchIds: [...state.lastMatchIds],
      voiceChannel: state.activeVoiceChannelId,
      pollingInterval: state.pollingInterval,
      otherStyle: announcer.getAnnouncerState('untouched-guild').voiceStyle,
    }));
    require('./src/store/database.ts').closeDatabase();
  `));
  assert.deepEqual(restored, {
    binding: { discordUserId: "member-1", accounts: [accountA, accountB] },
    style: "sweet",
    matchIds: [],
    voiceChannel: null,
    pollingInterval: null,
    otherStyle: "old",
  });
});

test("runtime reset clears timers and match baseline while retaining voice preference", async () => {
  const guildId = "runtime-reset-guild";
  setVoiceStyle(guildId, "sweet");
  setLastMatchId(guildId, "puuid", "NA1_match");
  setActiveVoiceChannel(guildId, "voice-channel");
  let pollingCalls = 0;
  const interval = setInterval(() => { pollingCalls += 1; }, 5);
  setPollingInterval(guildId, interval);
  resetAnnouncerRuntime(guildId);
  const state = getAnnouncerState(guildId);
  assert.equal(state.voiceStyle, "sweet");
  assert.equal(getLastMatchId(guildId, "puuid"), undefined);
  assert.equal(state.activeVoiceChannelId, null);
  assert.equal(state.pollingInterval, null);
  await delay(20);
  assert.equal(pollingCalls, 0);
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
  assert.throws(() => setBinding("", { discordUserId: "user", accounts: [accountA] }), /Guild ID/);
  assert.throws(() => setBinding("guild", { discordUserId: " ", accounts: [accountA] }), /Discord user ID/);
  assert.throws(() => setBinding("guild", { discordUserId: "user", accounts: [] }), /at least one/);
  assert.throws(() => setBinding("guild", { discordUserId: "user", accounts: [{ ...accountA, puuid: "" }] }), /PUUID/);
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
  setBinding("memory-guild", { discordUserId: "user", accounts: [accountA] });
  assert.deepEqual(getBinding("memory-guild")?.accounts, [accountA]);
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
  assert.throws(() => getBinding("any-guild"), /Could not open the bot database/);
  assert.deepEqual(readFileSync(process.env.DATABASE_PATH), original);
});
