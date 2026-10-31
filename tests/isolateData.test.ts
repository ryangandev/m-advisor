import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { getDatabasePath } from "../src/store/database";
import { getLogDirectory } from "../src/utils/log";

const repo = path.resolve(__dirname, "..");
const tsx = pathToFileURL(require.resolve("tsx/esm")).href;

test("the default database and log directory of a test process are a temporary directory, never the repo's .data", () => {
  const repoData = path.resolve(repo, ".data");
  const tmp = path.resolve(os.tmpdir());
  for (const target of [getDatabasePath(), getLogDirectory()]) {
    assert.ok(!path.resolve(target).startsWith(repoData + path.sep), `${target} is inside the repo's .data`);
    assert.ok(path.resolve(target).startsWith(tmp + path.sep), `${target} is not under the temporary directory`);
  }
});

test("host credentials and the data mode are not inherited by a test process", () => {
  for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "RIOT_API_KEY", "RIOT_MODE", "DATABASE_PATH"]) {
    assert.equal(process.env[name], undefined, `${name} leaked into the test process`);
  }
});

test("importing the probe script does not load a .env file, but running it does", () => {
  const sentinel = mkdtempSync(path.join(os.tmpdir(), "m-advisor-env-sentinel-"));
  try {
    writeFileSync(path.join(sentinel, ".env"), "DISCORD_TOKEN=sentinel-token\nCLIENT_ID=sentinel-client\nRIOT_API_KEY=sentinel-key\nRIOT_MODE=real\nDATABASE_PATH=sentinel.sqlite3\n");
    const script = path.join(repo, "scripts", "probe-spectator.ts");
    const env = { ...process.env };
    for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "RIOT_API_KEY", "RIOT_MODE", "DATABASE_PATH"]) delete env[name];
    const imported = spawnSync(process.execPath, ["--import", tsx, "--eval",
      `require(${JSON.stringify(script)}); console.log(JSON.stringify(["DISCORD_TOKEN","CLIENT_ID","RIOT_API_KEY","RIOT_MODE","DATABASE_PATH"].filter((name) => process.env[name] !== undefined)))`],
      { cwd: sentinel, env, encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), "[]");
    // Run as a command, the script reads .env: RIOT_MODE=real passes its first check and the missing key is reported, with no request made.
    const ran = spawnSync(process.execPath, ["--import", tsx, script], { cwd: sentinel, env: { ...env, RIOT_API_KEY: "" }, encoding: "utf8" });
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /Configure RIOT_API_KEY in \.env first\./);
    const withoutEnv = spawnSync(process.execPath, ["--import", tsx, script], { cwd: mkdtempSync(path.join(sentinel, "empty-")), env, encoding: "utf8" });
    assert.match(withoutEnv.stderr, /needs RIOT_MODE=real/);
  } finally { rmSync(sentinel, { recursive: true, force: true }); }
});
