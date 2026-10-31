import { getRiotMode, riotFetch, RiotApiError } from "./riotData";
import type { RiotMode } from "./riotData";
import { logInfo, logWarn } from "../utils/log";
import { isStopping } from "./shutdownState";

/** A cheap na1 endpoint that needs a valid key and no account, used once at startup. */
export const RIOT_KEY_CHECK_URL = "https://na1.api.riotgames.com/lol/status/v4/platform-data";

/** Riot answered 401 or 403: the key is expired, mistyped or not allowed. */
export function isRiotKeyRejection(error: unknown): error is RiotApiError {
  return error instanceof RiotApiError && (error.code === "unauthorized" || error.code === "forbidden");
}

/** The one developer-facing line for a rejected key. It names the variable, never the value. */
export function riotKeyRejectedLine(error: RiotApiError): string {
  const status = error.status ?? (error.code === "unauthorized" ? 401 : 403);
  return `Riot rejected RIOT_API_KEY (${status}); paste a new key into .env and restart.`;
}

/**
 * Logs the rejected-key warning when `error` is a real 401 or 403 and returns whether it was one.
 * A simulated mock error (such as `MockAuth#NA1`) says nothing about the real key, so it logs nothing.
 */
export function logRiotKeyRejection(error: unknown): boolean {
  if (!isRiotKeyRejection(error)) return false;
  if (!error.simulated) logWarn(riotKeyRejectedLine(error));
  return true;
}

export interface RiotKeyCheckOptions {
  mode?: RiotMode;
  /** The request to make; tests pass a fake so no check reaches the network. */
  request?: (url: string) => Promise<unknown>;
  /** Whether the bot started stopping while the request was out. */
  stopping?: () => boolean;
}

/**
 * Real mode only: one request after login that shows an expired or mistyped key in the log at once, instead of at the
 * first failed command. It never throws and never stops the bot; mock mode makes no request at all.
 */
export async function checkRiotKey(options: RiotKeyCheckOptions = {}): Promise<void> {
  try {
    if ((options.mode ?? getRiotMode()) !== "real") return;
    const request = options.request ?? ((url: string) => riotFetch<unknown>(url));
    const stopping = options.stopping ?? isStopping;
    try {
      await request(RIOT_KEY_CHECK_URL);
    } catch (error) {
      if (stopping()) return;
      if (logRiotKeyRejection(error)) return;
      const reason = error instanceof RiotApiError ? error.code : "unknown error";
      logWarn(`Could not check RIOT_API_KEY at startup (${reason}); the first Riot command will show whether it works.`);
      return;
    }
    if (!stopping()) logInfo("RIOT_API_KEY accepted by Riot.");
  } catch {
    // The check is informational: whatever goes wrong in it must not reach the bot.
  }
}
