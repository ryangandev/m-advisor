import assert from "node:assert/strict";
import { test } from "node:test";
import { captureConsole } from "./helpers/captureConsole";
import { RiotApiError } from "../src/services/riotData";
import { checkRiotKey, RIOT_KEY_CHECK_URL } from "../src/services/riotKey";

const KEY_LINE = /^\[\d\d:\d\d:\d\d\] Riot rejected RIOT_API_KEY \((401|403)\); paste a new key into \.env and restart\.$/;

test("mock mode makes no key check at all", async (t) => {
  const logged = captureConsole(t);
  const urls: string[] = [];
  await checkRiotKey({ mode: "mock", request: async (url) => { urls.push(url); return {}; } });
  assert.deepEqual(urls, []);
  assert.deepEqual(logged.lines, []);
});

test("an accepted key is one info line and the check reads the status endpoint", async (t) => {
  const logged = captureConsole(t);
  const urls: string[] = [];
  await checkRiotKey({ mode: "real", stopping: () => false, request: async (url) => { urls.push(url); return {}; } });
  assert.deepEqual(urls, [RIOT_KEY_CHECK_URL]);
  assert.equal(logged.lines.length, 1);
  assert.match(logged.lines[0], /RIOT_API_KEY accepted by Riot\.$/);
});

for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
  test(`a ${status} logs the rejected-key line and does not throw`, async (t) => {
    const logged = captureConsole(t);
    await checkRiotKey({ mode: "real", stopping: () => false, request: async () => { throw new RiotApiError("rejected", code, status); } });
    assert.equal(logged.lines.length, 1);
    assert.match(logged.lines[0], KEY_LINE);
    assert.ok(logged.lines[0].includes(`(${status})`));
  });
}

test("any other failure is one warning that names the reason and never the key", async (t) => {
  const logged = captureConsole(t);
  const saved = process.env.RIOT_API_KEY;
  process.env.RIOT_API_KEY = "do-not-log-this-key";
  t.after(() => {
    if (saved === undefined) delete process.env.RIOT_API_KEY;
    else process.env.RIOT_API_KEY = saved;
  });
  await checkRiotKey({ mode: "real", stopping: () => false, request: async () => { throw new RiotApiError("do-not-log-this-key", "timeout"); } });
  await checkRiotKey({ mode: "real", stopping: () => false, request: async () => { throw new Error("boom"); } });
  assert.equal(logged.lines.length, 2);
  assert.match(logged.lines[0], /Could not check RIOT_API_KEY at startup \(timeout\)/);
  assert.match(logged.lines[1], /Could not check RIOT_API_KEY at startup \(unknown error\)/);
  assert.ok(logged.lines.every((line) => !line.includes("do-not-log-this-key")));
});

test("a check that finishes after shutdown began logs nothing", async (t) => {
  const logged = captureConsole(t);
  await checkRiotKey({ mode: "real", stopping: () => true, request: async () => { throw new RiotApiError("rejected", "unauthorized", 401); } });
  await checkRiotKey({ mode: "real", stopping: () => true, request: async () => ({}) });
  assert.deepEqual(logged.lines, []);
});
