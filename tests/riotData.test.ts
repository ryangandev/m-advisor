import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getAccountByRiotId, getRankedEntries, getSummonerByPuuid } from "../src/utils/riotApi";
import { getLatestSRMatchId, getMatchDetail, parseMatchDetail, SR_QUEUE_IDS } from "../src/utils/riotMatchApi";
import { createRiotRequester, getRiotDataLabel, getRiotMode, isMockData, resetMockData, RiotApiError, simulateMockMatch } from "../src/services/riotData";

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

test("public mock profile and match flow works with no key or network", async () => {
  globalThis.fetch = async () => { throw new Error("mock flows must not call network"); };
  assert.equal(getRiotMode(), "mock");
  assert.equal(isMockData(), true);
  assert.match(getRiotDataLabel(), /模拟数据/);
  const account = await getAccountByRiotId("MockWin", "NA1");
  const summoner = await getSummonerByPuuid(account.puuid);
  const ranks = await getRankedEntries(account.puuid);
  assert.equal(summoner.puuid, account.puuid);
  assert.equal(ranks[0].queueType, "RANKED_SOLO_5x5");
  const baseline = await getLatestSRMatchId(account.puuid);
  assert.ok(baseline?.startsWith("MOCK_"));
  const match = await getMatchDetail(baseline!);
  assert.equal(match.info.participants.find((player) => player.puuid === account.puuid)?.win, true);
});

test("simulation becomes latest match through normal polling APIs, separately per account", async () => {
  const primary = await getAccountByRiotId("MockWin", "NA1");
  const alt = await getAccountByRiotId("MockAlt", "NA1");
  const original = await getLatestSRMatchId(primary.puuid);
  const altOriginal = await getLatestSRMatchId(alt.puuid);
  const simulated = simulateMockMatch(primary.puuid, "loss");
  assert.notEqual(simulated.matchId, original);
  assert.equal(await getLatestSRMatchId(primary.puuid), simulated.matchId);
  assert.equal(await getLatestSRMatchId(alt.puuid), altOriginal);
  const match = await getMatchDetail(simulated.matchId);
  assert.equal(match.info.participants.find((player) => player.puuid === primary.puuid)?.win, false);
  const kla = (player: typeof match.info.participants[number]) => (player.kills + player.assists) / Math.max(1, player.deaths);
  const topKda = [...match.info.participants].sort((a, b) => kla(b) - kla(a))[0];
  assert.equal(topKda.win, true, "fixture reproduces enemy best KDA on a tracked loss");
  assert.equal(match.info.participants.filter((player) => player.position).length, 10);
  assert.ok(match.info.participants.every((player) => player.stats.goldEarned! > 0 && player.championId > 0));
});

test("unranked and arbitrary mock profiles are deterministic and safe to mutate", async () => {
  const unranked = await getAccountByRiotId("MockUnranked", "NA1");
  assert.deepEqual(await getRankedEntries(unranked.puuid), []);
  const account = await getAccountByRiotId("Ryan", "NA1");
  const repeated = await getAccountByRiotId("Ryan", "NA1");
  assert.deepEqual(account, repeated);
  const originalPuuid = account.puuid;
  account.puuid = "modified";
  assert.equal((await getAccountByRiotId("Ryan", "NA1")).puuid, originalPuuid);
  resetMockData();
  assert.equal((await getAccountByRiotId("Ryan", "NA1")).puuid, originalPuuid);
});

test("mock auth, rate-limit, service and missing-account errors are explicitly simulated", async () => {
  for (const [name, status] of [["MockAuth", 401], ["MockRateLimit", 429], ["MockService", 503], ["MockMissing", 404]] as const) {
    await assert.rejects(getAccountByRiotId(name, "NA1"), (error: unknown) => {
      assert.ok(error instanceof RiotApiError);
      assert.equal(error.status, status);
      assert.equal(error.simulated, true);
      assert.match(error.message, /模拟数据/);
      if (status === 429) assert.equal(error.retryAfterMs, 1000);
      return true;
    });
  }
});

test("real mode and invalid mode never fall back to fixtures", async () => {
  process.env.RIOT_MODE = "real";
  assert.equal(isMockData(), false);
  await assert.rejects(getAccountByRiotId("MockWin", "NA1"), { code: "missing_key" });
  assert.throws(() => simulateMockMatch("anything", "win"), { code: "mock_only" });
  process.env.RIOT_MODE = "typo";
  assert.throws(() => getRiotMode(), { code: "invalid_mode" });
  await assert.rejects(getAccountByRiotId("MockWin", "NA1"), { code: "invalid_mode" });
});

