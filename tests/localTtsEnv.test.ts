import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadLocalTtsEnv, pickLocalTtsEnv } from "../scripts/localTtsEnv";

const directory = mkdtempSync(path.join(os.tmpdir(), "local-tts-env-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const ENV_TEXT = [
  "DISCORD_TOKEN=secret-discord-token",
  "RIOT_API_KEY=RGAPI-secret",
  "RIOT_MODE=real",
  "LOCAL_TTS_TIMEOUT_MS=240000",
  'LOCAL_TTS_PYTHON="/opt/python3"',
  "LOCAL_TTS_MEDIA_ROOT=/media",
].join("\n");

test("only LOCAL_TTS_ keys are picked", () => {
  assert.deepEqual(pickLocalTtsEnv({ DISCORD_TOKEN: "x", LOCAL_TTS_QUEUE_LIMIT: "3", NOT_LOCAL_TTS_X: "y" }), { LOCAL_TTS_QUEUE_LIMIT: "3" });
});

test("loading .env sets the speech overrides and never other keys", () => {
  const file = path.join(directory, ".env");
  writeFileSync(file, ENV_TEXT);
  const target: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadLocalTtsEnv(file, target).sort(), ["LOCAL_TTS_MEDIA_ROOT", "LOCAL_TTS_PYTHON", "LOCAL_TTS_TIMEOUT_MS"]);
  assert.deepEqual(target, { LOCAL_TTS_TIMEOUT_MS: "240000", LOCAL_TTS_PYTHON: "/opt/python3", LOCAL_TTS_MEDIA_ROOT: "/media" });
});

test("a variable already in the environment wins over the file", () => {
  const file = path.join(directory, ".env.set");
  writeFileSync(file, ENV_TEXT);
  const target: NodeJS.ProcessEnv = { LOCAL_TTS_TIMEOUT_MS: "1000" };
  loadLocalTtsEnv(file, target);
  assert.equal(target.LOCAL_TTS_TIMEOUT_MS, "1000");
  assert.equal(target.LOCAL_TTS_PYTHON, "/opt/python3");
});

test("a missing .env file is fine", () => {
  const target: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadLocalTtsEnv(path.join(directory, "absent.env"), target), []);
  assert.deepEqual(target, {});
});
