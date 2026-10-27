import type { ActiveGame, ActiveGameParticipant } from "../types";
import { createRiotRequester, isMockData, RiotApiError, riotFetch, riotObject } from "../services/riotData";
import type { RiotRequesterOptions } from "../services/riotData";
import { isAnnouncedQueue } from "./riotMatchApi";

const NA1 = "https://na1.api.riotgames.com";
/** Summoner's Rift. */
const SUMMONERS_RIFT = 11;

/** A spectator request is aborted after this long. */
export const SPECTATOR_TIMEOUT_MS = 5_000;
/**
 * The watcher polls often and its answer is only useful right now, so spectator gets its own requester: one attempt,
 * aborted at the timeout, and a 429 on it never sets the shared na1 cooldown that /profile and /bind honor.
 * Its own cooldown fails fast instead of waiting. It also reads the `errorCode` of a 404, which tells
 * "not in a game" apart from any other 404.
 */
export const SPECTATOR_REQUESTER_OPTIONS = { timeoutMs: SPECTATOR_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0, readNotFoundCode: true } as const;

/** A new spectator requester with its own cooldown; tests pass overrides such as a fake `fetch`. */
export function createSpectatorRequester(overrides: RiotRequesterOptions = {}): <T>(url: string) => Promise<T> {
  return createRiotRequester({ ...SPECTATOR_REQUESTER_OPTIONS, ...overrides });
}

/** The requester `getActiveGame` uses unless it is given another. Never the shared one. */
export const spectatorRequester = createSpectatorRequester();

/**
 * The game the account is in right now (loading or in progress), or null when it is not in one.
 * Riot answers 404 with `errorCode` `NOT_FOUND` for "not in a game"; any other 404 is an `invalid_response` error.
 * A 401 or 403 is thrown as a `RiotApiError`; see `isSpectatorAuthError`.
 */
export async function getActiveGame(puuid: string, request: <T>(url: string) => Promise<T> = spectatorRequester): Promise<ActiveGame | null> {
  if (typeof puuid !== "string" || !puuid.trim()) throw new RiotApiError("A PUUID is required to look up an active game.", "bad_request");
  const url = `${NA1}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
  const mock = isMockData();
  try {
    return parseActiveGame(mock ? await riotFetch<unknown>(url) : await request<unknown>(url), mock);
  } catch (error) {
    if (error instanceof RiotApiError && error.status === 404) {
      if (error.errorCode === "NOT_FOUND") return null;
      throw new RiotApiError("Riot API returned an unexpected 404 for an active game lookup.", "invalid_response", 404, undefined, error.simulated);
    }
    throw error;
  }
}

/** The key is rejected or lacks spectator access: the watcher should stop asking, not retry. */
export function isSpectatorAuthError(error: unknown): error is RiotApiError {
  return error instanceof RiotApiError && (error.code === "unauthorized" || error.code === "forbidden");
}

/** Still on the loading screen: Riot reports no start time until the game clock starts. */
export function isLoading(game: ActiveGame): boolean {
  return game.gameStartTime === 0;
}

/** A Summoner's Rift game in a queue the bot announces. An unknown queue or map (null) is never announced. */
export function isAnnouncedGame(game: ActiveGame): boolean {
  return game.gameQueueConfigId !== null && isAnnouncedQueue(game.gameQueueConfigId) && game.mapId === SUMMONERS_RIFT;
}

/** The match-v5 ID this game will have once finished: `NA1_<gameId>`, or the reserved ID of a mock game. */
export function matchIdOf(game: ActiveGame): string {
  if (game.mock) {
    if (!game.mockMatchId) throw new RiotApiError("A mock game has no reserved match ID.", "invalid_response");
    return game.mockMatchId;
  }
  return `NA1_${game.gameId}`;
}

function invalid(): never {
  throw new RiotApiError("Riot API returned an invalid active game.", "invalid_response");
}

function whole(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

/** A participant that can be placed on a team, or null when it cannot (an unknown team, or not an object). */
function parseParticipant(value: unknown): ActiveGameParticipant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const player = value as Record<string, unknown>;
  const teamId = whole(player.teamId);
  if (teamId !== 100 && teamId !== 200) return null;
  return {
    // A bot, a hidden player or a malformed entry has no usable account: null, never a failure of the whole game.
    puuid: typeof player.puuid === "string" && player.puuid ? player.puuid : null,
    teamId,
    // 0 means Riot sent no usable champion.
    championId: whole(player.championId) ?? 0,
    spell1Id: whole(player.spell1Id) ?? 0,
    spell2Id: whole(player.spell2Id) ?? 0,
    bot: player.bot === true,
  };
}

/**
 * Parses a spectator-v5 CurrentGameInfo body. Only what identifies the game is strict: an object with a positive safe
 * integer `gameId`, an integer `gameStartTime` and a `participants` array, plus a finite `gameLength` (negative is
 * allowed). Anything else that is missing or malformed degrades instead of failing, because custom games, Practice
 * Tool, Arena and privacy-filtered players would otherwise break every poll:
 * - `gameQueueConfigId`, `mapId` and `platformId` become null; see `isAnnouncedGame`.
 * - A participant without a usable account (a bot, or a human whose `puuid` is missing or not text) is kept with
 *   `puuid: null`, and a missing or bad champion or spell becomes 0.
 * - A participant that cannot be placed on team 100 or 200 is dropped.
 * The participant `riotId` is never read: names shown by the bot come from stored bindings.
 * `mockMatchId` is honored only for mock data.
 */
export function parseActiveGame(body: unknown, mock = false): ActiveGame {
  const raw = riotObject(body);
  const gameId = whole(raw.gameId, 1);
  const gameStartTime = whole(raw.gameStartTime);
  if (gameId === null || gameStartTime === null || !Array.isArray(raw.participants)) invalid();
  if (typeof raw.gameLength !== "number" || !Number.isFinite(raw.gameLength)) invalid();
  const game: ActiveGame = {
    gameId,
    gameStartTime,
    gameLength: raw.gameLength,
    gameQueueConfigId: whole(raw.gameQueueConfigId),
    mapId: whole(raw.mapId),
    platformId: typeof raw.platformId === "string" && raw.platformId.trim() ? raw.platformId : null,
    participants: raw.participants.flatMap((value) => parseParticipant(value) ?? []),
    mock,
  };
  if (mock) {
    if (typeof raw.mockMatchId !== "string" || !raw.mockMatchId.startsWith("MOCK_")) invalid();
    game.mockMatchId = raw.mockMatchId;
  }
  return game;
}
