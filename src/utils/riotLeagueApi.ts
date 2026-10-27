import type { RankedEntry } from "../types";
import { createRiotRequester, isMockData, RiotApiError, riotFetch } from "../services/riotData";
import type { RiotRequesterOptions } from "../services/riotData";

export { rankedQueueFor } from "../services/rankMath";

const NA1 = "https://na1.api.riotgames.com";

/** A league-v4 request is aborted after this long. */
export const LEAGUE_TIMEOUT_MS = 5_000;
/**
 * LP reads are only useful right now and are retried by whoever schedules them, so league gets its own requester,
 * like spectator and timelines: one attempt, aborted at the timeout, and a 429 on it never sets the shared na1
 * cooldown that /profile and /bind honor. Its own cooldown fails fast instead of waiting.
 */
export const LEAGUE_REQUESTER_OPTIONS = { timeoutMs: LEAGUE_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0 } as const;

/** A new league requester with its own cooldown; tests pass overrides such as a fake `fetch`. */
export function createLeagueRequester(overrides: RiotRequesterOptions = {}): <T>(url: string) => Promise<T> {
  return createRiotRequester({ ...LEAGUE_REQUESTER_OPTIONS, ...overrides });
}

/** The requester `getLeagueEntries` uses unless it is given another. Never the shared one. */
export const leagueRequester = createLeagueRequester();

/** The ranked entries Riot sent, plus how many it had to drop because they were malformed. */
export interface LeagueEntries {
  entries: RankedEntry[];
  dropped: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One entry, or null when anything the LP math relies on is missing or malformed. */
function parseEntry(value: unknown): RankedEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const leaguePoints = count(entry.leaguePoints);
  const wins = count(entry.wins);
  const losses = count(entry.losses);
  if (typeof entry.queueType !== "string" || typeof entry.tier !== "string" || typeof entry.rank !== "string") return null;
  // A missing leaguePoints must not become 0: that would turn into a made-up LP change. wins and losses are the
  // attribution key, so they are equally required.
  if (leaguePoints === null || wins === null || losses === null) return null;
  return { queueType: entry.queueType, tier: entry.tier, rank: entry.rank, leaguePoints, wins, losses };
}

/**
 * Parses a league-v4 entries body. A malformed entry is dropped and counted, never the whole array, so a bad flex
 * entry cannot hide the solo one. A body that is not an array, or an array whose every entry is malformed, is an
 * `invalid_response` error: returning "no entries" there would read as an unranked account.
 */
export function parseLeagueEntries(body: unknown): LeagueEntries {
  if (!Array.isArray(body)) throw new RiotApiError("Riot API returned invalid ranked entries.", "invalid_response");
  const entries = body.flatMap((value) => parseEntry(value) ?? []);
  if (body.length > 0 && entries.length === 0) throw new RiotApiError("Riot API returned only invalid ranked entries.", "invalid_response");
  return { entries, dropped: body.length - entries.length };
}

/**
 * The account's ranked entries from league-v4, read through the league requester (one attempt, 5 second timeout).
 * In mock mode it reads the mutable mock ranked state instead and the injected `request` is ignored; in real mode it
 * never reads mock state, and a failure is thrown.
 * An unranked account has an empty list.
 */
export async function getLeagueEntries(puuid: string, request: <T>(url: string) => Promise<T> = leagueRequester): Promise<LeagueEntries> {
  if (typeof puuid !== "string" || !puuid.trim()) throw new RiotApiError("A PUUID is required to look up ranked entries.", "bad_request");
  const url = `${NA1}/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  return parseLeagueEntries(isMockData() ? await riotFetch<unknown>(url) : await request<unknown>(url));
}
