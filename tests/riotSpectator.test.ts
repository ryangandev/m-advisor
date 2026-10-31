import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildMockProfile } from "../src/fixtures/riotFixtures";
import { getAccountByRiotId, getSummonerByPuuid } from "../src/utils/riotApi";
import { getLatestSRMatchId, getMatchDetail } from "../src/utils/riotMatchApi";
import {
  createSpectatorRequester, getActiveGame, isAnnouncedGame, isLoading, isSpectatorAuthError, matchIdOf, parseActiveGame,
  SPECTATOR_REQUESTER_OPTIONS, spectatorRequester,
} from "../src/utils/riotSpectatorApi";
import { resetMockData, RiotApiError, riotFetch, simulateMockGameStart, simulateMockMatch } from "../src/services/riotData";
import { withoutRiotPacing } from "./helpers/unpacedRiot";

// Some requesters here have a timeout of a few milliseconds, which is also their longest wait for a turn.
withoutRiotPacing();

// tests/fixtures/spectator-active-game.documented.json is built from Riot's DOCUMENTED CurrentGameInfo shape for
// spectator-v5. It is NOT a capture of a real response, until the file is replaced or confirmed with one.
// The 404 body used below is real: the orchestrator captured it with the dev key on 2026-10-27.
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (): Raw => JSON.parse(readFileSync(path.resolve(__dirname, "fixtures", "spectator-active-game.documented.json"), "utf8"));
const NOT_IN_GAME = { httpStatus: 404, errorCode: "NOT_FOUND", message: "Not Found", implementationDetails: "filtered" };

const originalMode = process.env.RIOT_MODE;
const originalKey = process.env.RIOT_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.RIOT_MODE;
  delete process.env.RIOT_API_KEY;
  resetMockData();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.RIOT_MODE;
  else process.env.RIOT_MODE = originalMode;
  if (originalKey === undefined) delete process.env.RIOT_API_KEY;
  else process.env.RIOT_API_KEY = originalKey;
});

function realMode(fetchImpl: typeof fetch): void {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-secret-key";
  globalThis.fetch = fetchImpl;
}

test("the documented fixture parses into the fields the watcher relies on", () => {
  const game = parseActiveGame(fixture());
  assert.equal(game.gameId, 5310000001);
  assert.equal(game.gameStartTime, 1795800000000);
  assert.equal(game.gameLength, 125);
  assert.equal(game.gameQueueConfigId, 420);
  assert.equal(game.mapId, 11);
  assert.equal(game.platformId, "NA1");
  assert.equal(game.mock, false);
  assert.equal(game.mockMatchId, undefined);
  assert.equal(game.participants.length, 10);
  assert.deepEqual(game.participants[0], { puuid: "fixture-puuid-01", teamId: 100, championId: 103, spell1Id: 4, spell2Id: 14, bot: false });
  assert.equal(game.participants[2].spell2Id, 11, "Smite is kept");
  assert.deepEqual(game.participants.map((player) => player.teamId), [100, 100, 100, 100, 100, 200, 200, 200, 200, 200]);
});

test("a real request goes to na1 spectator-v5 with the key in the header and returns the parsed game", async () => {
  const seen: { url: string; token: string | undefined }[] = [];
  realMode((async (input, init) => {
    seen.push({ url: input.toString(), token: (init?.headers as Record<string, string>)["X-Riot-Token"] });
    return Response.json(fixture());
  }) as typeof fetch);
  const game = await getActiveGame("puuid/with space");
  assert.deepEqual(seen, [{
    url: "https://na1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/puuid%2Fwith%20space", token: "test-secret-key",
  }]);
  assert.equal(game?.mock, false);
  assert.equal(game?.participants.length, 10);
  await assert.rejects(getActiveGame("  "), { code: "bad_request" });
  assert.equal(seen.length, 1, "an empty PUUID makes no request");
});

test("a 404 NOT_FOUND from Riot means the account is not in a game", async () => {
  realMode((async () => Response.json(NOT_IN_GAME, { status: 404 })) as typeof fetch);
  assert.equal(await getActiveGame("p1", createSpectatorRequester()), null);
});

