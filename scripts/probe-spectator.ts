import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { getDatabasePath } from "../src/store/database";
import { RiotApiError } from "../src/services/riotData";
import type { ActiveGame } from "../src/types";
import { createSpectatorRequester, getActiveGame, isLoading } from "../src/utils/riotSpectatorApi";

dotenv.config({ quiet: true });

const RATE_HEADERS = ["x-app-rate-limit", "x-app-rate-limit-count", "x-method-rate-limit", "x-method-rate-limit-count"] as const;

/** The account named by a `name#tag` argument, or the first account of the first tracked member; read from the database without writing to it. */
function choosePuuid(): string {
  const argument = process.argv[2]?.trim();
  const path = getDatabasePath();
  if (path === ":memory:" || !existsSync(path)) throw new Error(`No database at ${path}.`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    let row: { puuid: string } | undefined;
    if (argument) {
      const hash = argument.lastIndexOf("#");
      if (hash <= 0 || hash === argument.length - 1) throw new Error('Pass the Riot ID as "name#tag".');
      row = db.prepare("SELECT puuid FROM member_accounts WHERE puuid NOT LIKE 'MOCK%' AND lower(game_name) = lower(?) AND lower(tag_line) = lower(?) LIMIT 1")
        .get(argument.slice(0, hash).trim(), argument.slice(hash + 1).trim()) as { puuid: string } | undefined;
      if (!row) throw new Error(`No real bound account matches ${argument}.`);
    } else {
      row = db.prepare(`SELECT a.puuid FROM member_accounts a JOIN tracked_members m ON m.guild_id = a.guild_id AND m.discord_user_id = a.discord_user_id
        WHERE a.puuid NOT LIKE 'MOCK%' ORDER BY m.guild_id, m.position, a.position LIMIT 1`).get() as { puuid: string } | undefined;
      if (!row) throw new Error('No real bound account found. Bind one in RIOT_MODE=real.');
    }
    return row.puuid;
  } finally { db.close(); }
}

/** The JSON type name of a raw value; `missing` for an absent field, which JSON itself cannot carry. */
function rawType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** A raw scalar as Riot sent it; an object or array is summarized so no nested identity can leak. */
function rawValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value !== null && typeof value === "object") return Array.isArray(value) ? `[${value.length} items]` : "{...}";
  return JSON.stringify(value);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

const RAW_FIELDS = ["gameStartTime", "gameLength", "gameQueueConfigId", "mapId", "platformId"] as const;

/**
 * Output lines for a raw spectator body next to what the bot parsed from it. Raw type and value come first, because the
 * parser turns a missing or malformed field into null and drops participants it cannot place on a team.
 * Never prints a puuid, riotId, summoner name or the key: only the listed top-level scalars and the participant count.
 */
export function describeGame(raw: unknown, parsed: ActiveGame): string[] {
  const body = asRecord(raw);
  const lines = [`gameId ${parsed.gameId}`];
  for (const field of RAW_FIELDS) {
    lines.push(`${field} raw ${rawType(body[field])} ${rawValue(body[field])}, parsed ${JSON.stringify(parsed[field])}`
      + (field === "gameStartTime" ? ` (${isLoading(parsed) ? "loading screen" : "game clock running"})` : ""));
  }
  lines.push(`participants raw ${rawType(body.participants)} ${rawValue(body.participants)}, parsed ${parsed.participants.length}`);
  return lines;
}

/** What to print when Riot sent a body the parser rejected: the same raw fields, with no parsed side. */
export function describeRejected(raw: unknown): string[] {
  const body = asRecord(raw);
  const lines = [`gameId raw ${rawType(body.gameId)} ${rawValue(body.gameId)}`];
  for (const field of RAW_FIELDS) lines.push(`${field} raw ${rawType(body[field])} ${rawValue(body[field])}`);
  lines.push(`participants raw ${rawType(body.participants)} ${rawValue(body.participants)}`);
  return lines;
}

/**
 * One read-only GET for the account; prints through `log` and returns the process exit code: 1 on any Riot error
 * (a 401, 403, 429, timeout or a body the bot rejects), 0 otherwise. Not being in a game is not an error.
 */
export async function runProbe(puuid: string, fetchImpl: typeof fetch, log: (line: string) => void): Promise<number> {
  let headers: Headers | undefined;
  let status = 0;
  let raw: unknown;
  const request = createSpectatorRequester({
    fetch: async (input, init) => {
      const response = await fetchImpl(input, init);
      headers = response.headers;
      status = response.status;
      if (response.ok) raw = await response.clone().json().catch(() => undefined);
      return response;
    },
  });
  log(`time ${new Date().toISOString()}`);
  let code = 0;
  try {
    const game = await getActiveGame(puuid, request);
    log(`status ${status}`);
    if (!game) log("not in a game (404 NOT_FOUND)");
    else for (const line of describeGame(raw, game)) log(line);
  } catch (error) {
    if (!(error instanceof RiotApiError)) throw error;
    code = 1;
    log(`status ${status || error.status || "none"}, ${error.code}: ${error.message}`);
    if (raw !== undefined) for (const line of describeRejected(raw)) log(line);
  }
  for (const name of RATE_HEADERS) log(`${name} ${headers?.get(name) ?? "(none)"}`);
  return code;
}

/** Prints the spectator-v5 fields issue #24 needs. One read-only GET; the API key and the PUUID are never printed. */
async function probe(): Promise<void> {
  if ((process.env.RIOT_MODE?.trim().toLowerCase() || "mock") !== "real") throw new Error("The probe asks Riot, so it needs RIOT_MODE=real.");
  if (!process.env.RIOT_API_KEY?.trim()) throw new Error("Configure RIOT_API_KEY in .env first.");
  process.exitCode = await runProbe(choosePuuid(), fetch, console.log);
}

if (require.main === module) {
  probe().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "The spectator probe failed.");
    process.exitCode = 1;
  });
}