test("public real lookup exposes authentication failure instead of mock data", async () => {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-secret";
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response(null, { status: 401 }); };
  await assert.rejects(getAccountByRiotId("MockWin", "NA1"), { code: "unauthorized", status: 401, simulated: false });
  assert.equal(attempts, 1);
});

test("public real stats normalize omitted zero values and cache immutable match details", async () => {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  let matchRequests = 0;
  globalThis.fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname.includes("/entries/")) return Response.json([{ queueType: "RANKED_SOLO_5x5", tier: "IRON", rank: "IV" }]);
    if (pathname.includes("/summoners/")) return Response.json({ puuid: "real-puuid", summonerLevel: 30 });
    matchRequests++;
    return Response.json({ metadata: { matchId: "NA1_OMITTED_STATS" }, info: { queueId: 420, participants: [{ puuid: "real-puuid", teamId: 100 }] } });
  };
  assert.equal((await getSummonerByPuuid("real-puuid")).profileIconId, 0);
  assert.deepEqual((await getRankedEntries("real-puuid"))[0], { queueType: "RANKED_SOLO_5x5", tier: "IRON", rank: "IV", leaguePoints: 0, wins: 0, losses: 0 });
  const first = await getMatchDetail("NA1_OMITTED_STATS");
  assert.deepEqual(first.info.participants[0], {
    puuid: "real-puuid", riotIdGameName: "", championId: 0, championName: "", position: null,
    teamId: 100, kills: 0, deaths: 0, assists: 0, win: false, stats: {},
  });
  assert.deepEqual(first.info.teams, []);
  assert.equal(first.info.earlySurrender, false);
  first.info.participants[0].kills = 99;
  assert.equal((await getMatchDetail("NA1_OMITTED_STATS")).info.participants[0].kills, 0);
  assert.equal(matchRequests, 1);
});

test("match parsing marks games stopped without a result as aborted", () => {
  const participant = (puuid: string, teamId: number, win: boolean) => ({ puuid, teamId, win, championId: 1, championName: "Annie" });
  const parse = (endOfGameResult: string | undefined, win: boolean) => parseMatchDetail({
    metadata: { matchId: "NA1_END" },
    info: { queueId: 420, gameDuration: 1500, endOfGameResult, participants: [participant("a", 100, win), participant("b", 200, false)] },
  }, "NA1_END").info.aborted;
  assert.equal(parse("GameComplete", true), false);
  assert.equal(parse(undefined, true), false);
  assert.equal(parse("Abort_AntiCheatExit", false), true);
  assert.equal(parse(undefined, false), true, "older data without a result field and no winner");
});

test("match parsing keeps the game end time only when it is a valid timestamp", () => {
  const parse = (gameEndTimestamp: unknown) => parseMatchDetail({
    metadata: { matchId: "NA1_TIME" },
    info: { queueId: 420, gameDuration: 1500, gameEndTimestamp, participants: [{ puuid: "a", teamId: 100, win: true }] },
  }, "NA1_TIME").info.gameEndTimestamp;
  assert.equal(parse(1_759_500_000_000), 1_759_500_000_000);
  assert.equal(parse(undefined), null);
  assert.equal(parse("1759500000000"), null);
  assert.equal(parse(0), null);
});

test("match parsing keeps scoring statistics, positions, objectives and remakes", () => {
  const detail = parseMatchDetail({
    metadata: { matchId: "NA1_FULL" },
    info: {
      queueId: 420, gameDuration: 1500,
      teams: [{ teamId: 100, objectives: { dragon: { kills: 2 }, baron: { kills: 1 }, tower: { kills: 7 } } }],
      participants: [{
        puuid: "p1", teamId: 100, win: true, championId: 412, championName: "Thresh", teamPosition: "", individualPosition: "UTILITY",
        kills: 1, deaths: 2, assists: 20, goldEarned: 8000, visionScore: 80, totalDamageTaken: "not a number",
        gameEndedInEarlySurrender: true,
        challenges: { effectiveHealAndShielding: 5000, maxCsAdvantageOnLaneOpponent: 3, kda: 10.5 },
      }],
    },
  }, "NA1_FULL");
  const [player] = detail.info.participants;
  assert.equal(player.position, "UTILITY", "falls back to the individual position");
  assert.deepEqual(player.stats, { goldEarned: 8000, visionScore: 80, effectiveHealAndShielding: 5000, maxCsAdvantageOnLaneOpponent: 3 });
  assert.deepEqual(detail.info.teams, [{ teamId: 100, dragon: 2, baron: 1, riftHerald: 0, tower: 7 }]);
  assert.equal(detail.info.earlySurrender, true);
});

