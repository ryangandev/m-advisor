import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { buildMockProfile } from "../src/fixtures/riotFixtures";
import { classifyRankChange, entryForQueue } from "../src/services/rankMath";
import {
  resetMockData, RiotApiError, setMockRankedEntry, simulateMockGameStart, simulateMockMatch,
} from "../src/services/riotData";
import { getAccountByRiotId, getRankedEntries } from "../src/utils/riotApi";
import {
  createLeagueRequester, getLeagueEntries, LEAGUE_REQUESTER_OPTIONS, LEAGUE_TIMEOUT_MS, parseLeagueEntries, rankedQueueFor,
} from "../src/utils/riotLeagueApi";

const SOLO = "RANKED_SOLO_5x5";
const FLEX = "RANKED_FLEX_SR";
const solo = { queueType: SOLO, tier: "GOLD", rank: "II", leaguePoints: 64, wins: 42, losses: 35 };
const flex = { queueType: FLEX, tier: "SILVER", rank: "I", leaguePoints: 28, wins: 17, losses: 12 };

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

function realMode(fetchImpl?: typeof fetch): void {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-secret-key";
  if (fetchImpl) globalThis.fetch = fetchImpl;
}

async function mockPuuid(gameName: string): Promise<string> {
  return (await getAccountByRiotId(gameName, "NA1")).puuid;
}

test("a well-formed body keeps every entry and drops nothing", () => {
  assert.deepEqual(parseLeagueEntries([solo, flex]), { entries: [solo, flex], dropped: 0 });
  assert.deepEqual(parseLeagueEntries([]), { entries: [], dropped: 0 });
});

test("an entry without leaguePoints is rejected, not read as 0 LP, and the other queue survives", () => {
  const { leaguePoints: _missing, ...noPoints } = flex;
  void _missing;
  assert.deepEqual(parseLeagueEntries([noPoints, solo]), { entries: [solo], dropped: 1 });
  assert.deepEqual(parseLeagueEntries([solo, { ...flex, leaguePoints: null }]), { entries: [solo], dropped: 1 });
  assert.deepEqual(parseLeagueEntries([solo, { ...flex, leaguePoints: "28" }]), { entries: [solo], dropped: 1 });
});

test("a malformed entry is dropped alone: wrong types, negatives, fractions, nulls and non-objects", () => {
  const bad = [
    { ...flex, queueType: 5 }, { ...flex, tier: undefined }, { ...flex, rank: null }, { ...flex, leaguePoints: -1 },
    { ...flex, leaguePoints: 1.5 }, { ...flex, wins: undefined }, { ...flex, losses: -2 }, null, "flex", 7, [flex],
  ];
  assert.deepEqual(parseLeagueEntries([solo, ...bad]), { entries: [solo], dropped: bad.length });
});

test("a body that is not an array, or whose every entry is malformed, is an invalid_response error", () => {
  for (const body of [null, {}, "x", 5, { entries: [solo] }]) {
    assert.throws(() => parseLeagueEntries(body), { code: "invalid_response" });
  }
  // An empty answer would read as an unranked account, so an array of only garbage must not become one.
  assert.throws(() => parseLeagueEntries([{ ...solo, leaguePoints: undefined }, null]), { code: "invalid_response" });
});

test("the queue IDs map to the league-v4 queue types", () => {
  assert.equal(rankedQueueFor(420), SOLO);
  assert.equal(rankedQueueFor(440), FLEX);
  assert.equal(rankedQueueFor(400), null);
});

test("a real request goes to na1 league-v4 by PUUID with the key in the header and returns the parsed entries", async () => {
  const seen: { url: string; token: string | undefined }[] = [];
  realMode((async (input, init) => {
    seen.push({ url: input.toString(), token: (init?.headers as Record<string, string>)["X-Riot-Token"] });
    return Response.json([solo, { ...flex, leaguePoints: undefined }]);
  }) as typeof fetch);
  const result = await getLeagueEntries("puuid/with space", createLeagueRequester());
  assert.deepEqual(seen, [{
    url: "https://na1.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid%2Fwith%20space", token: "test-secret-key",
  }]);
  assert.deepEqual(result, { entries: [solo], dropped: 1 });
  await assert.rejects(getLeagueEntries("  ", createLeagueRequester()), { code: "bad_request" });
  assert.equal(seen.length, 1, "an empty PUUID makes no request");
});

