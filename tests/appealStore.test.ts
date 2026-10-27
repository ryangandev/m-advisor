import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { APPEAL_RETENTION_MS, closeAppeal, eraseMemberAppeals, isAppealClosed, reopenAppeal } from "../src/store/appealStore";
import type { AppealCase } from "../src/store/appealStore";
import { listTrackedMembers } from "../src/store/bindingStore";
import { SCHEMA_VERSION, closeDatabase, getDatabase } from "../src/store/database";
import { eraseMemberHorseRecords } from "../src/store/horseRecordStore";
import { getPregameVoiceEnabled } from "../src/store/announcerStore";
import { ROWS_V5, SCHEMA_V5 } from "./helpers/schemaV5";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";

let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  closeDatabase();
  savedDatabasePath = process.env.DATABASE_PATH;
  directory = mkdtempSync(join(tmpdir(), "m-advisor-appeal-"));
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

function runSeparateProcess(source: string): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function backupFiles(filePath: string): string[] {
  const prefix = `${basename(filePath)}.v`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();
}

function writeVersionFiveDatabase(filePath: string, extraSql = ""): void {
  runSeparateProcess(`
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(filePath)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('foreign_keys = ON');
    db.exec(${JSON.stringify(SCHEMA_V5)});
    db.exec(${JSON.stringify(ROWS_V5)});
    if (${JSON.stringify(extraSql)}) db.exec(${JSON.stringify(extraSql)});
    process.exit(0);
  `);
  assert.ok(existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0, "the fixture must leave an uncheckpointed WAL");
}