test("real auth uses header, removes query credentials and prevents redirects", async () => {
  const requester = createRiotRequester({
    apiKey: () => "test-secret",
    fetch: (async (input, init) => {
      assert.equal(new URL(input.toString()).searchParams.has("api_key"), false);
      assert.deepEqual(init?.headers, { "X-Riot-Token": "test-secret" });
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ puuid: "real-account" });
    }) as typeof fetch,
  });
  assert.deepEqual(await requester("https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Ryan/NA1?api_key=old-secret"), { puuid: "real-account" });
  await assert.rejects(requester("https://example.com/"), { code: "bad_request" });
});

test("auth failure is not retried and upstream diagnostics cannot expose the key", async () => {
  let attempts = 0;
  const requester = createRiotRequester({
    apiKey: () => "test-secret", sleep: async () => assert.fail("authentication errors must not retry"),
    fetch: (async () => { attempts++; return new Response("diagnostic test-secret", { status: 403 }); }) as typeof fetch,
  });
  await assert.rejects(requester("https://na1.api.riotgames.com/test"), (error: unknown) => {
    assert.ok(error instanceof RiotApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "forbidden");
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
  assert.equal(attempts, 1);
});

test("short Retry-After is honored before retrying 429", async () => {
  let attempts = 0;
  let clock = 1000;
  const sleeps: number[] = [];
  const requester = createRiotRequester({
    apiKey: () => "test", now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    fetch: (async () => ++attempts === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
      : Response.json({ ok: true })) as typeof fetch,
  });
  assert.deepEqual(await requester("https://na1.api.riotgames.com/test"), { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("long Retry-After halts all endpoints in that region without early retries", async () => {
  let attempts = 0;
  const requester = createRiotRequester({
    apiKey: () => "test", now: () => 1000,
    sleep: async () => assert.fail("long cooldown should be returned to caller"),
    fetch: (async () => { attempts++; return new Response(null, { status: 429, headers: { "Retry-After": "60" } }); }) as typeof fetch,
  });
  await assert.rejects(requester("https://na1.api.riotgames.com/profile"), { code: "rate_limited", retryAfterMs: 60_000 });
  await assert.rejects(requester("https://na1.api.riotgames.com/match"), { code: "rate_limited", retryAfterMs: 60_000 });
  assert.equal(attempts, 1);
});

test("service and network retries are bounded with backoff", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const requester = createRiotRequester({
    apiKey: () => "test", sleep: async (ms) => { sleeps.push(ms); },
    fetch: (async () => { attempts++; return new Response(null, { status: 503 }); }) as typeof fetch,
  });
  await assert.rejects(requester("https://na1.api.riotgames.com/test"), { code: "unavailable", status: 503 });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  const offlineRequester = createRiotRequester({
    apiKey: () => "test-secret", maxRetries: 0,
    fetch: (async () => { throw new Error("network error includes test-secret"); }) as typeof fetch,
  });
  await assert.rejects(offlineRequester("https://na1.api.riotgames.com/test"), (error: unknown) => {
    assert.ok(error instanceof RiotApiError);
    assert.equal(error.code, "network");
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test("malformed successful response becomes a structured error", async () => {
  const requester = createRiotRequester({
    apiKey: () => "test", fetch: (async () => new Response("not JSON", { status: 200 })) as typeof fetch,
  });
  await assert.rejects(requester("https://na1.api.riotgames.com/test"), { code: "invalid_response" });
});

test("timeouts abort real requests and report a safe structured error", async () => {
  const keepAlive = setTimeout(() => undefined, 50);
  try {
    const requester = createRiotRequester({
      apiKey: () => "test-secret", timeoutMs: 5, maxRetries: 0,
      fetch: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout test-secret")), { once: true });
      })) as typeof fetch,
    });
    await assert.rejects(requester("https://na1.api.riotgames.com/test"), { code: "timeout" });
  } finally { clearTimeout(keepAlive); }
});

test("supported queues include current Quickplay and Swiftplay", () => {
  assert.ok(SR_QUEUE_IDS.includes(480));
  assert.ok(SR_QUEUE_IDS.includes(490));
  assert.ok(!SR_QUEUE_IDS.includes(450));
});
