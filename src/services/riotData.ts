import { setTimeout as delay } from "node:timers/promises";
import { buildMockMatch, buildMockProfile } from "../fixtures/riotFixtures";
import type { MockOutcome, MockProfile, RawMatch } from "../fixtures/riotFixtures";

export type RiotMode = "mock" | "real";
export type RiotErrorCode = "invalid_mode" | "missing_key" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "bad_request" | "network" | "timeout" | "invalid_response" | "mock_only";

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly code: RiotErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly simulated = false,
  ) {
    super(message);
    this.name = "RiotApiError";
  }
}

export function getRiotMode(): RiotMode {
  const mode = process.env.RIOT_MODE?.trim().toLowerCase() || "mock";
  if (mode !== "mock" && mode !== "real") {
    throw new RiotApiError("RIOT_MODE must be mock or real.", "invalid_mode");
  }
  return mode;
}

export function isMockData(): boolean {
  return getRiotMode() === "mock";
}

export function getRiotDataLabel(): string {
  return isMockData() ? "模拟数据 / Mock data" : "Riot 实时数据";
}

export function riotObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RiotApiError("Riot API returned an invalid response shape.", "invalid_response");
  }
  return value as Record<string, unknown>;
}

export function riotNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RiotApiError("Riot API returned an invalid numeric statistic.", "invalid_response");
  }
  return value;
}

function statusError(status: number, retryAfterMs?: number, simulated = false): RiotApiError {
  const prefix = simulated ? "模拟数据: " : "";
  const errors: Record<number, [RiotErrorCode, string]> = {
    401: ["unauthorized", "Riot API error 401: authentication required. Update RIOT_API_KEY."],
    403: ["forbidden", "Riot API error 403: access denied. Check RIOT_API_KEY and endpoint access."],
    404: ["not_found", "Riot API error 404: account or match not found."],
    429: ["rate_limited", "Riot API error 429: rate limit exceeded. Retry after the indicated delay."],
  };
  const [code, message] = errors[status] ?? (status >= 500
    ? ["unavailable", `Riot API error ${status}: service temporarily unavailable.`]
    : ["bad_request", `Riot API error ${status}: request rejected.`]);
  return new RiotApiError(`${prefix}${message}`, code, status, retryAfterMs, simulated);
}

const mockProfiles = new Map<string, MockProfile>();
const mockHistory = new Map<string, string[]>();
const mockMatches = new Map<string, RawMatch>();
let mockSequence = 0;
let mockEpoch = 0;

function rememberProfile(profile: MockProfile): MockProfile {
  const existing = mockProfiles.get(profile.account.puuid);
  if (existing) return existing;
  mockProfiles.set(profile.account.puuid, profile);
  const matchId = `MOCK_${profile.account.puuid}_${mockEpoch}_BASELINE`;
  mockMatches.set(matchId, buildMockMatch(profile, matchId, profile.outcome));
  mockHistory.set(profile.account.puuid, [matchId]);
  return profile;
}

function profileForPuuid(puuid: string): MockProfile {
  const profile = mockProfiles.get(puuid);
  if (profile) return profile;
  // Existing persisted bindings can be exercised without making any real Riot request.
  const generated = buildMockProfile(`模拟玩家${puuid.slice(-6)}`, "NA1");
  generated.account.puuid = puuid;
  generated.summoner.puuid = puuid;
  return rememberProfile(generated);
}

function checkFixtureFailure(profile: MockProfile): void {
  if (profile.failureStatus) {
    throw statusError(profile.failureStatus, profile.failureStatus === 429 ? 1000 : undefined, true);
  }
}

export function simulateMockMatch(puuid: string, outcome: MockOutcome): { matchId: string; outcome: MockOutcome } {
  if (!isMockData()) throw new RiotApiError("Simulated matches require RIOT_MODE=mock.", "mock_only");
  if (outcome !== "win" && outcome !== "loss") throw new RiotApiError("Mock outcome must be win or loss.", "bad_request");
  const profile = profileForPuuid(puuid);
  checkFixtureFailure(profile);
  const matchId = `MOCK_${puuid}_${mockEpoch}_${++mockSequence}`;
  mockMatches.set(matchId, buildMockMatch(profile, matchId, outcome));
  const history = [matchId, ...(mockHistory.get(puuid) ?? [])];
  for (const expiredId of history.slice(20)) mockMatches.delete(expiredId);
  mockHistory.set(puuid, history.slice(0, 20));
  return { matchId, outcome };
}

