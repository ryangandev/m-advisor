import assert from "node:assert/strict";
import { test } from "node:test";
import { PacingRejection, RIOT_PACING_WINDOWS, RiotPacer } from "../src/services/riotPacing";
import type { AcquireOptions, PacingSlot, RiotPacerOptions } from "../src/services/riotPacing";
import { createRiotRequester, RiotApiError } from "../src/services/riotData";
import { fakeClock, idle, settle } from "./helpers/fakeClock";
import type { FakeClock } from "./helpers/fakeClock";

const AMERICAS = "americas.api.riotgames.com";
const NA1 = "na1.api.riotgames.com";
const [SHORT, LONG] = RIOT_PACING_WINDOWS;

function pacer(clock: FakeClock, options: RiotPacerOptions = {}): RiotPacer {
  return new RiotPacer({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, stopping: () => false, ...options });
}

/** Starts a request for a turn and records when it was granted or why it was refused. */
function ask(target: RiotPacer, clock: FakeClock, host = AMERICAS, options: AcquireOptions = {}) {
  const state: { grantedAt?: number; slot?: PacingSlot; error?: unknown } = {};
  target.acquire(host, options).then((slot) => { state.grantedAt = clock.now(); state.slot = slot; }, (error: unknown) => { state.error = error; });
  return state;
}

/** Sends `count` requests spread out enough that the short window never holds them up. */
async function spread(target: RiotPacer, clock: FakeClock, count: number, options: AcquireOptions = {}, host = AMERICAS): Promise<void> {
  for (let index = 0; index < count; index++) {
    const turn = ask(target, clock, host, options);
    await idle(1);
    assert.equal(turn.grantedAt, clock.now(), `request ${index + 1} goes at once`);
    clock.advance(SHORT.windowMs / SHORT.bulkLimit + 1);
  }
}

test("the pacing windows stay under the development key's 20 per second and 100 per 2 minutes", () => {
  assert.deepEqual(RIOT_PACING_WINDOWS.map((window) => window.riotSeconds), [1, 120]);
  assert.ok(SHORT.limit < 20 && SHORT.windowMs > 1_000);
  assert.ok(LONG.limit < 100 && LONG.windowMs > 120_000);
  for (const window of RIOT_PACING_WINDOWS) assert.ok(window.bulkLimit < window.limit, "bulk never gets the whole window");
});

test("requests past the short window's limit wait until its oldest request leaves the window", async () => {
  const clock = fakeClock(1_000);
  const target = pacer(clock);
  const turns = Array.from({ length: SHORT.limit + 1 }, () => ask(target, clock));
  await idle(1);
  assert.equal(turns.filter((turn) => turn.grantedAt === 1_000).length, SHORT.limit, "the limit goes at once");
  assert.equal(turns.at(-1)!.grantedAt, undefined, "the next one waits instead of being sent");
  clock.advance(SHORT.windowMs - 1);
  await idle(1);
  assert.equal(turns.at(-1)!.grantedAt, undefined);
  clock.advance(1);
  await idle(1);
  assert.equal(turns.at(-1)!.grantedAt, 1_000 + SHORT.windowMs);
  assert.equal(target.waiting(AMERICAS), 0);
});

test("the long window holds its limit across 125 seconds, and each host has its own budget", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  await spread(target, clock, LONG.limit);
  const late = ask(target, clock);
  const otherHost = ask(target, clock, NA1);
  await idle(1);
  assert.equal(late.grantedAt, undefined, "the 91st americas request waits");
  assert.equal(otherHost.grantedAt, clock.now(), "na1 is counted apart from americas");
  await settle(clock, target.acquire(AMERICAS));
  assert.equal(late.grantedAt, LONG.windowMs, "it goes when the first request leaves the window");
});