test("any other 404 is a typed error, not a quiet 'not in a game'", async () => {
  const others: [string, () => Response][] = [
    ["Riot's old status envelope", () => Response.json({ status: { message: "Data not found", status_code: 404 } }, { status: 404 })],
    ["another errorCode", () => Response.json({ httpStatus: 404, errorCode: "SOMETHING_ELSE" }, { status: 404 })],
    ["a free-form errorCode", () => Response.json({ errorCode: "not found; test-secret-key" }, { status: 404 })],
    ["an HTML page", () => new Response("<html>gateway</html>", { status: 404 })],
    ["an empty body", () => new Response(null, { status: 404 })],
  ];
  for (const [name, response] of others) {
    realMode((async () => response()) as typeof fetch);
    await assert.rejects(getActiveGame("p1", createSpectatorRequester()), (error: unknown) => {
      assert.ok(error instanceof RiotApiError, name);
      assert.equal(error.code, "invalid_response", name);
      assert.equal(error.status, 404, name);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /test-secret-key|gateway/, name);
      return true;
    }, name);
  }
});

test("the participant riotId is never kept and a mock match ID in a real body is ignored", () => {
  const body = fixture();
  body.mockMatchId = "MOCK_x_0_1";
  const game = parseActiveGame(body);
  assert.doesNotMatch(JSON.stringify(game), /FixturePlayer|riotId|mockMatchId|MOCK_x/);
  assert.equal(matchIdOf(game), "NA1_5310000001");
});

test("the parser tolerates missing optional fields and unknown extras", () => {
  const body = fixture();
  for (const key of ["gameType", "gameMode", "bannedChampions", "observers"]) delete body[key];
  for (const player of body.participants) {
    for (const key of ["riotId", "profileIconId", "perks", "gameCustomizationObjects"]) delete player[key];
    player.somethingNew = { nested: [1, 2, 3] };
  }
  body.someNewTopLevelField = "x";
  assert.deepEqual(parseActiveGame(body), parseActiveGame(fixture()));
});

test("a participant without a usable account is kept with a null puuid instead of failing the game", () => {
  const body = fixture();
  body.participants[4].bot = true;
  body.participants[4].puuid = null;
  body.participants[5].bot = true;
  delete body.participants[5].puuid;
  delete body.participants[6].puuid; // a human whose PUUID Riot hid
  body.participants[7].puuid = 12345;
  body.participants[8].puuid = "";
  const game = parseActiveGame(body);
  assert.equal(game.participants.length, 10);
  assert.deepEqual(game.participants.slice(4, 9).map((player) => [player.puuid, player.bot]),
    [[null, true], [null, true], [null, false], [null, false], [null, false]]);
  assert.equal(game.participants[9].puuid, "fixture-puuid-10");
});

test("a bad champion, spell or bot flag degrades to 0 or false, and an unplaceable participant is dropped", () => {
  const body = fixture();
  body.participants[0].championId = -1;
  delete body.participants[1].championId;
  body.participants[2].championId = "103";
  delete body.participants[3].spell1Id;
  body.participants[3].spell2Id = 4.5;
  delete body.participants[4].bot;
  body.participants[5].teamId = 300; // dropped
  delete body.participants[6].teamId; // dropped
  body.participants[7] = null; // dropped
  body.participants[8] = "p"; // dropped
  const game = parseActiveGame(body);
  assert.deepEqual(game.participants.map((player) => player.puuid), [
    "fixture-puuid-01", "fixture-puuid-02", "fixture-puuid-03", "fixture-puuid-04", "fixture-puuid-05", "fixture-puuid-10",
  ]);
  assert.deepEqual(game.participants.slice(0, 3).map((player) => player.championId), [0, 0, 0]);
  assert.deepEqual([game.participants[3].spell1Id, game.participants[3].spell2Id], [0, 0]);
  assert.equal(game.participants[4].bot, false);
});

test("missing queue, map and platform become null and are never announced", () => {
  for (const key of ["gameQueueConfigId", "mapId", "platformId"]) {
    const body = fixture();
    delete body[key];
    const game = parseActiveGame(body);
    assert.equal(game[key as "gameQueueConfigId" | "mapId" | "platformId"], null, key);
    if (key !== "platformId") assert.equal(isAnnouncedGame(game), false, key);
  }
  const custom = fixture();
  custom.gameQueueConfigId = 0;
  custom.mapId = 11;
  assert.equal(isAnnouncedGame(parseActiveGame(custom)), false, "custom games are queue 0");
  const nonsense = fixture();
  nonsense.gameQueueConfigId = "420";
  nonsense.mapId = -1;
  nonsense.platformId = " ";
  const parsed = parseActiveGame(nonsense);
  assert.deepEqual([parsed.gameQueueConfigId, parsed.mapId, parsed.platformId], [null, null, null]);
  assert.equal(isAnnouncedGame(parsed), false);
});

