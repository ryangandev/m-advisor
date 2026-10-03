// Refreshes src/data/championNamesZh.json from Riot's public Data Dragon (no API key required).
// Run after a patch adds champions; unknown champions fall back to their English identifier.
import { writeFileSync } from "node:fs";
import path from "node:path";

async function update(): Promise<void> {
  const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json() as string[];
  const version = versions[0];
  const body = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/champion.json`)).json() as {
    data: Record<string, { key: string; title: string }>;
  };
  // In zh_CN data the short spoken name (亚索) is `title`; `name` holds the epithet (疾风剑豪).
  const names = Object.fromEntries(Object.values(body.data)
    .map((champion) => [champion.key, champion.title] as const)
    .sort(([a], [b]) => Number(a) - Number(b)));
  const output = path.resolve("src/data/championNamesZh.json");
  writeFileSync(output, `${JSON.stringify({ version, names }, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(names).length} champion names for patch ${version} to ${output}.`);
}
void update().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Update failed."); process.exitCode = 1; });
