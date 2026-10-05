import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LOG_RETENTION_DAYS, getLogDirectory, logError, logInfo, logToFileOnly, logWarn, startFileLog, stopFileLog } from "../src/utils/log";

let root: string;
let clock: Date;
let terminal: Array<{ stream: "out" | "err"; line: string }>;
const saved = { log: console.log, error: console.error, env: {} as Record<string, string | undefined> };
const envKeys = ["BOT_DATA_DIR", "DISCORD_TOKEN", "RIOT_API_KEY"];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "m-advisor-log-"));
  clock = new Date(2026, 9, 5, 23, 59, 58, 123);
  terminal = [];
  saved.env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  console.log = (line: string) => { terminal.push({ stream: "out", line }); };
  console.error = (line: string) => { terminal.push({ stream: "err", line }); };
});
afterEach(() => {
  stopFileLog();
  console.log = saved.log;
  console.error = saved.error;
  for (const [key, value] of Object.entries(saved.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const directory = () => path.join(root, "logs");
const start = () => startFileLog({ directory: directory(), now: () => clock });
const read = (day: string) => readFileSync(path.join(directory(), `bot-${day}.log`), "utf8");

test("without a file log, messages reach only the terminal with the local time", () => {
  process.env.BOT_DATA_DIR = root;
  logInfo("Speech provider ready.");
  logError("Match monitoring failed: offline");
  assert.equal(terminal.length, 2);
  assert.match(terminal[0].line, /^\[\d{2}:\d{2}:\d{2}\] Speech provider ready\.$/);
  assert.equal(terminal[0].stream, "out");
  assert.equal(terminal[1].stream, "err");
  assert.equal(existsSync(directory()), false, "tests and scripts must never create log files");
});

test("the file log appends timestamped, leveled lines and the terminal shows warnings and errors on stderr", () => {
  start();
  logInfo("Monitoring started for Player#NA1.");
  logWarn("Real mode skips the saved mock account MockWin#NA1.");
  logError("Match monitoring failed: offline");
  logToFileOnly("WARN", "ExperimentalWarning: already printed by Node");
  assert.deepEqual(terminal.map(({ stream, line }) => [stream, line]), [
    ["out", "[23:59:58] Monitoring started for Player#NA1."],
    ["err", "[23:59:58] Real mode skips the saved mock account MockWin#NA1."],
    ["err", "[23:59:58] Match monitoring failed: offline"],
  ]);
  const lines = read("2026-10-05").trimEnd().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^2026-10-05T23:59:58\.123[+-]\d{2}:\d{2} INFO Monitoring started for Player#NA1\.$/);
  assert.match(lines[1], / WARN Real mode skips/);
  assert.match(lines[2], / ERROR Match monitoring failed: offline$/);
  assert.match(lines[3], / WARN ExperimentalWarning: already printed by Node$/);
  assert.equal(statSync(directory()).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(directory(), "bot-2026-10-05.log")).mode & 0o777, 0o600);
});

test("each local day gets its own file and days beyond the retention window are pruned", () => {
  mkdirSync(directory(), { recursive: true });
  const dayBefore = (days: number) => {
    const date = new Date(2026, 9, 6 - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const expired = `bot-${dayBefore(LOG_RETENTION_DAYS)}.log`;
  const oldestKept = `bot-${dayBefore(LOG_RETENTION_DAYS - 1)}.log`;
  for (const name of [expired, oldestKept, "notes.txt", "bot-backup.log"]) writeFileSync(path.join(directory(), name), "old\n");

  start();
  logInfo("before midnight");
  assert.ok(readdirSync(directory()).includes(expired), "pruning is relative to the day being written");
  clock = new Date(2026, 9, 6, 0, 0, 1);
  logInfo("after midnight");
  assert.match(read("2026-10-05"), /before midnight/);
  assert.doesNotMatch(read("2026-10-05"), /after midnight/);
  assert.match(read("2026-10-06"), /^2026-10-06T00:00:01\.000.* INFO after midnight\n$/);
  assert.deepEqual(readdirSync(directory()).sort(), [oldestKept, "bot-2026-10-05.log", "bot-2026-10-06.log", "bot-backup.log", "notes.txt"].sort());
});

test("credentials are redacted from the terminal and the file", () => {
  process.env.DISCORD_TOKEN = "discord-secret-value";
  process.env.RIOT_API_KEY = "RGAPI-riot-secret";
  start();
  logError("Request failed with discord-secret-value and RGAPI-riot-secret twice: RGAPI-riot-secret");
  const expected = "Request failed with [DISCORD_TOKEN] and [RIOT_API_KEY] twice: [RIOT_API_KEY]";
  assert.equal(terminal[0].line, `[23:59:58] ${expected}`);
  assert.match(read("2026-10-05"), new RegExp(`ERROR ${expected.replace(/[[\]]/g, "\\$&")}\\n$`));
  assert.doesNotMatch(read("2026-10-05"), /secret/);
});

test("a failing log file warns once per failure streak and the terminal keeps every message", () => {
  writeFileSync(directory(), "a file where the log directory should be");
  start();
  logInfo("first");
  logInfo("second");
  assert.deepEqual(terminal.map(({ line }) => line.replace(/^\[[\d:]+\] /, "").replace(/:.*;/, ": …;")), [
    "first",
    "Log file write failed: …; logging continues in the terminal only.",
    "second",
  ]);
  rmSync(directory());
  logInfo("third");
  assert.match(read("2026-10-05"), /^[^\n]* INFO third\n$/, "the file resumes once writable");
  rmSync(directory(), { recursive: true });
  writeFileSync(directory(), "blocked again");
  clock = new Date(2026, 9, 6, 8);
  logInfo("fourth");
  assert.equal(terminal.filter(({ line }) => line.includes("Log file write failed")).length, 2);
});

test("the default directory follows BOT_DATA_DIR", () => {
  process.env.BOT_DATA_DIR = root;
  assert.equal(getLogDirectory(), path.join(root, "logs"));
  delete process.env.BOT_DATA_DIR;
  assert.equal(getLogDirectory(), path.resolve(".data", "logs"));
});
