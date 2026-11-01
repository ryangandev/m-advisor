import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { pollLatestMatchId } from "../src/services/gameMonitor";
import { RiotApiError } from "../src/services/riotData";
import { getLatestSRMatchId } from "../src/utils/riotMatchApi";
import { withoutRiotPacing } from "./helpers/unpacedRiot";

const originalMode = process.env.RIOT_MODE;
const originalKey = process.env.RIOT_API_KEY;
const originalFetch = globalThis.fetch;
let requests = 0;

withoutRiotPacing();

beforeEach(() => {
  process.env.RIOT_MODE = "real";
  process.env.RIOT_API_KEY = "test-key";
  requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response(null, { status: 503 }); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.RIOT_MODE;
  else process.env.RIOT_MODE = originalMode;
  if (originalKey === undefined) delete process.env.RIOT_API_KEY;
  else process.env.RIOT_API_KEY = originalKey;
});

test("the poll's latest-match read sends one request during a Riot outage", async () => {
  await assert.rejects(pollLatestMatchId("p1"), (error) => error instanceof RiotApiError && error.status === 503);
  assert.equal(requests, 1);
});

test("a read with the requester's default retries sends three", { timeout: 10_000 }, async () => {
  await assert.rejects(getLatestSRMatchId("p1"), (error) => error instanceof RiotApiError && error.status === 503);
  assert.equal(requests, 3);
});

test("a new match's detail keeps the requester's retries inside the same poll", { timeout: 10_000 }, async () => {
  const sent: string[] = [];
  let detailAttempts = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const pathname = new URL(input.toString()).pathname;
    sent.push(pathname.split("/").at(-1)!);
    if (pathname.endsWith("/ids")) return Response.json(["NA1_9"]);
    if (++detailAttempts === 1) return new Response(null, { status: 503 });
    return Response.json({ metadata: { matchId: "NA1_9" }, info: { queueId: 420, participants: [{ puuid: "p1", teamId: 100, win: true }] } });
  }) as typeof fetch;
  assert.equal(await pollLatestMatchId("p-detail-retry"), "NA1_9");
  assert.deepEqual(sent, ["ids", "NA1_9", "NA1_9"], "the list is asked once and the detail is retried after the 503");
});

test("the poll still sends one request for the ID list when it fails", async () => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests++;
    return new Response(null, { status: new URL(input.toString()).pathname.endsWith("/ids") ? 503 : 200 });
  }) as typeof fetch;
  await assert.rejects(pollLatestMatchId("p-list-once"), (error) => error instanceof RiotApiError && error.status === 503);
  assert.equal(requests, 1);
});
