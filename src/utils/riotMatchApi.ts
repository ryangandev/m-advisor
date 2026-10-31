import { CHALLENGE_STATS, PERFORMANCE_STATS, POSITIONS } from "../types";
import type { MatchDetail, MatchParticipant, ParticipantPerformance, Position, TeamObjectives } from "../types";
import { createRiotRequester, getRiotMode, isMockData, RiotApiError, riotFetch, riotNumber, riotObject } from "../services/riotData";
import type { RiotCallOptions } from "../services/riotData";
import { parseMatchTimeline } from "./matchTimeline";
import type { MatchTimeline } from "./matchTimeline";

const AMERICAS = "https://americas.api.riotgames.com";
// Current Riot game constants include Swiftplay and Quickplay; keep Blind Pick for older history.
const SR_QUEUE_IDS = [400, 420, 430, 440, 480, 490];
/** Match details kept; the least recently used entry is dropped first. */
const MATCH_CACHE_LIMIT = 200;
/** Queue IDs remembered, far more than the details: a number per match is tiny and saves a request each. */
const QUEUE_CACHE_LIMIT = 2_000;
const matchCache = new Map<string, MatchDetail>();
/** `mode:matchId` to the queue the match was played in, so a non-Summoner's-Rift match is never fetched twice just to be skipped. */
const queueCache = new Map<string, number>();

/** Reads an entry and marks it the most recently used. */
function touch<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
}

/** Summoner's Rift normal, ranked, Swiftplay and Quickplay games are announced; other modes are not. */
export function isAnnouncedQueue(queueId: number): boolean {
  return SR_QUEUE_IDS.includes(queueId);
}

/**
 * Options for the match helpers. `retry: false` makes each Riot request one attempt, for a caller whose next run is
 * the retry (see `RiotCallOptions`). A cached match detail or queue costs no request either way.
 */
export type MatchRequestOptions = RiotCallOptions;

/** The account's most recent match IDs in every queue, newest first. */
export async function getRecentMatchIds(puuid: string, count = 20, options: MatchRequestOptions = {}): Promise<string[]> {
  const idsUrl = `${AMERICAS}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`;
  const matchIds = await riotFetch<unknown>(idsUrl, options);
  if (!Array.isArray(matchIds) || matchIds.some((id) => typeof id !== "string")) {
    throw new RiotApiError("Riot API returned invalid match history.", "invalid_response");
  }
  return (matchIds as string[]).slice(0, count);
}

/**
 * The newest match in a supported Summoner's Rift queue. A match whose queue is already known costs no request:
 * a non-Summoner's-Rift one is skipped and a supported one is returned as it is, so only matches never seen before
 * are fetched, newest first, until the first supported one.
 */
export async function getLatestSRMatchId(puuid: string, options: MatchRequestOptions = {}): Promise<string | null> {
  const mode = getRiotMode();
  for (const matchId of await getRecentMatchIds(puuid, 20, options)) {
    const known = touch(queueCache, `${mode}:${matchId}`);
    const queueId = known ?? (await getMatchDetail(matchId, options)).info.queueId;
    if (isAnnouncedQueue(queueId)) return matchId;
  }

  return null;
}

/** Match detail requests still out, by cache key, with the options each was sent with. */
const inFlightDetails = new Map<string, Array<{ options: MatchRequestOptions; detail: Promise<MatchDetail> }>>();

/**
 * Whether a caller can wait for a request already out instead of sending its own: only when that request is at least
 * as good for it. A normal caller never waits behind a bulk request's turn, and a caller that retries never takes the
 * answer of a request that does not.
 */
function serves(request: MatchRequestOptions, caller: MatchRequestOptions): boolean {
  return (request.priority !== "bulk" || caller.priority === "bulk") && (request.retry !== false || caller.retry === false);
}

/**
 * One match's detail, from the cache when it has been fetched before. A caller that asks for a match whose detail is
 * already being fetched waits for that request (see `serves`), so concurrent `/recent` runs share their details.
 */
export async function getMatchDetail(matchId: string, options: MatchRequestOptions = {}): Promise<MatchDetail> {
  const mode = getRiotMode();
  const cacheKey = `${mode}:${matchId}`;
  const cached = touch(matchCache, cacheKey);
  if (cached) return structuredClone(cached);
  const pending = inFlightDetails.get(cacheKey) ?? [];
  const shared = pending.find((entry) => serves(entry.options, options));
  if (shared) return structuredClone(await shared.detail);
  const entry = { options, detail: fetchMatchDetail(matchId, cacheKey, options) };
  inFlightDetails.set(cacheKey, [...pending, entry]);
  try {
    return structuredClone(await entry.detail);
  } finally {
    const left = (inFlightDetails.get(cacheKey) ?? []).filter((other) => other !== entry);
    if (left.length > 0) inFlightDetails.set(cacheKey, left);
    else inFlightDetails.delete(cacheKey);
  }
}

