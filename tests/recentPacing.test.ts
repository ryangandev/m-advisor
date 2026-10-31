import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { buildMockMatch, buildMockProfile } from "../src/fixtures/riotFixtures";
import type { BotCommand, TrackedMember } from "../src/types";
import { RiotPacer } from "../src/services/riotPacing";
import type { AcquireOptions, PacingSlot } from "../src/services/riotPacing";
import { useRiotPacer } from "../src/services/riotData";
import { getLatestSRMatchId } from "../src/utils/riotMatchApi";
import { fakeClock, settle } from "./helpers/fakeClock";
import type { FakeClock } from "./helpers/fakeClock";

/**
 * The real /recent, match helpers and shared requester against a fake Riot that enforces the development key's limits
 * (20 per 1 s and 100 per 120 s on each host, as a sliding window, which is stricter than Riot's own) on a fake clock.
 * Without pacing, one cold /recent count:10 over 10 accounts sends 110 americas requests, gets 429 with a 95 s
 * Retry-After, and locks the monitor out (#155).
 */
const loader = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
function stubModule(relativePath: string, exports: Record<string, unknown>): void {
  const file = loader.resolve(relativePath);
  savedModules.set(file, loader.cache[file]);
  loader.cache[file] = { id: file, filename: file, path: dirname(file), loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

const ACCOUNTS = 10; // MAX_ACCOUNTS_PER_GUILD
const COUNT = 10; // the largest /recent count
const members: TrackedMember[] = Array.from({ length: ACCOUNTS }, (_, index) => ({
  discordUserId: `user-${index}`,
  accounts: [{ puuid: `puuid-${index}`, gameName: `Player${index}`, tagLine: "NA1" }],
}));
stubModule("../src/store/bindingStore.ts", { listTrackedMembers: () => members });
stubModule("../src/store/announcerStore.ts", { getLastMatchId: () => undefined });
stubModule("../src/services/gameMonitor.ts", {
  POLL_INTERVAL_MS: 45_000,
  getMonitorStatus: () => ({ active: false, announced: new Set(), presentMemberIds: [] }),
});
delete loader.cache[loader.resolve("../src/commands/recent.ts")];
const recent = loader("../src/commands/recent.ts").default as BotCommand;
after(() => {
  for (const [file, original] of savedModules) {
    if (original) loader.cache[file] = original;
    else delete loader.cache[file];
  }
  delete loader.cache[loader.resolve("../src/commands/recent.ts")];
});

const RIOT_LIMITS = [{ count: 20, windowMs: 1_000 }, { count: 100, windowMs: 120_000 }];

interface FakeRiot { sent: Map<string, number[]>; rejected: number }

interface FakeRiotOptions {
  /** Requests already counted on americas 5 s ago, as after a restart. */
  before?: number;
  /** How long a request takes to reach Riot, and its answer to come back. */
  requestMs?: number;
  responseMs?: number;
  /**
   * `sliding` counts every request in the last window, which is stricter than Riot. `fixed` is how Riot counts: a
   * window starts at its first request and holds every request until it ends.
   */
  windows?: "sliding" | "fixed";
}

/** Riot on the fake clock. Match IDs carry `salt`, so one test's details are not in the cache for the next. */
function fakeRiot(clock: FakeClock, salt: string, options: FakeRiotOptions = {}): FakeRiot {
  const { before = 0, requestMs = 0, responseMs = 0, windows = "sliding" } = options;
  const riot: FakeRiot = { sent: new Map([["americas.api.riotgames.com", Array.from({ length: before }, () => clock.now() - 5_000)]]), rejected: 0 };
  const fixed = new Map<string, Array<{ start: number; count: number }>>([["americas.api.riotgames.com",
    [{ start: -Infinity, count: 0 }, { start: clock.now() - 5_000, count: before }]]]);
  const wait = (ms: number) => ms > 0 ? new Promise<void>((resolve) => { clock.setTimer(resolve, ms); }) : Promise.resolve();
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    await wait(requestMs);
    const log = riot.sent.get(url.hostname) ?? [];
    riot.sent.set(url.hostname, log);
    const now = clock.now();
    log.push(now);
    let counts: number[];
    if (windows === "sliding") {
      counts = RIOT_LIMITS.map(({ windowMs }) => log.filter((at) => at > now - windowMs).length);
    } else {
      const state = fixed.get(url.hostname) ?? RIOT_LIMITS.map(() => ({ start: -Infinity, count: 0 }));
      fixed.set(url.hostname, state);
      counts = RIOT_LIMITS.map(({ windowMs }, index) => {
        if (now >= state[index].start + windowMs) state[index] = { start: now, count: 0 };
        return ++state[index].count;
      });
    }
    const headers = { "X-App-Rate-Limit-Count": `${counts[0]}:1,${counts[1]}:120` };
    const limited = RIOT_LIMITS.some(({ count }, index) => counts[index] > count);
    await wait(responseMs);
    if (limited) {
      riot.rejected++;
      return new Response(null, { status: 429, headers: { ...headers, "Retry-After": "95" } });
    }
    const path = url.pathname.split("/").filter(Boolean);
    if (path.at(-1) === "ids") {
      const count = Number(url.searchParams.get("count"));
      return Response.json(Array.from({ length: count }, (_, index) => `NA1_${path[5]}_${salt}_${index}`), { headers });
    }
    const matchId = decodeURIComponent(path[4]);
    const profile = buildMockProfile("Tracked", "NA1");
    profile.account.puuid = "puuid-tracked";
    return Response.json(buildMockMatch(profile, matchId, "win", 1_700_000_000_000), { headers });
  }) as typeof fetch;
  return riot;
}

