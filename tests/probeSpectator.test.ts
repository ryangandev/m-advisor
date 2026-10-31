import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { runProbe } from "../scripts/probe-spectator";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { RIOT_MODE: process.env.RIOT_MODE, RIOT_API_KEY: process.env.RIOT_API_KEY };
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "RGAPI-test-key-value";
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fake(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "x-app-rate-limit": "20:1" } })) as typeof fetch;
}

async function run(status: number, body: unknown) {
  const lines: string[] = [];
  const code = await runProbe("secret-puuid", fake(status, body), (line) => lines.push(line));
  return { code, text: lines.join("\n") };
}

test("probe prints raw types and values next to the parsed ones, without identities", async () => {
  const { code, text } = await run(200, {
    gameId: 5, gameStartTime: "1700", gameLength: 12.5, gameQueueConfigId: "420", mapId: 11, platformId: "NA1",
    participants: [{ teamId: 100, puuid: "secret-puuid", riotId: "Secret#NA1", summonerName: "Secret" }, { teamId: 7, puuid: "p2" }],
  });
  assert.equal(code, 1, "a string gameStartTime is rejected by the parser");
  assert.match(text, /gameStartTime raw string "1700"/);
  assert.match(text, /gameQueueConfigId raw string "420"/);
  assert.doesNotMatch(text, /secret|RGAPI/i);
});

test("probe shows raw and parsed values for an accepted body with degraded fields", async () => {
  const { code, text } = await run(200, {
    gameId: 5, gameStartTime: 1700, gameLength: 12.5, gameQueueConfigId: "420", mapId: 11, platformId: "NA1",
    participants: [{ teamId: 100, puuid: "secret-puuid", riotId: "Secret#NA1", summonerName: "Secret" }, { teamId: 7, puuid: "p2" }],
  });
  assert.equal(code, 0);
  assert.match(text, /gameStartTime raw number 1700, parsed 1700 \(game clock running\)/);
  assert.match(text, /gameQueueConfigId raw string "420", parsed null/);
  assert.match(text, /gameLength raw number 12.5/);
  assert.match(text, /mapId raw number 11, parsed 11/);
  assert.match(text, /platformId raw string "NA1"/);
  assert.match(text, /participants raw array \[2 items\], parsed 1/);
  assert.doesNotMatch(text, /secret|RGAPI/i);
});

test("probe shows a rejected body's raw fields and exits non-zero", async () => {
  const { code, text } = await run(200, { gameId: 5, gameStartTime: null, gameLength: 1, participants: [] });
  assert.equal(code, 1);
  assert.match(text, /status 200, invalid_response/);
  assert.match(text, /gameStartTime raw null null/);
  assert.match(text, /mapId raw missing \(absent\)/);
});

test("probe exits non-zero with the status on a Riot error", async () => {
  for (const status of [401, 403, 429]) {
    const { code, text } = await run(status, { status: { message: "x", status_code: status } });
    assert.equal(code, 1, String(status));
    assert.match(text, new RegExp(`status ${status}, `));
  }
});

test("probe treats not being in a game as success", async () => {
  const { code, text } = await run(404, { errorCode: "NOT_FOUND" });
  assert.equal(code, 0);
  assert.match(text, /not in a game/);
});
