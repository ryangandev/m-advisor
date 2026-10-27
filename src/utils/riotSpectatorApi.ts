import type { ActiveGame, ActiveGameParticipant } from "../types";
import { createRiotRequester, isMockData, RiotApiError, riotFetch, riotObject } from "../services/riotData";

const NA1 = "https://na1.api.riotgames.com";

/** A spectator request is aborted after this long. */
export const SPECTATOR_TIMEOUT_MS = 5_000;
/**
 * The watcher polls often and its answer is only useful right now, so spectator gets its own requester: one attempt,
 * aborted at the timeout, and a 429 on it never sets the shared na1 cooldown that /profile and /bind honor.
 * Its own cooldown fails fast instead of waiting.
 */
export const SPECTATOR_REQUESTER_OPTIONS = { timeoutMs: SPECTATOR_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0 } as const;
const spectatorRequest = createRiotRequester(SPECTATOR_REQUESTER_OPTIONS);

/**
 * The game the account is in right now (loading or in progress), or null when it is not in one.
 * Riot answers 404 for "not in a game". A 401 or 403 is thrown as a `RiotApiError`; see `isSpectatorAuthError`.
 */
export async function getActiveGame(puuid: string, request: <T>(url: string) => Promise<T> = spectatorRequest): Promise<ActiveGame | null> {
  if (typeof puuid !== "string" || !puuid.trim()) throw new RiotApiError("A PUUID is required to look up an active game.", "bad_request");
  const url = `${NA1}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
  const mock = isMockData();
  try {
    return parseActiveGame(mock ? await riotFetch<unknown>(url) : await request<unknown>(url), mock);
  } catch (error) {
    if (error instanceof RiotApiError && error.code === "not_found") return null;
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

function whole(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function parseParticipant(value: unknown): ActiveGameParticipant {
  const player = riotObject(value);
  if (typeof player.bot !== "boolean") invalid();
  // A bot carries no account; every human must, because the watcher matches friends by PUUID.
  const puuid = typeof player.puuid === "string" && player.puuid ? player.puuid : null;
  if (puuid === null && !player.bot) invalid();
  if (player.puuid !== undefined && player.puuid !== null && typeof player.puuid !== "string") invalid();
  const teamId = whole(player.teamId);
  if (teamId !== 100 && teamId !== 200) invalid();
  return {
    puuid, teamId, bot: player.bot,
    championId: whole(player.championId), spell1Id: whole(player.spell1Id), spell2Id: whole(player.spell2Id),
  };
}

/**
 * Validates a spectator-v5 CurrentGameInfo body. It requires exactly the fields the game-start watcher relies on
 * (`gameId`, `gameStartTime`, `gameLength`, `gameQueueConfigId`, `mapId`, `platformId`, and per participant `puuid`,
 * `teamId`, `championId`, `spell1Id`, `spell2Id`, `bot`) and ignores the rest. The participant `riotId` is never read:
 * names shown by the bot come from stored bindings. `mockMatchId` is honored only for mock data.
 */
export function parseActiveGame(body: unknown, mock = false): ActiveGame {
  const raw = riotObject(body);
  if (!Array.isArray(raw.participants) || raw.participants.length === 0) invalid();
  if (typeof raw.platformId !== "string" || !raw.platformId.trim()) invalid();
  const game: ActiveGame = {
    gameId: whole(raw.gameId, 1),
    gameStartTime: whole(raw.gameStartTime),
    gameLength: finite(raw.gameLength),
    gameQueueConfigId: whole(raw.gameQueueConfigId),
    mapId: whole(raw.mapId),
    platformId: raw.platformId,
    participants: raw.participants.map(parseParticipant),
    mock,
  };
  if (mock) {
    if (typeof raw.mockMatchId !== "string" || !raw.mockMatchId.startsWith("MOCK_")) invalid();
    game.mockMatchId = raw.mockMatchId;
  }
  return game;
}