/** The pacer on the fake clock, recording how long each normal request waited for its turn. */
class TimedPacer extends RiotPacer {
  readonly normalWaits: number[] = [];
  constructor(private readonly clock: FakeClock) {
    super({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, stopping: () => false });
  }
  override async acquire(host: string, options: AcquireOptions = {}): Promise<PacingSlot> {
    const asked = this.clock.now();
    const slot = await super.acquire(host, options);
    if (options.priority !== "bulk") this.normalWaits.push(this.clock.now() - asked);
    return slot;
  }
}

type Reply = { embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }> };

function interaction(replies: Reply[]) {
  return {
    guildId: "pacing-guild",
    guild: { members: { cache: new Map() } },
    options: { getUser: () => null, getInteger: () => COUNT },
    deferReply: async () => undefined,
    editReply: async (payload: Reply) => { replies.push(payload); },
  } as unknown as Parameters<BotCommand["execute"]>[0];
}

const originalFetch = globalThis.fetch;
const originalMode = process.env.RIOT_MODE;
const originalKey = process.env.RIOT_API_KEY;
let clock: FakeClock;
let restorePacer: () => void;
beforeEach(() => {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  clock = fakeClock(1_000_000);
  restorePacer = useRiotPacer(new RiotPacer({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, stopping: () => false }));
});
afterEach(() => {
  restorePacer();
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.RIOT_MODE;
  else process.env.RIOT_MODE = originalMode;
  if (originalKey === undefined) delete process.env.RIOT_API_KEY;
  else process.env.RIOT_API_KEY = originalKey;
});