test("bulk requests get a smaller share, so normal requests still go at once while bulk waits", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  const bulk = Array.from({ length: SHORT.bulkLimit + 1 }, () => ask(target, clock, AMERICAS, { priority: "bulk" }));
  await idle(1);
  assert.equal(bulk.filter((turn) => turn.grantedAt === 0).length, SHORT.bulkLimit);
  assert.equal(bulk.at(-1)!.grantedAt, undefined, "bulk is held at its share of the short window");
  const normal = Array.from({ length: SHORT.limit - SHORT.bulkLimit }, () => ask(target, clock));
  await idle(1);
  assert.ok(normal.every((turn) => turn.grantedAt === 0), "the rest of the window is left for normal requests");

  // Over two minutes bulk can take only its share; the remainder is always there for polling.
  const long = fakeClock();
  const paced = pacer(long);
  await spread(paced, long, LONG.bulkLimit, { priority: "bulk" });
  const moreBulk = ask(paced, long, AMERICAS, { priority: "bulk" });
  await idle(1);
  assert.equal(moreBulk.grantedAt, undefined);
  await spread(paced, long, LONG.limit - LONG.bulkLimit);
});

test("a freed turn goes to a waiting normal request before an earlier bulk one", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  const full = Array.from({ length: SHORT.limit }, () => ask(target, clock));
  await idle(1);
  const bulk = ask(target, clock, AMERICAS, { priority: "bulk" });
  const normal = ask(target, clock);
  await idle(1);
  assert.equal(target.waiting(AMERICAS), 2);
  full[0].slot!.refund();
  await idle(1);
  assert.equal(normal.grantedAt, 0, "the one freed turn goes to the poll");
  assert.equal(bulk.grantedAt, undefined, "bulk keeps waiting");
  clock.advance(SHORT.windowMs);
  await idle(1);
  assert.equal(bulk.grantedAt, SHORT.windowMs);
});

test("a request that cannot get a turn within its maximum wait is refused at once and never counted", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  for (let index = 0; index < SHORT.limit; index++) ask(target, clock);
  await idle(1);
  const refused = ask(target, clock, AMERICAS, { maxWaitMs: 100 });
  await idle(1);
  assert.ok(refused.error instanceof PacingRejection);
  assert.equal((refused.error as PacingRejection).reason, "budget");
  assert.equal((refused.error as PacingRejection).waitMs, SHORT.windowMs);
  const patient = ask(target, clock, AMERICAS, { maxWaitMs: SHORT.windowMs });
  clock.advance(SHORT.windowMs);
  await idle(1);
  assert.equal(patient.grantedAt, SHORT.windowMs, "a wait that fits is granted");
});

test("a refunded turn is given to the next waiting request", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  const turns = Array.from({ length: SHORT.limit }, () => ask(target, clock));
  await idle(1);
  const waiting = ask(target, clock);
  await idle(1);
  assert.equal(waiting.grantedAt, undefined);
  turns[0].slot!.refund();
  turns[0].slot!.refund();
  await idle(1);
  assert.equal(waiting.grantedAt, 0);
  assert.equal(ask(target, clock).grantedAt, undefined, "a second refund of the same turn gives nothing back");
});

test("Riot's own count teaches the pacer about requests it did not send, such as those from before a restart", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  target.observe(AMERICAS, "1:1,85:120");
  await spread(target, clock, LONG.limit - 85);
  const late = ask(target, clock);
  await idle(1);
  assert.equal(late.grantedAt, undefined, "Riot's 85 count against the 95");
  // A lower count, the short window's count, an unknown window and junk change nothing.
  const other = pacer(fakeClock());
  other.observe(NA1, "0:1,0:120");
  other.observe(NA1, "20:1");
  other.observe(NA1, "99:10,abc,:120,7");
  other.observe(NA1, null);
  const turns = Array.from({ length: SHORT.limit }, () => ask(other, clock, NA1));
  await idle(1);
  assert.ok(turns.every((turn) => turn.grantedAt !== undefined));
});

