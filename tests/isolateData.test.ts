import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("the temporary directory of a test process, and of the children it starts, is inside its own folder", () => {
  const folder = process.env.M_ADVISOR_TEST_AUTO_DATA_DIR;
  assert.ok(folder, "the preload did not run");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) assert.equal(process.env[name], folder, `${name} does not point at the per-process folder`);
  assert.equal(path.resolve(os.tmpdir()), path.resolve(folder));
  const child = spawnSync(process.execPath, ["--eval", "console.log(require('node:os').tmpdir())"], { encoding: "utf8" });
  assert.equal(path.resolve(child.stdout.trim()), path.resolve(folder));
});

test("a folder is named with its process id, and the next run removes the stale ones of stopped processes only", () => {
  assert.match(path.basename(process.env.M_ADVISOR_TEST_AUTO_DATA_DIR ?? ""), new RegExp(`^m-advisor-test-data-${process.pid}-[A-Za-z0-9]{6}$`));
  const host = mkdtempSync(path.join(os.tmpdir(), "m-advisor-host-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const make = (name: string) => { const target = path.join(host, name); mkdirSync(target); writeFileSync(path.join(target, "left.sqlite3"), "x"); return target; };
    const stale = make(`m-advisor-test-data-${dead}-aaaaaa`);
    const running = make(`m-advisor-test-data-${process.pid}-bbbbbb`);
    const survivors = [running,
      make(`m-advisor-test-data-extra-${dead}-cccccc`), make(`m-advisor-test-data-${dead}-dddddd-x`), make(`m-advisor-test-data-${dead}-short`),
      make(`m-advisor-tts-${dead}-eeeeee`), make(`other-${dead}-ffffff`)];
    const outside = make("outside");
    symlinkSync(outside, path.join(host, `m-advisor-test-data-${dead}-gggggg`));
    survivors.push(outside, path.join(host, `m-advisor-test-data-${dead}-gggggg`));

    const run = spawnSync(process.execPath, ["--import", tsx, "--import", pathToFileURL(path.join(repo, "tests", "setup", "isolateData.ts")).href, "--eval",
      "console.log(require('node:os').tmpdir())"], { env: { ...process.env, TMPDIR: host }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(path.basename(run.stdout.trim()), /^m-advisor-test-data-\d+-[A-Za-z0-9]{6}$/);
    assert.ok(path.resolve(run.stdout.trim()).startsWith(path.resolve(host) + path.sep), "the child's folder is not inside the host temp directory it started with");

    assert.equal(existsSync(stale), false, "the folder of a stopped process was not removed");
    for (const survivor of survivors) assert.ok(existsSync(survivor), `${survivor} must not be removed`);
    assert.ok(existsSync(path.join(outside, "left.sqlite3")), "a symlink was followed");
    assert.equal(readdirSync(host).filter((name) => name.startsWith(`m-advisor-test-data-${run.pid}-`)).length, 0, "the child's own folder was left behind");
  } finally { rmSync(host, { recursive: true, force: true }); }
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