test("isAnnouncedGame accepts announced Summoner's Rift queues only", () => {
  const announced = (queue: number, map: number) => {
    const body = fixture();
    body.gameQueueConfigId = queue;
    body.mapId = map;
    return isAnnouncedGame(parseActiveGame(body));
  };
  assert.equal(announced(420, 11), true);
  assert.equal(announced(490, 11), true);
  assert.equal(announced(450, 12), false, "ARAM");
  assert.equal(announced(420, 12), false, "right queue, wrong map");
  assert.equal(announced(1700, 30), false, "Arena");
});

test("a tolerant parse still needs a usable game ID, start time, participants array and game length", () => {
  const cases: [string, (body: Raw) => void][] = [
    ["missing gameId", (body) => { delete body.gameId; }],
    ["zero gameId", (body) => { body.gameId = 0; }],
    ["fractional gameId", (body) => { body.gameId = 1.5; }],
    ["unsafe gameId", (body) => { body.gameId = 2 ** 60; }],
    ["text gameId", (body) => { body.gameId = "5310000001"; }],
    ["missing gameStartTime", (body) => { delete body.gameStartTime; }],
    ["negative gameStartTime", (body) => { body.gameStartTime = -1; }],
    ["missing gameLength", (body) => { delete body.gameLength; }],
    ["text gameLength", (body) => { body.gameLength = "125"; }],
    ["infinite gameLength", (body) => { body.gameLength = Infinity; }],
    ["missing participants", (body) => { delete body.participants; }],
    ["participants is an object", (body) => { body.participants = {}; }],
  ];
  for (const [name, change] of cases) {
    const body = fixture();
    change(body);
    assert.throws(() => parseActiveGame(body), (error: unknown) => {
      assert.ok(error instanceof RiotApiError && error.code === "invalid_response", name);
      return true;
    }, name);
  }
  for (const body of [null, [], "game", 7]) assert.throws(() => parseActiveGame(body), { code: "invalid_response" });
  const loading = fixture();
  loading.gameLength = -30;
  loading.participants = [];
  assert.equal(parseActiveGame(loading).gameLength, -30, "a negative length and an empty roster are accepted");
});

test("a body that is not a game surfaces as invalid_response instead of looking like no game", async () => {
  const body = fixture();
  delete body.gameId;
  realMode((async () => Response.json(body)) as typeof fetch);
  await assert.rejects(getActiveGame("p1", createSpectatorRequester()), { code: "invalid_response" });
});

test("a practice tool or custom game with a hidden player still parses on every poll", async () => {
  const body = fixture();
  body.gameQueueConfigId = 0;
  body.mapId = 11;
  delete body.participants[2].puuid;
  body.participants[3].teamId = 0;
  realMode((async () => Response.json(body)) as typeof fetch);
  const game = (await getActiveGame("p1", createSpectatorRequester()))!;
  assert.equal(game.participants.length, 9);
  assert.equal(isAnnouncedGame(game), false);
  assert.equal(matchIdOf(game), "NA1_5310000001");
});

test("isLoading is true only while Riot reports no start time", () => {
  const body = fixture();
  assert.equal(isLoading(parseActiveGame(body)), false);
  body.gameStartTime = 0;
  body.gameLength = 0;
  assert.equal(isLoading(parseActiveGame(body)), true);
  body.gameStartTime = 1;
  assert.equal(isLoading(parseActiveGame(body)), false);
});

test("the match ID of a real game is NA1_ plus the game ID", () => {
  const body = fixture();
  assert.equal(matchIdOf(parseActiveGame(body)), "NA1_5310000001");
  body.gameId = 42;
  assert.equal(matchIdOf(parseActiveGame(body)), "NA1_42");
});

