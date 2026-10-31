import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { getAccountByRiotId } from "../src/utils/riotApi";
import { getLatestSRMatchId, getMatchDetail, parseMatchDetail } from "../src/utils/riotMatchApi";
import { resetMockData, riotFetch, simulateMockMatch } from "../src/services/riotData";
import { appealCustomId } from "../src/utils/whyEmbed";

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

const PUUID = "MOCK-5e7ea810428d3650bd9a91c2";
const DISCORD_USER = "123456789012345678";

// Mock match IDs (#38): the stable and the LP store keep a game by its ID and silently skip one they already hold.

test("mock match IDs never repeat across restarts and stay inside the 40 characters an appeal button allows", () => {
  const loader = createRequire(__filename);
  const file = loader.resolve("../src/services/riotData.ts");
  const saved = loader.cache[file];
  const ids: string[] = [];
  try {
    // Three "processes": each loads the module afresh, so its counters start at 0 like a restarted bot's.
    for (let boot = 0; boot < 3; boot++) {
      delete loader.cache[file];
      const fresh = loader(file) as typeof import("../src/services/riotData");
      ids.push(fresh.simulateMockMatch(PUUID, "win").matchId, fresh.simulateMockGameStart([PUUID]).matchId);
    }
  } finally {
    if (saved) loader.cache[file] = saved;
    else delete loader.cache[file];
  }
  assert.equal(new Set(ids).size, ids.length, `no ID repeats: ${ids.join(", ")}`);
  for (const matchId of ids) {
    assert.match(matchId, /^MOCK_/);
    assert.ok(appealCustomId({ mock: true, discordUserId: DISCORD_USER, matchId }), `${matchId} fits an appeal button`);
  }
});

test("a thousand simulated games in one run still produce IDs that fit an appeal button", () => {
  const seen = new Set<string>();
  let last = "";
  for (let game = 0; game < 1_100; game++) {
    last = simulateMockMatch(PUUID, game % 2 ? "win" : "loss").matchId;
    seen.add(last);
  }
  assert.equal(seen.size, 1_100);
  assert.ok(last.length <= 40, last);
  assert.ok(appealCustomId({ mock: true, discordUserId: DISCORD_USER, matchId: last }));
});

test("the baseline match keeps its own ID shape, and a simulated game becomes the account's latest", async () => {
  const account = await getAccountByRiotId("MockWin", "NA1");
  assert.match((await getLatestSRMatchId(account.puuid))!, /^MOCK_MOCK-[0-9a-f]{24}_\d+_BASELINE$/);
  const { matchId } = simulateMockMatch(account.puuid, "loss");
  assert.equal(await getLatestSRMatchId(account.puuid), matchId);
});

// Team IDs (#43): a missing team ID must not put all ten players on one team.

type RawMatch = { info: { queueId: number; participants: Array<Record<string, unknown>> } };