test("Riot's count is compared with what the pacer counted up to when the answered request was sent", async () => {
  const clock = fakeClock();
  const windows = [{ riotSeconds: 120, windowMs: 125_000, limit: 10, bulkLimit: 5 }];
  const target = pacer(clock, { windows });
  const slots = await Promise.all(Array.from({ length: 10 }, () => target.acquire(AMERICAS)));
  // The answer to the last one comes back after all ten left the window. Riot counted them when it got the request.
  clock.advance(125_001);
  target.observe(AMERICAS, "10:120", slots[9].sentAt);
  const next = ask(target, clock);
  await idle(1);
  assert.equal(next.grantedAt, clock.now(), "Riot's 10 is no news: nothing extra was counted");
  // Compared at the answer's arrival instead, the same count would have looked like ten unknown requests.
  const naive = pacer(clock, { windows });
  await Promise.all(Array.from({ length: 10 }, () => naive.acquire(AMERICAS)));
  clock.advance(125_001);
  naive.observe(AMERICAS, "10:120");
  const held = ask(naive, clock);
  await idle(1);
  assert.equal(held.grantedAt, undefined);
});

test("a huge or endless count from Riot fills the window and no more", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  target.observe(AMERICAS, "99999999999999999999999:120");
  const late = ask(target, clock);
  await idle(1);
  assert.equal(late.grantedAt, undefined);
  clock.advance(LONG.windowMs);
  await idle(1);
  assert.ok(late.grantedAt !== undefined, "the window empties on time");
});

test("after the wall clock steps back, a full window empties within its own length", async () => {
  let time = 100_000;
  const clock = fakeClock();
  const target = pacer(clock, { now: () => time });
  for (let index = 0; index < SHORT.limit; index++) await target.acquire(AMERICAS);
  time = 0;
  const waiting = target.acquire(AMERICAS);
  time = SHORT.windowMs;
  clock.runNext();
  const slot = await waiting;
  assert.equal(slot.sentAt, SHORT.windowMs, "the requests sent in the future counted as sent at the step, not 100 s ahead");
});

test("a keep-alive pacer holds the process open while a request waits; the bot's pacer never does", async () => {
  const windows = [{ riotSeconds: 120, windowMs: 60_000, limit: 1, bulkLimit: 1 }];
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  for (const [keepAlive, held] of [[true, 1], [false, 0]] as const) {
    const target = new RiotPacer({ windows, keepAlive, stopping: () => false });
    await target.acquire(AMERICAS);
    const before = timers();
    const waiting = target.acquire(AMERICAS).catch((error: unknown) => error);
    assert.equal(target.waiting(AMERICAS), 1);
    assert.equal(timers() - before, held, keepAlive ? "a ref'd timer keeps a script alive" : "an unref'd timer lets the bot exit");
    target.close();
    assert.ok(await waiting instanceof PacingRejection);
    assert.equal(timers(), before);
  }
});

test("at shutdown a waiting request is refused within a second, and so is every later one", async () => {
  const clock = fakeClock();
  let stopping = false;
  const target = pacer(clock, { stopping: () => stopping });
  await spread(target, clock, LONG.limit);
  const waiting = ask(target, clock);
  await idle(1);
  assert.equal(waiting.error, undefined);
  stopping = true;
  clock.advance(1_000);
  await idle(1);
  assert.equal((waiting.error as PacingRejection | undefined)?.reason, "stopping");
  assert.equal(target.waiting(AMERICAS), 0);
  assert.equal(clock.pending(), 0, "no timer is left behind");
  await assert.rejects(target.acquire(NA1), { reason: "stopping" });

  const closing = pacer(fakeClock());
  for (let index = 0; index < SHORT.limit; index++) closing.acquire(AMERICAS).catch(() => undefined);
  const queued = closing.acquire(AMERICAS);
  closing.close();
  await assert.rejects(queued, { reason: "stopping" });
  await assert.rejects(closing.acquire(AMERICAS), { reason: "stopping" });
});

