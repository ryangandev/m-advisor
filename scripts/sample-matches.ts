// Collects recent real ranked solo matches as the reference sample for horse ranking benchmarks.
// Raw matches contain other players' identities, so they stay in the ignored .data directory.
import "dotenv/config";
import path from "node:path";
import { DEFAULT_MAX_AGE_DAYS, parseFlags, parseOrExit, runSample } from "./benchmarkArgs";
import { createRiotRequester, useRiotPacer } from "../src/services/riotData";
import { RiotPacer } from "../src/services/riotPacing";

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const DIVISIONS = ["I", "II", "III", "IV"];
const args = parseOrExit(() => parseFlags(process.argv.slice(2), {
  tiers: { kind: "list", allowed: TIERS },
  divisions: { kind: "list", allowed: DIVISIONS },
  "per-division": { kind: "positiveInt" },
  out: { kind: "string" },
  "max-age-days": { kind: "positiveInt" },
}));
const tiers = (args.get("tiers") as string[] | undefined) ?? ["SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const divisions = (args.get("divisions") as string[] | undefined) ?? ["II"];
const perDivision = (args.get("per-division") as number | undefined) ?? 40;
const outDir = path.resolve((args.get("out") as string | undefined) ?? ".data/benchmark-sample");
// Only recent games, so the reference reflects the current patches. The build reads this window back from the manifest.
const maxAgeDays = (args.get("max-age-days") as number | undefined) ?? DEFAULT_MAX_AGE_DAYS;

// Development keys allow 100 requests per two minutes; pace below that instead of relying on 429s.
// The pacer's wait timers keep this one-shot script alive, so it never exits in the middle of a wait as if it had finished.
useRiotPacer(new RiotPacer({ keepAlive: true }));
const request = createRiotRequester({ maxRetryDelayMs: 130_000 });
let lastRequest = 0;
async function riot<T>(url: string): Promise<T> {
  const wait = lastRequest + 1250 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
  return request<T>(url);
}

void runSample({ riot, tiers, divisions, perDivision, maxAgeDays, outDir }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Sampling failed."); process.exitCode = 1; });