async function rawBaselineMatch(): Promise<{ matchId: string; raw: RawMatch }> {
  const account = await getAccountByRiotId("MockWin", "NA1");
  const matchId = (await getLatestSRMatchId(account.puuid))!;
  const raw = await riotFetch<RawMatch>(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`);
  return { matchId, raw };
}

test("a Summoner's Rift participant on a team other than 100 or 200 is an invalid response", async () => {
  const { matchId, raw } = await rawBaselineMatch();
  assert.equal(parseMatchDetail(raw, matchId).info.participants.length, 10, "the fixture itself is valid");
  const invalid = { code: "invalid_response" };
  const withTeams = (teamOf: (index: number) => unknown) => ({
    ...raw, info: { ...raw.info, participants: raw.info.participants.map((player, index) => ({ ...player, teamId: teamOf(index) })) },
  });
  const original = (index: number) => raw.info.participants[index].teamId;
  assert.throws(() => parseMatchDetail(withTeams(() => undefined), matchId), invalid, "teamId missing for everyone");
  assert.throws(() => parseMatchDetail(withTeams((index) => index === 3 ? 0 : original(index)), matchId), invalid, "one participant without a team");
  assert.throws(() => parseMatchDetail(withTeams((index) => index === 3 ? 300 : original(index)), matchId), invalid, "an unknown team");
  assert.throws(() => parseMatchDetail(withTeams(() => 100), matchId), invalid, "ten players on one team");
  assert.throws(() => parseMatchDetail(withTeams((index) => index < 6 ? 100 : 200), matchId), invalid, "six against four");
});

test("a mode without two teams, such as Arena, still parses because it is never ranked or announced", async () => {
  const { matchId, raw } = await rawBaselineMatch();
  const arena = { ...raw, info: { ...raw.info, queueId: 1700, participants: raw.info.participants.map((player, index) => ({ ...player, teamId: 100 * (1 + Math.floor(index / 2)) })) } };
  assert.equal(parseMatchDetail(arena, matchId).info.participants.length, 10);
  const missing = { ...raw, info: { ...raw.info, queueId: 450, participants: raw.info.participants.map((player) => ({ ...player, teamId: undefined })) } };
  assert.equal(parseMatchDetail(missing, matchId).info.participants[0].teamId, 0);
});

// Latest SR lookup and the match cache (#42).

/** A real-mode Riot whose match-v5 answers are counted, with each match in the queue named by its ID (420 otherwise). */
function countingRiot(queues: Record<string, number>, history: string[]): { details: string[]; idLists: number } {
  const state = { details: [] as string[], idLists: 0 };
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  globalThis.fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname.endsWith("/ids")) { state.idLists++; return Response.json(history); }
    const matchId = decodeURIComponent(pathname.split("/").at(-1)!);
    state.details.push(matchId);
    return Response.json({
      metadata: { matchId },
      info: { queueId: queues[matchId] ?? 420, participants: [{ puuid: "p", teamId: 100, win: true }, { puuid: "q", teamId: 200 }] },
    });
  };
  return state;
}

test("the latest Summoner's Rift lookup remembers each match's queue, so skipped modes and the found match are not fetched again", async () => {
  const riot = countingRiot({ ARAM_NEW: 450, ARAM_MID: 450 }, ["ARAM_NEW", "ARAM_MID", "SR_FOUND", "SR_OLDER"]);
  assert.equal(await getLatestSRMatchId("lookup-puuid"), "SR_FOUND");
  assert.deepEqual(riot.details, ["ARAM_NEW", "ARAM_MID", "SR_FOUND"], "newest first, and nothing past the first supported match");

  // Push the details out of the 200-entry cache; the remembered queues outlast them.
  for (let index = 0; index < 200; index++) await getMatchDetail(`FILLER_${index}`);
  riot.details.length = 0;
  assert.equal(await getLatestSRMatchId("lookup-puuid"), "SR_FOUND");
  assert.deepEqual(riot.details, [], "a repeat poll costs only the ID list");
  assert.equal(riot.idLists, 2);
  assert.equal((await getMatchDetail("SR_FOUND")).info.queueId, 420, "the detail itself is fetched when it is wanted");
  assert.deepEqual(riot.details, ["SR_FOUND"]);
});

test("the match detail cache evicts the least recently used entry, not the oldest", async () => {
  const riot = countingRiot({}, []);
  await getMatchDetail("HOT");
  for (let index = 0; index < 199; index++) await getMatchDetail(`COLD_${index}`);
  await getMatchDetail("HOT");
  await getMatchDetail("NEWCOMER");
  assert.equal(riot.details.length, 201);
  riot.details.length = 0;
  await getMatchDetail("HOT");
  assert.deepEqual(riot.details, [], "HOT was used last, so the newcomer evicted COLD_0 instead");
  await getMatchDetail("COLD_0");
  assert.deepEqual(riot.details, ["COLD_0"]);
});

// One attempt per Riot request for a caller whose next poll is the retry (#156).

test("the latest-match and match-detail helpers make one attempt per request with retry false", async () => {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  const sent: string[] = [];
  let failing: (pathname: string) => boolean = () => true;
  globalThis.fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    sent.push(pathname.split("/").at(-1)!);
    if (failing(pathname)) return new Response(null, { status: 503 });
    if (pathname.endsWith("/ids")) return Response.json(["NA1_ONCE"]);
    return Response.json({ metadata: { matchId: "NA1_ONCE" }, info: { queueId: 420, participants: [{ puuid: "p", teamId: 100, win: true }] } });
  };
  await assert.rejects(getLatestSRMatchId("once-puuid", { retry: false }), { code: "unavailable", status: 503 });
  assert.deepEqual(sent, ["ids"], "the ID list is asked once");

  sent.length = 0;
  failing = (pathname) => !pathname.endsWith("/ids");
  await assert.rejects(getLatestSRMatchId("once-puuid", { retry: false }), { code: "unavailable" });
  assert.deepEqual(sent, ["ids", "NA1_ONCE"], "and so is the match detail it needs");

  sent.length = 0;
  globalThis.fetch = async () => { sent.push("detail"); throw new Error("offline"); };
  await assert.rejects(getMatchDetail("NA1_ONCE", { retry: false }), { code: "network" });
  assert.deepEqual(sent, ["detail"]);
});