async function fetchMatchDetail(matchId: string, cacheKey: string, options: MatchRequestOptions): Promise<MatchDetail> {
  const detailUrl = `${AMERICAS}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const detail = parseMatchDetail(await riotFetch<unknown>(detailUrl, options), matchId);
  remember(matchCache, cacheKey, structuredClone(detail), MATCH_CACHE_LIMIT);
  remember(queueCache, cacheKey, detail.info.queueId, QUEUE_CACHE_LIMIT);
  return detail;
}

/** A timeline request is aborted after this long, so it never holds up the announcement. */
export const TIMELINE_TIMEOUT_MS = 5_000;
/**
 * Timelines are optional flavor, so they get their own requester: one attempt, aborted at the timeout, and a 429
 * on it never sets the shared cooldown that profile and match requests honor. Its own cooldown fails fast instead of waiting.
 */
export const TIMELINE_REQUESTER_OPTIONS = { timeoutMs: TIMELINE_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0 } as const;
const timelineRequest = createRiotRequester(TIMELINE_REQUESTER_OPTIONS);

/**
 * The match-v5 timeline, used only for optional commentary moments. It is not cached: each finished match
 * is announced once, and a timeline is several hundred kilobytes.
 */
export async function getMatchTimeline(matchId: string, request: <T>(url: string) => Promise<T> = timelineRequest): Promise<MatchTimeline> {
  const timelineUrl = `${AMERICAS}/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`;
  const body = isMockData() ? await riotFetch<unknown>(timelineUrl) : await request<unknown>(timelineUrl);
  return parseMatchTimeline(body, matchId);
}

/** Validates a match-v5 response body and keeps the fields used for announcements and scoring. */
export function parseMatchDetail(body: unknown, matchId: string): MatchDetail {
  const raw = riotObject(body);
  const info = riotObject(raw.info);
  const metadata = riotObject(raw.metadata);
  if (!Array.isArray(info.participants) || info.participants.length === 0) {
    throw new RiotApiError("Riot API returned a match without participants.", "invalid_response");
  }
  const participants = info.participants.map(parseParticipant);
  // Other modes (Arena has up to eight teams, with other IDs) are never ranked or announced, so only the queues that are must have two teams.
  if (isAnnouncedQueue(riotNumber(info.queueId))) checkTeams(participants);
  if (metadata.matchId !== matchId) throw new RiotApiError("Riot API returned a mismatched match ID.", "invalid_response");
  return {
    metadata: { matchId, participants: participants.map((player) => player.puuid) },
    info: {
      queueId: riotNumber(info.queueId),
      ...(typeof info.gameVersion === "string" && info.gameVersion.trim() ? { gameVersion: info.gameVersion.trim() } : {}),
      gameDuration: riotNumber(info.gameDuration),
      gameEndTimestamp: typeof info.gameEndTimestamp === "number" && info.gameEndTimestamp > 0 ? info.gameEndTimestamp : null,
      earlySurrender: info.participants.some((value) => riotObject(value).gameEndedInEarlySurrender === true),
      // Older matches omit endOfGameResult, so a game in which nobody won also counts as aborted.
      aborted: (typeof info.endOfGameResult === "string" && info.endOfGameResult !== "GameComplete")
        || !participants.some((player) => player.win),
      teams: Array.isArray(info.teams) ? info.teams.map(parseTeam) : [],
      participants,
    },
  };
}

/**
 * A Summoner's Rift match has exactly two teams of at most five. A missing or odd team ID would put all ten players on one
 * team, and the ranking would then name and rate the enemies.
 */
function checkTeams(participants: readonly MatchParticipant[]): void {
  const sizes = new Map<number, number>();
  for (const { teamId } of participants) {
    if (teamId !== 100 && teamId !== 200) throw new RiotApiError("Riot API returned a participant on an unknown team.", "invalid_response");
    sizes.set(teamId, (sizes.get(teamId) ?? 0) + 1);
  }
  if ([...sizes.values()].some((size) => size > 5)) throw new RiotApiError("Riot API returned a team of more than five players.", "invalid_response");
}

function parsePosition(...values: unknown[]): Position | null {
  for (const value of values) {
    if (typeof value === "string" && (POSITIONS as readonly string[]).includes(value)) return value as Position;
  }
  return null;
}

/** Keeps finite numbers only; scoring treats an omitted statistic as unavailable rather than zero. */
function parsePerformance(player: Record<string, unknown>): ParticipantPerformance {
  const challenges = player.challenges && typeof player.challenges === "object" && !Array.isArray(player.challenges)
    ? player.challenges as Record<string, unknown> : {};
  const stats: ParticipantPerformance = {};
  for (const key of PERFORMANCE_STATS) {
    if (typeof player[key] === "number" && Number.isFinite(player[key])) stats[key] = player[key];
  }
  for (const key of CHALLENGE_STATS) {
    if (typeof challenges[key] === "number" && Number.isFinite(challenges[key])) stats[key] = challenges[key];
  }
  return stats;
}

function parseParticipant(value: unknown): MatchParticipant {
  const player = riotObject(value);
  if (typeof player.puuid !== "string" || !player.puuid || (player.win !== undefined && typeof player.win !== "boolean")) {
    throw new RiotApiError("Riot API returned an invalid match participant.", "invalid_response");
  }
  return {
    puuid: player.puuid,
    riotIdGameName: typeof player.riotIdGameName === "string" ? player.riotIdGameName : "",
    championId: riotNumber(player.championId),
    championName: typeof player.championName === "string" ? player.championName : "",
    position: parsePosition(player.teamPosition, player.individualPosition),
    kills: riotNumber(player.kills), deaths: riotNumber(player.deaths), assists: riotNumber(player.assists),
    win: player.win === true, teamId: riotNumber(player.teamId),
    stats: parsePerformance(player),
  };
}

function parseTeam(value: unknown): TeamObjectives {
  const team = riotObject(value);
  const objectives = team.objectives && typeof team.objectives === "object" ? team.objectives as Record<string, unknown> : {};
  const kills = (name: string) => {
    const objective = objectives[name];
    return objective && typeof objective === "object" ? riotNumber((objective as Record<string, unknown>).kills) : 0;
  };
  return { teamId: riotNumber(team.teamId), dragon: kills("dragon"), baron: kills("baron"), riftHerald: kills("riftHerald"), tower: kills("tower") };
}

export { SR_QUEUE_IDS };
