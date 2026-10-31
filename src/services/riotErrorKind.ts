import { RiotApiError } from "./riotData";

/** The kind of a failure for logging it once: a Riot error's code and status, so a 503 and a timeout differ, or "other". */
export function riotErrorKind(error: unknown): string {
  return error instanceof RiotApiError ? `${error.code}:${error.status ?? ""}` : "other";
}