const CASE: AppealCase = { guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100", mock: false };

test("a version 5 database upgrades to version 6 in a separate process with a backup and its data intact", () => {
  const filePath = join(directory, "v5.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionFiveDatabase(filePath);

  // A different process performs the upgrade and records a case; this one only inspects the result.
  const output = runSeparateProcess(`
    const { getDatabase, closeDatabase } = require(${JSON.stringify(resolve(__dirname, "../src/store/database.ts"))});
    const { closeAppeal } = require(${JSON.stringify(resolve(__dirname, "../src/store/appealStore.ts"))});
    process.stdout.write(String(getDatabase().pragma('user_version', { simple: true })));
    closeAppeal(${JSON.stringify(CASE)});
    closeDatabase();
  `);
  assert.equal(output.trim().split("\n").pop(), String(SCHEMA_VERSION));

  assert.equal(getDatabase().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(isAppealClosed(CASE), true, "the case written by the other process is here");
  assert.deepEqual(listTrackedMembers("guild-one").map((member) => member.discordUserId), ["laowang"]);
  assert.equal(getPregameVoiceEnabled("guild-one"), false);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  assert.deepEqual(backupFiles(filePath), ["v5.sqlite3.v5.bak"]);
  const backup = new Database(`${filePath}.v5.bak`, { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'appeal_cases'").all(), []);
    assert.equal((backup.prepare("SELECT count(*) AS count FROM pregame_settings").get() as { count: number }).count, 1);
  } finally {
    backup.close();
  }
});

test("a failed version 6 step rolls back and leaves the version 5 database intact", () => {
  const filePath = join(directory, "v5-conflict.sqlite3");
  process.env.DATABASE_PATH = filePath;
  writeVersionFiveDatabase(filePath, "CREATE TABLE appeal_cases (stray TEXT);");
  assert.throws(() => getDatabase(), /Could not open the bot database.*appeal_cases/);
  assert.deepEqual(backupFiles(filePath), ["v5-conflict.sqlite3.v5.bak"]);

  const verify = new Database(filePath, { readonly: true });
  try {
    assert.equal(verify.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(verify.prepare("SELECT discord_user_id FROM tracked_members").all(), [{ discord_user_id: "laowang" }]);
    assert.deepEqual(verify.prepare("SELECT name FROM pragma_table_info('appeal_cases')").all(), [{ name: "stray" }]);
    assert.deepEqual(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'appeal_cases_by_time'").all(), [], "the index of the failed step is gone");
  } finally {
    verify.close();
  }
});

test("a closed case survives closing and reopening the database, also across processes", () => {
  assert.equal(isAppealClosed(CASE), false);
  assert.equal(closeAppeal(CASE), true);
  assert.equal(closeAppeal(CASE), false, "closing twice is reported, so a double click is heard once");
  closeDatabase();
  assert.equal(isAppealClosed(CASE), true);

  const output = runSeparateProcess(`
    const { isAppealClosed } = require(${JSON.stringify(resolve(__dirname, "../src/store/appealStore.ts"))});
    process.stdout.write(String(isAppealClosed(${JSON.stringify(CASE)})));
  `);
  assert.equal(output, "true");
});

test("cases are separate per server, member, match and mock flag", () => {
  closeAppeal(CASE);
  assert.equal(isAppealClosed({ ...CASE, mock: true }), false);
  assert.equal(isAppealClosed({ ...CASE, guildId: "guild-two" }), false);
  assert.equal(isAppealClosed({ ...CASE, discordUserId: "other" }), false);
  assert.equal(isAppealClosed({ ...CASE, matchId: "NA1_101" }), false);
  assert.equal(closeAppeal({ ...CASE, mock: true }), true);
});

test("a reopened case can be closed again, and reopening an open case is harmless", () => {
  closeAppeal(CASE);
  assert.equal(reopenAppeal(CASE), true);
  assert.equal(isAppealClosed(CASE), false);
  assert.equal(reopenAppeal(CASE), false);
  assert.equal(closeAppeal(CASE), true);
});

test("cases older than a year are pruned the next time any case closes", () => {
  const start = 1_800_000_000_000;
  closeAppeal(CASE, start);
  closeAppeal({ ...CASE, matchId: "NA1_RECENT" }, start + APPEAL_RETENTION_MS - 1000);
  assert.equal(isAppealClosed(CASE, start + APPEAL_RETENTION_MS), true, "exactly at the limit it still counts");
  assert.equal(isAppealClosed(CASE, start + APPEAL_RETENTION_MS + 1), false, "past the limit it no longer counts, even before pruning");
  assert.equal((getDatabase().prepare("SELECT count(*) AS count FROM appeal_cases").get() as { count: number }).count, 2);

  closeAppeal({ ...CASE, matchId: "NA1_NEW" }, start + APPEAL_RETENTION_MS + 1);
  const matches = getDatabase().prepare("SELECT match_id FROM appeal_cases ORDER BY match_id").all();
  assert.deepEqual(matches, [{ match_id: "NA1_NEW" }, { match_id: "NA1_RECENT" }], "the expired case was deleted");
});

test("erasing a member deletes that member's cases and records and nothing else", () => {
  const mine = makeHorseRecord({ guildId: "guild-one", discordUserId: "laowang", matchId: "NA1_100" });
  const theirs = makeHorseRecord({ guildId: "guild-one", discordUserId: "xiaoli", puuid: "account-b", matchId: "NA1_100" });
  recordTracked([mine, theirs]);
  closeAppeal(CASE);
  closeAppeal({ ...CASE, mock: true });
  closeAppeal({ ...CASE, guildId: "guild-two" });
  closeAppeal({ ...CASE, discordUserId: "xiaoli" });

  assert.equal(eraseMemberHorseRecords("guild-one", "laowang"), 1);
  assert.equal(isAppealClosed(CASE), false);
  assert.equal(isAppealClosed({ ...CASE, mock: true }), false);
  assert.equal(isAppealClosed({ ...CASE, guildId: "guild-two" }), true, "another server is untouched");
  assert.equal(isAppealClosed({ ...CASE, discordUserId: "xiaoli" }), true, "another member is untouched");

  assert.equal(eraseMemberAppeals("guild-one", "xiaoli"), 1);
  assert.equal(eraseMemberAppeals("guild-one", "xiaoli"), 0);
});

test("a case needs a server, a member and a match", () => {
  assert.throws(() => closeAppeal({ ...CASE, guildId: " " }), TypeError);
  assert.throws(() => isAppealClosed({ ...CASE, discordUserId: "" }), TypeError);
  assert.throws(() => reopenAppeal({ ...CASE, matchId: "" }), TypeError);
  assert.throws(() => eraseMemberAppeals("", "laowang"), TypeError);
  assert.throws(() => getDatabase().prepare("INSERT INTO appeal_cases VALUES ('g', 'u', 'm', 2, 0)").run(), /CHECK/);
});
