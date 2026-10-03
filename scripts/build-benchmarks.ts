// Builds src/data/roleBenchmarks.json from the sample collected by scripts/sample-matches.ts and
// prints a fairness report: each position should be 特等马 or 没有马 about equally often.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildBenchmarks, HORSE_TIERS, rankTeam } from "../src/services/horseRanking";
import { parseMatchDetail } from "../src/utils/riotMatchApi";
import { POSITIONS } from "../src/types";
import type { MatchDetail } from "../src/types";

const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=") as [string, string]));
const sampleDir = path.resolve(args.get("sample") ?? ".data/benchmark-sample");
// Older games reflect outdated patches; the sampler keeps them on disk, so filter here as well.
const oldest = Date.now() - Number(args.get("max-age-days") ?? 60) * 86_400_000;
const output = path.resolve("src/data/roleBenchmarks.json");
const matches: MatchDetail[] = [];
const tiers = new Set<string>();
const patches = new Set<string>();
for (const file of readdirSync(sampleDir).filter((name) => name.endsWith(".json")).sort()) {
  const raw = JSON.parse(readFileSync(path.join(sampleDir, file), "utf8"));
  const detail = parseMatchDetail(raw, raw.metadata?.matchId);
  // Remakes, aborted games and very short games say little about normal performance.
  if (detail.info.queueId !== 420 || detail.info.earlySurrender || detail.info.aborted || detail.info.gameDuration < 600) continue;
  if (typeof raw.info?.gameCreation !== "number" || raw.info.gameCreation < oldest) continue;
  if (detail.info.participants.length !== 10 || detail.info.participants.some((player) => !player.position)) continue;
  matches.push(detail);
  if (typeof raw._tier === "string") tiers.add(raw._tier);
  if (typeof raw.info?.gameVersion === "string") patches.add(raw.info.gameVersion.split(".").slice(0, 2).join("."));
}
if (matches.length < 50) throw new Error(`Only ${matches.length} usable matches; collect more before building benchmarks.`);

const benchmarks = buildBenchmarks(matches, {
  matches: matches.length,
  tiers: [...tiers].sort(),
  patches: [...patches].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  collectedAt: new Date().toISOString().slice(0, 10),
});
writeFileSync(output, `${JSON.stringify(benchmarks)}\n`);
console.log(`Wrote ${output} from ${matches.length} matches.`);

// Fairness report over both teams of every sampled match.
const counts = new Map<string, number>();
let topScoreWins = 0;
let comparisons = 0;
for (const detail of matches) {
  const leaders: Array<{ score: number; won: boolean }> = [];
  for (const teamId of [100, 200]) {
    const anchor = detail.info.participants.find((player) => player.teamId === teamId)!;
    const ranking = rankTeam(detail, anchor.puuid, benchmarks);
    for (const horse of ranking.horses) {
      const key = `${horse.tier}:${horse.participant.position}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    leaders.push({ score: ranking.horses[0].score, won: ranking.won });
  }
  comparisons++;
  if (leaders.find((leader) => leader.won)!.score > leaders.find((leader) => !leader.won)!.score) topScoreWins++;
}
const teams = matches.length * 2;
console.log("\nShare of teams where each position received the tier (ideal 20%):");
console.log(["tier", ...POSITIONS].join("\t"));
for (const tier of HORSE_TIERS) {
  console.log([tier, ...POSITIONS.map((position) => `${Math.round(((counts.get(`${tier}:${position}`) ?? 0) / teams) * 100)}%`)].join("\t"));
}
console.log(`\nWinning team's 特等马 outscored the losing team's in ${Math.round((topScoreWins / comparisons) * 100)}% of matches.`);
