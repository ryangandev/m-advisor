import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildMockActiveGame, buildMockMatch, buildMockProfile, buildMockTimeline } from "../fixtures/riotFixtures";
import type { MockOutcome, MockProfile, RawMatch } from "../fixtures/riotFixtures";
import type { RankedEntry } from "../types";
import { rankedQueueFor, shiftEntry } from "./rankMath";
import { PacingRejection, RiotPacer } from "./riotPacing";
import type { PacingSlot, RiotPriority } from "./riotPacing";

export type RiotMode = "mock" | "real";
export type RiotErrorCode = "invalid_mode" | "missing_key" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "bad_request" | "network" | "timeout" | "invalid_response" | "mock_only";

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly code: RiotErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly simulated = false,
    /** Riot's own `errorCode` token of a 404, when the requester was asked to read it. Never a free-form message. */
    readonly errorCode?: string,
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

function statusError(status: number, retryAfterMs?: number, simulated = false, errorCode?: string): RiotApiError {
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
  return new RiotApiError(`${prefix}${message}`, code, status, retryAfterMs, simulated, errorCode);
}

const mockProfiles = new Map<string, MockProfile>();
const mockHistory = new Map<string, string[]>();
const mockMatches = new Map<string, RawMatch>();
/**
 * Each mock account's league-v4 entries, copied from its fixture profile on first use and then moved by
 * `simulateMockMatch`. This is mock data only: real mode never reads it.
 */
const mockRanked = new Map<string, RankedEntry[]>();
/** LP a simulated ranked win gives and a loss takes away. */
export const MOCK_WIN_LP = 22;
export const MOCK_LOSS_LP = 19;
/** Matches whose account simulates a missing timeline. */
const mockTimelineMissing = new Set<string>();
/** Mock games in progress (loading), each reserving the match ID that ending it with `simulateMockMatch` reuses. */
interface MockGame { gameId: number; matchId: string; blue: string[]; red: string[] }
const mockGames = new Map<string, MockGame>();
/** Mock game IDs start far above the game IDs Riot has issued so far, so they are easy to tell apart. */
const MOCK_GAME_ID_BASE = 9_000_000_000;
let mockSequence = 0;
let mockEpoch = 0;
/**
 * Fixed per process (a base36 clock plus 16 random bits), so the IDs of simulated games never repeat after a restart:
 * the stable and the LP store keep a game by its ID and silently skip one they already hold.
 */
const MOCK_BOOT_ID = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
/** `MOCK_<boot>_<epoch>_<sequence>`: about 20 characters, far inside the 40 an appeal button allows, and independent of the PUUID. */
const mockMatchId = (): string => `MOCK_${MOCK_BOOT_ID}_${mockEpoch}_${++mockSequence}`;
/**
 * How long before its creation a mock account's history match ended. The fixture is created on the first lookup,
 * which can come after the member joined voice, so ending it "now" would make it look like a game that ended
 * after the join and announce it.
 */
const MOCK_BASELINE_AGE_MS = 24 * 3_600_000;