test("401 and 403 are typed so the watcher can disable itself, and never expose the key", async () => {
  for (const status of [401, 403]) {
    realMode((async () => new Response("secret test-secret-key", { status })) as typeof fetch);
    await assert.rejects(getActiveGame("p1"), (error: unknown) => {
      assert.ok(isSpectatorAuthError(error));
      assert.equal((error as RiotApiError).status, status);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /test-secret-key/);
      return true;
    });
  }
  assert.equal(isSpectatorAuthError(new RiotApiError("x", "rate_limited", 429)), false);
  assert.equal(isSpectatorAuthError(new RiotApiError("x", "unavailable", 503)), false);
  assert.equal(isSpectatorAuthError(new Error("401")), false);
});

test("spectator requests make one attempt and are aborted at the timeout", async () => {
  process.env.RIOT_MODE = "real";
  assert.deepEqual(SPECTATOR_REQUESTER_OPTIONS, { timeoutMs: 5_000, maxRetries: 0, maxRetryDelayMs: 0, readNotFoundCode: true });
  const requester = (fetchImpl: typeof fetch, timeoutMs: number = SPECTATOR_REQUESTER_OPTIONS.timeoutMs) => createSpectatorRequester({
    timeoutMs, apiKey: () => "test-secret", fetch: fetchImpl, sleep: async () => assert.fail("spectator never waits or retries"),
  });
  let attempts = 0;
  let aborted = false;
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    const hanging = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      attempts++;
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    })) as typeof fetch;
    await assert.rejects(getActiveGame("p1", requester(hanging, 10)), { code: "timeout" });
  } finally { clearTimeout(keepAlive); }
  assert.equal(attempts, 1);
  assert.equal(aborted, true, "the request itself is aborted, not just abandoned");
  attempts = 0;
  const failing = (async () => { attempts++; return new Response(null, { status: 503 }); }) as typeof fetch;
  await assert.rejects(getActiveGame("p1", requester(failing)), { status: 503 });
  assert.equal(attempts, 1, "a 503 is not retried");
});

test("a mock game is labeled, loading, and built around the given accounts without any network", async () => {
  globalThis.fetch = async () => { throw new Error("mock flows must not call network"); };
  const win = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  const other = await getAccountByRiotId("MockLoss", "NA1");
  assert.equal(await getActiveGame(win.puuid), null, "no mock game means a simulated 404");
  const started = simulateMockGameStart([win.puuid, alt.puuid]);
  assert.match(started.matchId, /^MOCK_/);
  const game = (await getActiveGame(win.puuid))!;
  assert.equal(game.mock, true);
  assert.equal(matchIdOf(game), started.matchId);
  assert.equal(game.gameId, started.gameId);
  assert.ok(game.gameId > 9_000_000_000, "a mock game ID is never one Riot issues");
  assert.equal(isLoading(game), true);
  assert.equal(game.gameLength, 0);
  assert.equal(game.gameQueueConfigId, 420);
  assert.equal(game.mapId, 11);
  assert.deepEqual(game.participants.filter((player) => player.teamId === 100).map((player) => player.puuid),
    [win.puuid, alt.puuid, "MOCK-ALLY-1", "MOCK-ALLY-2", "MOCK-ALLY-3"]);
  assert.deepEqual(game.participants.filter((player) => player.teamId === 200).map((player) => player.puuid),
    ["MOCK-ENEMY-1", "MOCK-ENEMY-2", "MOCK-ENEMY-3", "MOCK-ENEMY-4", "MOCK-ENEMY-5"]);
  assert.ok(game.participants.every((player) => !player.bot && player.championId > 0));
  assert.equal(game.participants.filter((player) => player.spell1Id === 11 || player.spell2Id === 11).length, 2, "one Smite per team");
  assert.deepEqual(await getActiveGame(alt.puuid), game, "every member sees the same game");
  assert.equal(await getActiveGame(other.puuid), null, "an account outside it is not in a game");
  assert.equal(simulateMockGameStart([other.puuid]).gameId !== started.gameId, true);
});

test("ending a mock game with simulateMockMatch reuses the reserved match ID", async () => {
  const win = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  const started = simulateMockGameStart([win.puuid, alt.puuid]);
  const ended = simulateMockMatch(win.puuid, "win");
  assert.equal(ended.matchId, started.matchId);
  assert.equal(await getLatestSRMatchId(win.puuid), started.matchId);
  assert.equal((await getMatchDetail(started.matchId)).metadata.matchId, started.matchId);
  assert.equal(await getActiveGame(win.puuid), null, "the game is over");
  assert.equal(await getActiveGame(alt.puuid), null, "it ends for everyone in it");
  assert.notEqual(simulateMockMatch(win.puuid, "win").matchId, started.matchId, "a later match gets its own ID");
  const next = simulateMockGameStart([alt.puuid]);
  assert.notEqual(next.matchId, started.matchId);
});

