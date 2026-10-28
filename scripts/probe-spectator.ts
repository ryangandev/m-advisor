import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { getDatabasePath } from "../src/store/database";
import { RiotApiError } from "../src/services/riotData";
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