function rememberProfile(profile: MockProfile): MockProfile {
  const existing = mockProfiles.get(profile.account.puuid);
  if (existing) return existing;
  mockProfiles.set(profile.account.puuid, profile);
  const matchId = `MOCK_${profile.account.puuid}_${mockEpoch}_BASELINE`;
  mockMatches.set(matchId, buildMockMatch(profile, matchId, profile.outcome, Date.now() - MOCK_BASELINE_AGE_MS));
  if (profile.timelineMissing) mockTimelineMissing.add(matchId);
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

function rankedOf(puuid: string): RankedEntry[] {
  let entries = mockRanked.get(puuid);
  if (!entries) {
    entries = structuredClone(profileForPuuid(puuid).ranked);
    mockRanked.set(puuid, entries);
  }
  return entries;
}

/**
 * Moves the account's entry in the match's ranked queue by the mock LP of a win or loss, with division and tier
 * rollover, and counts the game in wins or losses. An account without an entry in that queue, or a queue without LP,
 * is left alone.
 */
function applyMockRankedResult(puuid: string, queueId: number, outcome: MockOutcome): void {
  const queueType = rankedQueueFor(queueId);
  if (!queueType) return;
  const entries = rankedOf(puuid);
  const index = entries.findIndex((entry) => entry.queueType === queueType);
  if (index < 0) return;
  const entry = entries[index];
  const won = outcome === "win";
  entries[index] = shiftEntry(entry, won ? MOCK_WIN_LP : -MOCK_LOSS_LP, {
    wins: entry.wins + (won ? 1 : 0), losses: entry.losses + (won ? 0 : 1),
  });
}

/** Replaces (or adds) the mock account's entry for the entry's queue, for tests. Mock mode only. */
export function setMockRankedEntry(puuid: string, entry: RankedEntry): void {
  if (!isMockData()) throw new RiotApiError("Mock ranked entries require RIOT_MODE=mock.", "mock_only");
  const entries = rankedOf(puuid);
  const index = entries.findIndex((existing) => existing.queueType === entry.queueType);
  if (index < 0) entries.push({ ...entry });
  else entries[index] = { ...entry };
}

function gameOf(puuid: string): MockGame | undefined {
  return [...mockGames.values()].find((game) => game.blue.includes(puuid) || game.red.includes(puuid));
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
  // Ending a mock game that has this account keeps the ID reserved when it started, so the start and the end are one match.
  const game = gameOf(puuid);
  if (game) mockGames.delete(game.matchId);
  const matchId = game?.matchId ?? mockMatchId();
  const seatOf = (member: string) => ({ puuid: member, name: profileForPuuid(member).account.gameName });
  const squads = game ? { blue: game.blue.map(seatOf), red: game.red.map(seatOf), profileTeam: game.blue.includes(puuid) ? 100 as const : 200 as const } : undefined;
  mockMatches.set(matchId, buildMockMatch(profile, matchId, outcome, Date.now(), squads));
  if (profile.timelineMissing) mockTimelineMissing.add(matchId);
  // The game ends for everyone in it: the match is the newest entry of every member's history.
  for (const member of game ? [...game.blue, ...game.red] : [puuid]) {
    profileForPuuid(member);
    // The outcome is the caller's team's; a member of the other team had the opposite result.
    const sameTeam = !game || game.blue.includes(member) === game.blue.includes(puuid);
    applyMockRankedResult(member, mockMatches.get(matchId)!.info.queueId as number, sameTeam ? outcome : outcome === "win" ? "loss" : "win");
    const history = [matchId, ...(mockHistory.get(member) ?? [])];
    for (const expiredId of history.slice(20)) {
      mockMatches.delete(expiredId);
      mockTimelineMissing.delete(expiredId);
    }
    mockHistory.set(member, history.slice(0, 20));
  }
  return { matchId, outcome };
}

/**
 * Starts a labeled mock game that is still loading. The `blue` accounts (one to five) take team 100 and the optional
 * `red` accounts (up to five) team 200, with simulated allies and enemies in the other seats. Spectator requests for
 * those accounts answer with it until `simulateMockMatch` ends it for one of them, which reuses the returned `matchId`.
 */
export function simulateMockGameStart(blue: string[], red: string[] = []): { matchId: string; gameId: number } {
  if (!isMockData()) throw new RiotApiError("Simulated games require RIOT_MODE=mock.", "mock_only");
  const everyone = [...blue, ...red];
  if (blue.length < 1 || blue.length > 5 || red.length > 5 || new Set(everyone).size !== everyone.length || everyone.some((puuid) => !puuid.trim())) {
    throw new RiotApiError("A mock game needs one to five distinct accounts on team 100 and up to five more on team 200.", "bad_request");
  }
  for (const puuid of everyone) {
    checkFixtureFailure(profileForPuuid(puuid));
    if (gameOf(puuid)) throw new RiotApiError("An account is already in a mock game.", "bad_request");
  }
  const matchId = mockMatchId();
  const gameId = MOCK_GAME_ID_BASE + mockEpoch * 1_000_000 + mockSequence;
  mockGames.set(matchId, { gameId, matchId, blue: [...blue], red: [...red] });
  return { matchId, gameId };
}

export function resetMockData(): void {
  mockProfiles.clear();
  mockGames.clear();
  mockHistory.clear();
  mockMatches.clear();
  mockRanked.clear();
  mockTimelineMissing.clear();
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
    return structuredClone(rankedOf(profile.account.puuid)) as T;
  }
  if (path.slice(0, 5).join("/") === "lol/match/v5/matches/by-puuid" && path.length === 7 && path[6] === "ids") {
    const profile = profileForPuuid(path[5]);
    checkFixtureFailure(profile);
    return [...(mockHistory.get(profile.account.puuid) ?? [])] as T;
  }
  if (path.slice(0, 5).join("/") === "lol/spectator/v5/active-games/by-summoner" && path.length === 6) {
    checkFixtureFailure(profileForPuuid(path[5]));
    const game = gameOf(path[5]);
    if (!game) throw statusError(404, undefined, true, "NOT_FOUND");
    return buildMockActiveGame(game.gameId, game.matchId, game.blue, game.red) as T;
  }
  if (path.slice(0, 4).join("/") === "lol/match/v5/matches" && path.length === 5) {
    const match = mockMatches.get(path[4]);
    if (!match) throw statusError(404, undefined, true);
    return structuredClone(match) as T;
  }
  if (path.slice(0, 4).join("/") === "lol/match/v5/matches" && path.length === 6 && path[5] === "timeline") {
    const match = mockMatches.get(path[4]);
    if (!match || mockTimelineMissing.has(path[4])) throw statusError(404, undefined, true);
    return buildMockTimeline(match) as T;
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
  /** On a 404, read Riot's `errorCode` token from the body into `RiotApiError.errorCode`. */
  readNotFoundCode?: boolean;
  /** The pacer to take turns from; the process-wide one (`getRiotPacer()`) unless a test passes its own. */
  pacer?: RiotPacer;
  /**
   * The longest a request waits for its turn before it is rejected as `rate_limited` without being sent.
   * A requester that never waits out a cooldown (`maxRetryDelayMs` 0, such as spectator, league and timelines) waits
   * at most its `timeoutMs`; any other waits as long as the turn takes, until the bot stops.
   */
  maxQueueWaitMs?: number;
}

/** Options for one call of a requester. */
export interface RiotCallOptions {
  /**
   * `false` makes one attempt only: a network failure, a 5xx or a 429 is thrown at once instead of retried.
   * For a caller that already repeats itself, such as a poll whose next run is the retry. A short 429 cooldown on the
   * host is still waited out before the one attempt, because that wait is not a retry.
   */
  retry?: boolean;
  /** `bulk` for interactive work that sends many requests at once (`/recent`); see `RiotPriority`. Normal otherwise. */
  priority?: RiotPriority;
}

/** A Riot request function: the shared one behind `riotFetch`, or one from `createRiotRequester`. */
export type RiotRequest = <T>(url: string, options?: RiotCallOptions) => Promise<T>;

/** Riot's `errorCode` of a 404 body, only if it is a short upper-case token; anything else is dropped. */
async function notFoundCode(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length > 4096) return undefined;
    const code = (JSON.parse(text) as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : undefined;
  } catch { return undefined; }
}