export function resetMockData(): void {
  mockProfiles.clear();
  mockHistory.clear();
  mockMatches.clear();
  mockSequence = 0;
  mockEpoch++;
}

function mockFetch<T>(url: string): T {
  const path = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (path.slice(0, 5).join("/") === "riot/account/v1/accounts/by-riot-id" && path.length === 7) {
    const profile = rememberProfile(buildMockProfile(path[5], path[6]));
    checkFixtureFailure(profile);
    return structuredClone(profile.account) as T;
  }
  if (path.slice(0, 5).join("/") === "lol/summoner/v4/summoners/by-puuid" && path.length === 6) {
    const profile = profileForPuuid(path[5]);
    checkFixtureFailure(profile);
    return structuredClone(profile.summoner) as T;
  }
  if (path.slice(0, 5).join("/") === "lol/league/v4/entries/by-puuid" && path.length === 6) {
    const profile = profileForPuuid(path[5]);
    checkFixtureFailure(profile);
    return structuredClone(profile.ranked) as T;
  }
  if (path.slice(0, 5).join("/") === "lol/match/v5/matches/by-puuid" && path.length === 7 && path[6] === "ids") {
    const profile = profileForPuuid(path[5]);
    checkFixtureFailure(profile);
    return [...(mockHistory.get(profile.account.puuid) ?? [])] as T;
  }
  if (path.slice(0, 4).join("/") === "lol/match/v5/matches" && path.length === 5) {
    const match = mockMatches.get(path[4]);
    if (!match) throw statusError(404, undefined, true);
    return structuredClone(match) as T;
  }
  throw new RiotApiError("模拟数据: unsupported Riot endpoint.", "bad_request", 400, undefined, true);
}

export interface RiotRequesterOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  apiKey?: () => string | undefined;
}

function retryDelay(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function createRiotRequester(options: RiotRequesterOptions = {}): <T>(url: string) => Promise<T> {
  const fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  const sleep = options.sleep ?? (async (milliseconds: number) => { await delay(milliseconds); });
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
  const cooldowns = new Map<string, number>();

  return async function request<T>(url: string): Promise<T> {
    const apiKey = (options.apiKey?.() ?? process.env.RIOT_API_KEY)?.trim();
    if (!apiKey) throw new RiotApiError("Missing RIOT_API_KEY environment variable for RIOT_MODE=real.", "missing_key");
    const target = new URL(url);
    if (target.protocol !== "https:" || !["na1.api.riotgames.com", "americas.api.riotgames.com"].includes(target.hostname)) {
      throw new RiotApiError("Unsupported Riot API host.", "bad_request");
    }
    // A key is only transmitted in the header, including if an older caller supplied api_key.
    target.searchParams.delete("api_key");
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remainingCooldown = (cooldowns.get(target.origin) ?? 0) - now();
      if (remainingCooldown > maxRetryDelayMs) throw statusError(429, remainingCooldown);
      if (remainingCooldown > 0) await sleep(remainingCooldown);
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(target, { headers: { "X-Riot-Token": apiKey }, signal, redirect: "error" });
      } catch {
        const code = signal.aborted ? "timeout" : "network";
        if (attempt === maxRetries) throw new RiotApiError(`Riot API ${code === "timeout" ? "request timed out" : "network request failed"}.`, code);
        await sleep(Math.min(1000 * 2 ** attempt, maxRetryDelayMs));
        continue;
      }
      if (response.ok) {
        try { return await response.json() as T; }
        catch { throw new RiotApiError("Riot API returned an invalid response.", signal.aborted ? "timeout" : "invalid_response"); }
      }
      const afterMs = retryDelay(response.headers.get("Retry-After"), now());
      // Response bodies may contain HTML or changing diagnostics; status alone controls error handling.
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) {
        const cooldown = afterMs ?? 1000 * 2 ** attempt;
        cooldowns.set(target.origin, Math.max(cooldowns.get(target.origin) ?? 0, now() + cooldown));
        if (attempt === maxRetries || cooldown > maxRetryDelayMs) throw statusError(429, cooldown);
        continue;
      }
      if (response.status >= 500 && attempt < maxRetries) {
        const wait = afterMs ?? 1000 * 2 ** attempt;
        if (wait > maxRetryDelayMs) throw statusError(response.status, wait);
        await sleep(wait);
        continue;
      }
      throw statusError(response.status, afterMs);
    }
    throw new RiotApiError("Riot API request did not complete.", "unavailable");
  };
}

const realFetch = createRiotRequester();

export async function riotFetch<T>(url: string): Promise<T> {
  return isMockData() ? mockFetch<T>(url) : realFetch<T>(url);
}