test("a duo's finished match is in both histories, on one team, with the champions the game had", async () => {
  const win = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  const started = simulateMockGameStart([win.puuid, alt.puuid]);
  const game = (await getActiveGame(alt.puuid))!;
  simulateMockMatch(win.puuid, "win");
  assert.equal(await getLatestSRMatchId(alt.puuid), started.matchId, "the second friend's history has it too");
  assert.equal(await getLatestSRMatchId(win.puuid), started.matchId);
  const match = await getMatchDetail(started.matchId);
  const me = match.info.participants.find((player) => player.puuid === win.puuid)!;
  const friend = match.info.participants.find((player) => player.puuid === alt.puuid)!;
  assert.equal(friend.teamId, me.teamId, "same team");
  assert.equal(friend.win, true);
  assert.equal(match.info.participants.length, 10);
  assert.equal(new Set(match.info.participants.map((player) => player.puuid)).size, 10, "no duplicate PUUID");
  assert.deepEqual(match.info.participants.map((player) => [player.puuid, player.teamId, player.championId]),
    game.participants.map((player) => [player.puuid, player.teamId, player.championId]), "same seats, teams and champions as the game");
  assert.deepEqual(match.metadata.participants.filter((puuid) => puuid.startsWith("MOCK-ALLY")), ["MOCK-ALLY-1", "MOCK-ALLY-2", "MOCK-ALLY-3"]);
  // Ending it from the other friend would have produced the same game.
  resetMockData();
  const again = simulateMockGameStart([win.puuid, alt.puuid]);
  simulateMockMatch(alt.puuid, "loss");
  const lost = await getMatchDetail(again.matchId);
  assert.equal(lost.info.participants.find((player) => player.puuid === win.puuid)?.win, false);
  assert.equal(lost.info.participants.find((player) => player.puuid === alt.puuid)?.win, false);
});

test("a mock game can put friends on the red team, and the finished match keeps them there", async () => {
  const win = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  const loss = await getAccountByRiotId("MockLoss", "NA1");
  const started = simulateMockGameStart([win.puuid], [alt.puuid, loss.puuid]);
  const game = (await getActiveGame(alt.puuid))!;
  assert.deepEqual(game.participants.filter((player) => player.teamId === 200).slice(0, 2).map((player) => player.puuid), [alt.puuid, loss.puuid]);
  assert.deepEqual(game.participants.filter((player) => player.teamId === 100).map((player) => player.puuid),
    [win.puuid, "MOCK-ALLY-1", "MOCK-ALLY-2", "MOCK-ALLY-3", "MOCK-ALLY-4"]);
  assert.deepEqual(game.participants.filter((player) => player.teamId === 200).slice(2).map((player) => player.puuid),
    ["MOCK-ENEMY-1", "MOCK-ENEMY-2", "MOCK-ENEMY-3"]);
  assert.equal(matchIdOf((await getActiveGame(win.puuid))!), started.matchId, "one game for both sides");
  simulateMockMatch(alt.puuid, "win"); // the red side wins
  for (const account of [win, alt, loss]) assert.equal(await getLatestSRMatchId(account.puuid), started.matchId);
  const match = await getMatchDetail(started.matchId);
  const byPuuid = (puuid: string) => match.info.participants.find((player) => player.puuid === puuid)!;
  assert.deepEqual([byPuuid(alt.puuid).teamId, byPuuid(loss.puuid).teamId, byPuuid(win.puuid).teamId], [200, 200, 100]);
  assert.deepEqual([byPuuid(alt.puuid).win, byPuuid(loss.puuid).win, byPuuid(win.puuid).win], [true, true, false]);
  assert.deepEqual(match.info.participants.map((player) => [player.puuid, player.teamId, player.championId]),
    game.participants.map((player) => [player.puuid, player.teamId, player.championId]));
});