function retryDelay(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

let sharedPacer: RiotPacer | undefined;

/** The pacer every requester in the process takes turns from, so all callers share one budget per Riot host. */
export function getRiotPacer(): RiotPacer {
  sharedPacer ??= new RiotPacer();
  return sharedPacer;
}

/** Replaces the shared pacer, for tests (an unpaced one or one on a fake clock); returns a function that restores the previous one. */
export function useRiotPacer(pacer: RiotPacer): () => void {
  const previous = sharedPacer;
  sharedPacer = pacer;
  return () => { sharedPacer = previous; };
}

/** A request the pacer did not give a turn was never sent. */
function pacingError(error: unknown): unknown {
  if (!(error instanceof PacingRejection)) return error;
  return error.reason === "stopping"
    ? new RiotApiError(error.message, "unavailable")
    : new RiotApiError(error.message, "rate_limited", undefined, error.waitMs);
}

export function createRiotRequester(options: RiotRequesterOptions = {}): RiotRequest {
  const fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  const sleep = options.sleep ?? (async (milliseconds: number) => { await delay(milliseconds); });
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.maxRetries ?? 2;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
  const maxQueueWaitMs = options.maxQueueWaitMs ?? (maxRetryDelayMs === 0 ? timeoutMs : Infinity);
  const cooldowns = new Map<string, number>();

  /** Waits out a short cooldown on the host, then for a turn from the pacer; a long cooldown is thrown. */
  const takeTurn = async (target: URL, call: RiotCallOptions): Promise<PacingSlot> => {
    for (;;) {
      const cooldownUntil = cooldowns.get(target.origin);
      const remainingCooldown = (cooldownUntil ?? 0) - now();
      if (remainingCooldown > maxRetryDelayMs) throw statusError(429, remainingCooldown);
      if (remainingCooldown > 0) await sleep(remainingCooldown);
      let slot: PacingSlot;
      try {
        slot = await (options.pacer ?? getRiotPacer()).acquire(target.hostname, { priority: call.priority, maxWaitMs: maxQueueWaitMs });
      } catch (error) { throw pacingError(error); }
      // A 429 that another request got while this one waited for its turn starts a cooldown this one honors too.
      const latest = cooldowns.get(target.origin);
      if (latest === cooldownUntil || (latest ?? 0) <= now()) return slot;
      slot.refund();
    }
  };

  return async function request<T>(url: string, call: RiotCallOptions = {}): Promise<T> {
    const apiKey = (options.apiKey?.() ?? process.env.RIOT_API_KEY)?.trim();
    if (!apiKey) throw new RiotApiError("Missing RIOT_API_KEY environment variable for RIOT_MODE=real.", "missing_key");
    const target = new URL(url);
    if (target.protocol !== "https:" || !["na1.api.riotgames.com", "americas.api.riotgames.com"].includes(target.hostname)) {
      throw new RiotApiError("Unsupported Riot API host.", "bad_request");
    }
    // A key is only transmitted in the header, including if an older caller supplied api_key.
    target.searchParams.delete("api_key");
    const maxRetries = call.retry === false ? 0 : retries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Every attempt takes a turn: Riot counts each one against the host's limits.
      await takeTurn(target, call);
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
      (options.pacer ?? getRiotPacer()).observe(target.hostname, response.headers.get("X-App-Rate-Limit-Count"));
      if (response.ok) {
        try { return await response.json() as T; }
        catch { throw new RiotApiError("Riot API returned an invalid response.", signal.aborted ? "timeout" : "invalid_response"); }
      }
      const afterMs = retryDelay(response.headers.get("Retry-After"), now());
      // Response bodies may contain HTML or changing diagnostics; status alone controls error handling,
      // except that a requester asked to can keep the sanitized `errorCode` token of a 404.
      const errorCode = options.readNotFoundCode && response.status === 404 ? await notFoundCode(response) : undefined;
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
      throw statusError(response.status, afterMs, false, errorCode);
    }
    throw new RiotApiError("Riot API request did not complete.", "unavailable");
  };
}

const realFetch = createRiotRequester();

export async function riotFetch<T>(url: string, options: RiotCallOptions = {}): Promise<T> {
  return isMockData() ? mockFetch<T>(url) : realFetch<T>(url, options);
}
