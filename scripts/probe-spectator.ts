import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { getDatabasePath } from "../src/store/database";
import { RiotApiError } from "../src/services/riotData";
import { createSpectatorRequester, getActiveGame, isLoading } from "../src/utils/riotSpectatorApi";

dotenv.config({ quiet: true });

const RATE_HEADERS = ["x-app-rate-limit", "x-app-rate-limit-count", "x-method-rate-limit", "x-method-rate-limit-count"] as const;

/** The explicit PUUID argument, or the first real (non-mock) bound account, read from the database without writing to it. */
function choosePuuid(): string {
  const argument = process.argv[2]?.trim();
  if (argument) return argument;
  const path = getDatabasePath();
  if (path === ":memory:" || !existsSync(path)) throw new Error(`No database at ${path}. Pass a PUUID as the first argument.`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT puuid FROM member_accounts WHERE puuid NOT LIKE 'MOCK%' ORDER BY guild_id, position LIMIT 1").get() as { puuid: string } | undefined;
    if (!row) throw new Error("No real bound account found. Bind one in RIOT_MODE=real or pass a PUUID as the first argument.");
    return row.puuid;
  } finally { db.close(); }
}

/** Prints the spectator-v5 fields issue #24 needs. One read-only GET; the API key and the PUUID are never printed. */
async function probe(): Promise<void> {
  if ((process.env.RIOT_MODE?.trim().toLowerCase() || "mock") !== "real") throw new Error("The probe asks Riot, so it needs RIOT_MODE=real.");
  if (!process.env.RIOT_API_KEY?.trim()) throw new Error("Configure RIOT_API_KEY in .env first.");
  const puuid = choosePuuid();
  let headers: Headers | undefined;
  let status = 0;
  const request = createSpectatorRequester({
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      headers = response.headers;
      status = response.status;
      return response;
    },
  });
  console.log(`time ${new Date().toISOString()}`);
  try {
    const game = await getActiveGame(puuid, request);
    console.log(`status ${status}`);
    if (!game) console.log("not in a game (404 NOT_FOUND)");
    else {
      console.log(`gameId ${game.gameId}`);
      console.log(`gameStartTime ${game.gameStartTime} (${isLoading(game) ? "loading screen" : "game clock running"})`);
      console.log(`gameLength ${game.gameLength}`);
      console.log(`gameQueueConfigId ${game.gameQueueConfigId}`);
      console.log(`mapId ${game.mapId}`);
      console.log(`platformId ${game.platformId}`);
      console.log(`participants ${game.participants.length}`);
    }
  } catch (error) {
    if (error instanceof RiotApiError) console.log(`status ${status || error.status || "none"}, ${error.code}: ${error.message}`);
    else throw error;
  }
  for (const name of RATE_HEADERS) console.log(`${name} ${headers?.get(name) ?? "(none)"}`);
}

probe().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The spectator probe failed.");
  process.exitCode = 1;
});
