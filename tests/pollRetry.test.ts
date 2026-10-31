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