test("the league requester makes one attempt with a 5 second timeout and never sleeps", async () => {
  assert.deepEqual(LEAGUE_REQUESTER_OPTIONS, { timeoutMs: 5_000, maxRetries: 0, maxRetryDelayMs: 0 });
  assert.equal(LEAGUE_TIMEOUT_MS, 5_000);
  realMode();
  for (const status of [500, 502, 503]) {
    let calls = 0;
    let slept = 0;
    const request = createLeagueRequester({ fetch: (async () => { calls++; return new Response("{}", { status }); }) as typeof fetch, sleep: async () => { slept++; } });
    await assert.rejects(getLeagueEntries("p1", request), (error: unknown) => error instanceof RiotApiError && error.code === "unavailable" && error.status === status);
    assert.equal(calls, 1, `a ${status} is not retried`);
    assert.equal(slept, 0);
  }
  let calls = 0;
  const hanging = createLeagueRequester({
    timeoutMs: 20,
    fetch: ((_input, init) => { calls++; return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))); }) as typeof fetch,
  });
  await assert.rejects(getLeagueEntries("p1", hanging), { code: "timeout" });
  assert.equal(calls, 1, "a timeout is not retried");
});

test("the league requester has its own fail-fast cooldown after a 429", async () => {
  realMode();
  let clock = 1_000_000;
  let calls = 0;
  let slept = 0;
  const request = createLeagueRequester({
    now: () => clock,
    sleep: async () => { slept++; },
    fetch: (async () => { calls++; return new Response("{}", { status: 429, headers: { "Retry-After": "30" } }); }) as typeof fetch,
  });
  await assert.rejects(getLeagueEntries("p1", request), { code: "rate_limited", retryAfterMs: 30_000 });
  await assert.rejects(getLeagueEntries("p1", request), { code: "rate_limited" });
  assert.equal(calls, 1, "the second read fails at once without a request");
  assert.equal(slept, 0, "and without waiting");
  clock += 31_000;
  await assert.rejects(getLeagueEntries("p1", request), { code: "rate_limited" });
  assert.equal(calls, 2, "after the cooldown the next read goes out again");
});

test("a real failure throws and never falls back to mock data, even when mock state exists", async () => {
  process.env.RIOT_MODE = "mock";
  const puuid = await mockPuuid("MockWin");
  setMockRankedEntry(puuid, { ...solo, tier: "CHALLENGER", rank: "I", leaguePoints: 1234 });
  assert.equal((await getLeagueEntries(puuid)).entries[0].tier, "CHALLENGER");

  realMode();
  let calls = 0;
  const failing = createLeagueRequester({ fetch: (async () => { calls++; return new Response("{}", { status: 503 }); }) as typeof fetch });
  await assert.rejects(getLeagueEntries(puuid, failing), (error: unknown) =>
    error instanceof RiotApiError && error.code === "unavailable" && error.status === 503 && !error.simulated);
  const timedOut = createLeagueRequester({ fetch: (async () => { throw new Error("down"); }) as typeof fetch });
  await assert.rejects(getLeagueEntries(puuid, timedOut), { code: "network" });
  assert.equal(calls, 1);

  // A real answer is what the caller gets, not the mock state of the same PUUID.
  const real = createLeagueRequester({ fetch: (async () => Response.json([solo])) as typeof fetch });
  assert.deepEqual((await getLeagueEntries(puuid, real)).entries, [solo]);
  assert.throws(() => setMockRankedEntry(puuid, solo), { code: "mock_only" });
});

test("mock mode serves labeled mock entries seeded from the fixture profile", async () => {
  const puuid = await mockPuuid("MockWin");
  assert.deepEqual(await getLeagueEntries(puuid), { entries: [solo, flex], dropped: 0 });
  assert.deepEqual(await getRankedEntries(puuid), [solo, flex]);
  const unranked = await mockPuuid("MockUnranked");
  assert.deepEqual(await getLeagueEntries(unranked), { entries: [], dropped: 0 });
  // The lookup itself fails with the simulated 503, but it registers the profile, which keeps failing afterwards.
  await assert.rejects(getAccountByRiotId("MockService", "NA1"), { status: 503 });
  const broken = buildMockProfile("MockService", "NA1").account.puuid;
  await assert.rejects(getLeagueEntries(broken), (error: unknown) => error instanceof RiotApiError && error.status === 503 && error.simulated);
});

test("a mock win moves solo LP by +22 and counts a win; flex does not move", async () => {
  const puuid = await mockPuuid("MockWin");
  simulateMockMatch(puuid, "win");
  const entries = (await getLeagueEntries(puuid)).entries;
  assert.deepEqual(entryForQueue(entries, SOLO), { ...solo, leaguePoints: 86, wins: 43 });
  assert.deepEqual(entryForQueue(entries, FLEX), flex);
  assert.deepEqual(await getRankedEntries(puuid), entries, "/profile shows the same mock state");
});

test("a mock loss moves solo LP by -19 and counts a loss", async () => {
  const puuid = await mockPuuid("MockLoss");
  simulateMockMatch(puuid, "loss");
  assert.deepEqual(entryForQueue((await getLeagueEntries(puuid)).entries, SOLO), { ...solo, leaguePoints: 45, losses: 36 });
});