test("resetMockData clears mock games", async () => {
  const win = await getAccountByRiotId("MockWin", "NA1");
  simulateMockGameStart([win.puuid]);
  resetMockData();
  assert.equal(await getActiveGame(win.puuid), null);
  const started = simulateMockGameStart([win.puuid]);
  assert.equal(matchIdOf((await getActiveGame(win.puuid))!), started.matchId);
});

test("mock games reject bad input, double starts, failing accounts and real mode", async () => {
  const win = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  assert.throws(() => simulateMockGameStart([]), { code: "bad_request" });
  assert.throws(() => simulateMockGameStart([win.puuid, win.puuid]), { code: "bad_request" });
  assert.throws(() => simulateMockGameStart(["a", "b", "c", "d", "e", "f"]), { code: "bad_request" });
  assert.throws(() => simulateMockGameStart([win.puuid], [win.puuid]), { code: "bad_request" }, "one account cannot be on both teams");
  assert.throws(() => simulateMockGameStart([win.puuid], ["a", "b", "c", "d", "e", "f"]), { code: "bad_request" });
  assert.throws(() => simulateMockGameStart([], [alt.puuid]), { code: "bad_request" }, "team 100 needs someone");
  assert.throws(() => simulateMockGameStart([" "]), { code: "bad_request" });
  simulateMockGameStart([win.puuid]);
  assert.throws(() => simulateMockGameStart([alt.puuid, win.puuid]), { code: "bad_request" });
  assert.equal(await getActiveGame(alt.puuid), null, "a refused start leaves the other account out of any game");
  process.env.RIOT_MODE = "real";
  assert.throws(() => simulateMockGameStart([alt.puuid]), { code: "mock_only" });
});

test("a failure account's spectator request fails with a labeled simulated error", async () => {
  // The failed lookup still registers the account, so a stored PUUID is then asked about with the same failure.
  await assert.rejects(getAccountByRiotId("MockAuth", "NA1"), { status: 401 });
  const puuid = buildMockProfile("MockAuth", "NA1").account.puuid;
  await assert.rejects(getActiveGame(puuid), (error: unknown) =>
    error instanceof RiotApiError && error.status === 401 && error.simulated && /模拟数据/.test(error.message));
  assert.throws(() => simulateMockGameStart([puuid]), { status: 401 });
});

test("a mock body needs its reserved match ID, and a mock game never answers in real mode", async () => {
  const body = fixture();
  assert.throws(() => parseActiveGame(body, true), { code: "invalid_response" });
  body.mockMatchId = "NA1_5310000001";
  assert.throws(() => parseActiveGame(body, true), { code: "invalid_response" });
  assert.throws(() => matchIdOf({ ...parseActiveGame(fixture()), mock: true }), { code: "invalid_response" });
  const win = await getAccountByRiotId("MockWin", "NA1");
  simulateMockGameStart([win.puuid]);
  realMode((async () => Response.json(NOT_IN_GAME, { status: 404 })) as typeof fetch);
  assert.equal(await getActiveGame(win.puuid), null, "real mode asks Riot, not the mock registry");
});

test("the default spectator requester is its own, not the shared one", () => {
  assert.notEqual(spectatorRequester, riotFetch);
  assert.notEqual(createSpectatorRequester(), spectatorRequester, "each requester has its own cooldown");
});

test("a spectator 429 stays on the spectator requester and never blocks na1 profile requests", async () => {
  const paths: string[] = [];
  realMode((async (input) => {
    const { pathname } = new URL(input.toString());
    paths.push(pathname);
    if (pathname.startsWith("/lol/spectator/")) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    return Response.json({ id: "s", accountId: "a", puuid: "p1", profileIconId: 1, summonerLevel: 30 });
  }) as typeof fetch);
  const spectator = createSpectatorRequester(); // fresh, so this test does not depend on the order of the others
  await assert.rejects(getActiveGame("p1", spectator), { code: "rate_limited", retryAfterMs: 60_000 });
  await assert.rejects(getActiveGame("p1", spectator), { code: "rate_limited" }, "fails fast during its own cooldown");
  assert.equal((await getSummonerByPuuid("p1")).summonerLevel, 30, "an immediate na1 profile request is not blocked");
  assert.deepEqual(paths, ["/lol/spectator/v5/active-games/by-summoner/p1", "/lol/summoner/v4/summoners/by-puuid/p1"]);
  await assert.rejects(getActiveGame("p2", createSpectatorRequester()), { code: "rate_limited" }, "a new requester asks again");
});
