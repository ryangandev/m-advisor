// Collects recent real ranked solo matches as the reference sample for horse ranking benchmarks.
// Raw matches contain other players' identities, so they stay in the ignored .data directory.
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRiotRequester } from "../src/services/riotData";

const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=") as [string, string]));
const tiers = (args.get("tiers") ?? "SILVER,GOLD,PLATINUM,EMERALD,DIAMOND").split(",");
const divisions = (args.get("divisions") ?? "II").split(",");
const perDivision = Number(args.get("per-division") ?? 40);
const outDir = path.resolve(args.get("out") ?? ".data/benchmark-sample");
// Only recent games, so the reference reflects the current patches.
const maxAgeDays = Number(args.get("max-age-days") ?? 60);
const startTime = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400;
mkdirSync(outDir, { recursive: true });

// Development keys allow 100 requests per two minutes; pace below that instead of relying on 429s.
const request = createRiotRequester({ maxRetryDelayMs: 130_000 });
let lastRequest = 0;
async function riot<T>(url: string): Promise<T> {
  const wait = lastRequest + 1250 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
  return request<T>(url);
}

async function sample(): Promise<void> {
  let saved = 0;
  for (const tier of tiers) {
    for (const division of divisions) {
      const entries = await riot<Array<{ puuid?: string }>>(
        `https://na1.api.riotgames.com/lol/league/v4/entries/RANKED_SOLO_5x5/${tier}/${division}?page=1`);
      for (const { puuid } of entries.filter((entry) => entry.puuid).slice(0, perDivision)) {
        try {
          const [matchId] = await riot<string[]>(
            `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid!)}/ids?queue=420&count=1&startTime=${startTime}`);
          const file = path.join(outDir, `${matchId}.json`);
          if (!matchId || existsSync(file)) continue;
          const match = await riot<Record<string, unknown>>(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`);
          writeFileSync(file, JSON.stringify({ ...match, _tier: tier }));
          saved++;
          console.log(`${tier} ${division}: ${matchId} (${saved} saved)`);
        } catch (error) {
          console.log(`${tier} ${division}: skipped (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }
  console.log(`Saved ${saved} new matches to ${outDir}.`);
}
void sample().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Sampling failed."); process.exitCode = 1; });