test("a cold /recent count:10 over 10 accounts waits for its turns, gets no 429 and never makes a poll wait for the long window", async () => {
  const riot = fakeRiot(clock, "cold");
  const replies: Reply[] = [];
  const started = clock.now();
  let replied = false;
  const command = recent.execute(interaction(replies)).finally(() => { replied = true; });

  // While /recent is waiting for turns, the monitor polls an account: it goes ahead of the waiting bulk requests.
  let pollTook: number | undefined;
  const poll = (async () => {
    while (!replied && clock.now() - started < 10_000) await new Promise((resolve) => setImmediate(resolve));
    const asked = clock.now();
    await getLatestSRMatchId("puuid-poll");
    pollTook = clock.now() - asked;
  })();
  await settle(clock, Promise.all([command, poll]));

  const americas = riot.sent.get("americas.api.riotgames.com")!;
  assert.equal(riot.rejected, 0, "Riot never answers 429");
  assert.equal(americas.length, ACCOUNTS * (COUNT + 1) + 2, "every ID list and detail once, plus the poll's ID list and newest detail");
  const fields = replies[0].embeds[0].toJSON().fields!;
  assert.equal(fields.length, ACCOUNTS);
  for (const field of fields) assert.doesNotMatch(field.value, /⚠️/, `${field.name} shows its matches, not a rate-limit notice`);
  assert.ok(pollTook !== undefined && pollTook <= 1_200, `the poll waited ${pollTook} ms, at most one short window`);
  const took = clock.now() - started;
  assert.ok(took > 120_000 && took < 260_000, `the reply came after ${took} ms, inside the 15 minutes a deferred reply allows`);
});

test("after a restart the pacer learns Riot's count from the first answer, so the requests left in the window still get no 429", async () => {
  const riot = fakeRiot(clock, "restart", { before: 85 });
  const replies: Reply[] = [];
  await settle(clock, recent.execute(interaction(replies)));
  assert.equal(riot.rejected, 0);
  for (const field of replies[0].embeds[0].toJSON().fields!) assert.doesNotMatch(field.value, /⚠️/);
});

test("with Riot's fixed windows and a slow round trip, polling never waits more than one short window behind a cold /recent", async () => {
  // Riot's 1 s window is fixed from its first request, and a 600 ms round trip shifts it against the pacer's. Syncing
  // that window from Riot's count once over-counted the long window and made polls wait 30 s or more.
  restorePacer();
  const pacer = new TimedPacer(clock);
  restorePacer = useRiotPacer(pacer);
  const riot = fakeRiot(clock, "latency", { requestMs: 100, responseMs: 500, windows: "fixed" });
  const wait = (ms: number) => new Promise<void>((resolve) => { clock.setTimer(resolve, ms); });
  const replies: Reply[] = [];
  const command = recent.execute(interaction(replies));
  // Ten accounts in voice, polled every 45 s for 6 minutes, each poll a little after the one before.
  const polls = (async () => {
    for (let round = 0; round < 8; round++) {
      await Promise.all(Array.from({ length: ACCOUNTS }, async (_, index) => {
        await wait(index * 50);
        await getLatestSRMatchId(`poll-${index}`);
      }));
      await wait(45_000);
    }
  })();
  await settle(clock, Promise.all([command, polls]));
  assert.equal(riot.rejected, 0, "Riot never answers 429");
  for (const field of replies[0].embeds[0].toJSON().fields!) assert.doesNotMatch(field.value, /⚠️/);
  assert.ok(pacer.normalWaits.length >= ACCOUNTS * 8);
  const longest = Math.max(...pacer.normalWaits);
  assert.ok(longest <= 1_200, `a poll request waited ${longest} ms for its turn`);
});

test("two cold /recent runs at once share every match detail they both need", async () => {
  const riot = fakeRiot(clock, "twice");
  const first: Reply[] = [];
  const second: Reply[] = [];
  await settle(clock, Promise.all([recent.execute(interaction(first)), recent.execute(interaction(second))]));
  assert.equal(riot.rejected, 0);
  assert.equal(riot.sent.get("americas.api.riotgames.com")!.length, 2 * ACCOUNTS + ACCOUNTS * COUNT, "each run asks its own ID lists, and the details once");
  for (const replies of [first, second]) {
    const fields = replies[0].embeds[0].toJSON().fields!;
    assert.equal(fields.length, ACCOUNTS);
    for (const field of fields) assert.doesNotMatch(field.value, /⚠️/);
  }
});