test("mock LP rolls over divisions and tiers, and the read-diff-classify path sees one attributable game", async () => {
  const puuid = await mockPuuid("MockWin");
  setMockRankedEntry(puuid, { ...solo, tier: "GOLD", rank: "I", leaguePoints: 90 });
  const before = entryForQueue((await getLeagueEntries(puuid)).entries, SOLO);
  simulateMockMatch(puuid, "win");
  const after = entryForQueue((await getLeagueEntries(puuid)).entries, SOLO);
  assert.deepEqual(after, { ...solo, tier: "PLATINUM", rank: "IV", leaguePoints: 12, wins: 43 });
  assert.deepEqual(classifyRankChange(before, after), { kind: "promoted", delta: 22, before, after });

  setMockRankedEntry(puuid, { ...solo, tier: "GOLD", rank: "IV", leaguePoints: 5 });
  const lowBefore = entryForQueue((await getLeagueEntries(puuid)).entries, SOLO);
  simulateMockMatch(puuid, "loss");
  const lowAfter = entryForQueue((await getLeagueEntries(puuid)).entries, SOLO);
  assert.equal(lowAfter?.tier, "SILVER");
  assert.equal(classifyRankChange(lowBefore, lowAfter).kind, "demoted");
});

test("two mock games before one read are unattributable, and a read with no game since is pending", async () => {
  const puuid = await mockPuuid("MockWin");
  const before = entryForQueue((await getLeagueEntries(puuid)).entries, SOLO);
  assert.deepEqual(classifyRankChange(before, entryForQueue((await getLeagueEntries(puuid)).entries, SOLO)), { kind: "pending" });
  simulateMockMatch(puuid, "win");
  simulateMockMatch(puuid, "loss");
  assert.equal(classifyRankChange(before, entryForQueue((await getLeagueEntries(puuid)).entries, SOLO)).kind, "unattributable");
});

test("an unranked mock account stays unranked after a game, and a placed entry can be set for tests", async () => {
  const puuid = await mockPuuid("MockUnranked");
  simulateMockMatch(puuid, "win");
  assert.deepEqual((await getLeagueEntries(puuid)).entries, []);
  const placed = { queueType: SOLO, tier: "GOLD", rank: "IV", leaguePoints: 42, wins: 5, losses: 5 };
  setMockRankedEntry(puuid, placed);
  assert.deepEqual((await getLeagueEntries(puuid)).entries, [placed]);
  assert.deepEqual(classifyRankChange(null, placed), { kind: "placed", after: placed });
});

test("each member of a mock game moves by their own team's result", async () => {
  const friend = await mockPuuid("MockWin");
  const rival = await mockPuuid("MockAlt");
  simulateMockGameStart([friend], [rival]);
  simulateMockMatch(friend, "win");
  assert.equal(entryForQueue((await getLeagueEntries(friend)).entries, SOLO)?.leaguePoints, 86);
  const other = entryForQueue((await getLeagueEntries(rival)).entries, SOLO);
  assert.equal(other?.leaguePoints, 45);
  assert.equal(other?.losses, 36);
});

test("resetMockData puts the mock ranked state back to the fixtures", async () => {
  const puuid = await mockPuuid("MockWin");
  simulateMockMatch(puuid, "win");
  setMockRankedEntry(puuid, { ...flex, leaguePoints: 99 });
  resetMockData();
  assert.deepEqual((await getLeagueEntries(await mockPuuid("MockWin"))).entries, [solo, flex]);
});

// Keep this test last: it leaves the default league requester in a 429 cooldown for the rest of the process.
test("an LP 429 never delays a call through the shared requester", async () => {
  const seen: string[] = [];
  realMode((async (input) => {
    const url = input.toString();
    seen.push(url);
    if (url.includes("/league/v4/")) {
      if (url.includes("/by-puuid/lp")) return new Response("{}", { status: 429, headers: { "Retry-After": "60" } });
      return Response.json([solo]);
    }
    return Response.json([solo]);
  }) as typeof fetch);
  await assert.rejects(getLeagueEntries("lp"), { code: "rate_limited", retryAfterMs: 60_000 });
  // /profile reads ranked entries through the shared requester: it must still go out, at once, and succeed.
  const started = Date.now();
  assert.deepEqual(await getRankedEntries("profile-account"), [solo]);
  assert.ok(Date.now() - started < 1_000, "the shared call did not wait for the LP cooldown");
  assert.equal(seen.length, 2, "both requests reached fetch");
  // And the default league requester is now fail-fast: no third request.
  await assert.rejects(getLeagueEntries("lp"), { code: "rate_limited" });
  assert.equal(seen.length, 2);
});
