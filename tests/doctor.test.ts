import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { setMemberAccounts } from "../src/store/bindingStore";
import { closeDatabase } from "../src/store/database";

const root = path.resolve(__dirname, "..");
let directory: string;
let savedDatabasePath: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "m-advisor-doctor-"));
  savedDatabasePath = process.env.DATABASE_PATH;
});
afterEach(() => {
  closeDatabase();
  if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDatabasePath;
  rmSync(directory, { recursive: true, force: true });
});

function seedBinding(databasePath: string): void {
  process.env.DATABASE_PATH = databasePath;
  setMemberAccounts("guild-1", "tracked", [
    { puuid: "real-puuid", gameName: "RealName", tagLine: "NA1" },
    { puuid: "MOCK-fixture", gameName: "MockWin", tagLine: "NA1" },
  ]);
  closeDatabase();
}

// Runs the real doctor from an empty working directory so the repository's .env is never loaded.
function doctor(mode: "mock" | "real", databasePath: string, extra: Record<string, string> = {}) {
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, path.join(root, "src/cli/doctor.ts")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RIOT_MODE: mode, DISCORD_TOKEN: "test-token-value", CLIENT_ID: "test-client-id", RIOT_API_KEY: "test-riot-key-value", ...extra, DATABASE_PATH: databasePath, BOT_DATA_DIR: path.join(directory, "data") },
  });
  assert.equal(child.error, undefined);
  const report = JSON.parse(child.stdout.slice(0, child.stdout.indexOf("\n}") + 2)) as Record<string, unknown>;
  return { child, report };
}

test("doctor warns about saved mock accounts in real mode without failing", () => {
  const databasePath = path.join(directory, "bot.sqlite3");
  seedBinding(databasePath);
  const { child, report } = doctor("real", databasePath);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(report.savedBindings, 1);
  assert.equal(report.logDirectory, path.join(directory, "data", "logs"));
  assert.equal(child.stderr.trim(),
    "Warning: Real mode skips the saved mock account MockWin#NA1 in server guild-1; use /bind with a real Riot ID to replace it.");
});

test("doctor stays quiet about mock accounts in mock mode", () => {
  const databasePath = path.join(directory, "bot.sqlite3");
  seedBinding(databasePath);
  const { child, report } = doctor("mock", databasePath);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(report.savedBindings, 1);
  assert.equal(child.stderr, "");
});

test("doctor never creates a missing database", () => {
  const databasePath = path.join(directory, "missing", "bot.sqlite3");
  const { child, report } = doctor("real", databasePath);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(report.savedBindings, 0);
  assert.equal(existsSync(path.dirname(databasePath)), false);
});

test("doctor passes in mock mode without a Riot key", () => {
  const { child } = doctor("mock", path.join(directory, "bot.sqlite3"), { RIOT_API_KEY: "" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
});

test("doctor fails in real mode when the Riot key is missing or blank after trimming", () => {
  for (const key of ["", "   "]) {
    const { child, report } = doctor("real", path.join(directory, "bot.sqlite3"), { RIOT_API_KEY: key });
    assert.equal(child.status, 1);
    assert.equal(report.riotKeyPresent, false);
    assert.match(child.stderr, /Error: RIOT_MODE=real requires RIOT_API_KEY/);
  }
});

test("doctor fails when DISCORD_TOKEN or CLIENT_ID is missing, naming the variable only", () => {
  const token = doctor("mock", path.join(directory, "bot.sqlite3"), { DISCORD_TOKEN: "" });
  assert.equal(token.child.status, 1);
  assert.match(token.child.stderr, /Error: Missing DISCORD_TOKEN/);
  const client = doctor("mock", path.join(directory, "bot.sqlite3"), { CLIENT_ID: "" });
  assert.equal(client.child.status, 1);
  assert.match(client.child.stderr, /Error: Missing CLIENT_ID/);
  for (const text of [token.child.stdout, token.child.stderr, client.child.stdout, client.child.stderr]) {
    assert.equal(text.includes("test-token-value") || text.includes("test-riot-key-value"), false);
  }
});