// The requester and the pacer together.

test("every attempt of a requester takes a turn, and a refused turn is a RiotApiError without a request", async () => {
  const clock = fakeClock();
  let stopping = false;
  const target = pacer(clock, { stopping: () => stopping });
  let sent = 0;
  const failFast = createRiotRequester({
    apiKey: () => "test", now: clock.now, pacer: target, timeoutMs: 5_000, maxRetries: 0, maxRetryDelayMs: 0,
    fetch: (async () => { sent++; return Response.json({ ok: true }); }) as typeof fetch,
  });
  for (let index = 0; index < SHORT.limit; index++) await failFast("https://na1.api.riotgames.com/one");
  assert.equal(sent, SHORT.limit);
  // A requester that never waits out a cooldown waits at most its timeout for a turn: this one would wait 1.2 s.
  for (let index = 0; index < LONG.limit - SHORT.limit; index++) {
    clock.advance(SHORT.windowMs);
    await failFast("https://na1.api.riotgames.com/one");
  }
  await assert.rejects(failFast("https://na1.api.riotgames.com/one"), (error: unknown) => {
    assert.ok(error instanceof RiotApiError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.status, undefined, "Riot never answered");
    assert.ok(error.retryAfterMs! > 5_000);
    return true;
  });
  assert.equal(sent, LONG.limit, "the refused request was not sent");

  stopping = true;
  await assert.rejects(failFast("https://americas.api.riotgames.com/one"), { code: "unavailable" });
  assert.equal(sent, LONG.limit);

  // Retries take a turn each.
  const retryClock = fakeClock();
  const retrying = pacer(retryClock);
  let attempts = 0;
  const shared = createRiotRequester({
    apiKey: () => "test", pacer: retrying, sleep: async () => undefined,
    fetch: (async () => { attempts++; return new Response(null, { status: 503 }); }) as typeof fetch,
  });
  await assert.rejects(shared("https://americas.api.riotgames.com/two"), { code: "unavailable" });
  assert.equal(attempts, 3);
  const turns = Array.from({ length: SHORT.limit }, () => ask(retrying, retryClock));
  await idle(1);
  assert.equal(turns.filter((turn) => turn.grantedAt !== undefined).length, SHORT.limit - 3);
});

test("a Retry-After cooldown that starts while a request waits for its turn is still honored", async () => {
  const clock = fakeClock();
  const target = pacer(clock);
  const sentAt: Array<[string, number]> = [];
  let answerLimited: (response: Response) => void = () => undefined;
  const requester = createRiotRequester({
    apiKey: () => "test", now: clock.now, pacer: target,
    sleep: async (ms) => { clock.advance(ms); },
    fetch: (async (input: URL) => {
      sentAt.push([input.pathname, clock.now()]);
      if (input.pathname !== "/limited") return Response.json({ ok: true });
      return new Promise<Response>((resolve) => { answerLimited = resolve; });
    }) as typeof fetch,
  });
  // One request is out when the short window fills, and the next one waits for a turn.
  const limited = requester("https://americas.api.riotgames.com/limited", { retry: false });
  for (let index = 0; index < SHORT.limit - 1; index++) await requester("https://americas.api.riotgames.com/fill");
  const waiting = requester("https://americas.api.riotgames.com/after");
  await idle();
  assert.equal(target.waiting(AMERICAS), 1);
  // Riot answers the first one with a cooldown longer than the wait for the window.
  answerLimited(new Response(null, { status: 429, headers: { "Retry-After": "3" } }));
  await assert.rejects(limited, { code: "rate_limited", retryAfterMs: 3_000 });
  assert.deepEqual(await settle(clock, waiting), { ok: true });
  assert.deepEqual(sentAt.at(-1), ["/after", 3_000], "it waited out the cooldown, not only the window");
});
