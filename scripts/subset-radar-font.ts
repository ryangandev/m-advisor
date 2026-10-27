// Regenerates the /why radar font subsets under assets/fonts from a full Noto Sans SC download.
// It makes no network request: download the font yourself (see assets/fonts/README.md) and pass its path.
//
//   node --import tsx scripts/subset-radar-font.ts --regular <NotoSansSC-Regular.otf> --bold <NotoSansSC-Bold.otf>
//
// Optional: --out <directory> (default assets/fonts) and --pyftsubset <command> (default pyftsubset from fonttools).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import championNames from "../src/data/championNamesZh.json";
import { DIMENSION_LABELS } from "../src/services/horseProfile";
import { HORSE_TIERS } from "../src/services/horseRanking";
import { POSITION_LABELS } from "../src/services/horseVerdict";
import { RADAR_FIXED_TEXT } from "../src/utils/whyRadar";

/** The 3500 characters of the 一级字表 of the 通用规范汉字表 (2013), in table order; its source is in assets/fonts/README.md. */
const LEVEL_ONE_FILE = path.resolve(__dirname, "data", "tgh-level-1.txt");

/** Printable ASCII, then the punctuation and signs the radar or its labels can use. */
const ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCharCode(0x20 + index)).join("");
const PUNCTUATION = "·・　、。〃〈〉《》「」『』【】〔〕〖〗\u2014–…‘’“”•★☆×÷±°℃％～！（），．：；？－";
/** Fullwidth forms of ASCII, which Chinese input methods produce. */
const FULLWIDTH = Array.from({ length: 0xff5e - 0xff01 + 1 }, (_, index) => String.fromCharCode(0xff01 + index)).join("");

/** Every character the bundled subset keeps, sorted by code point. */
export function radarCharacters(): string[] {
  const levelOne = readFileSync(LEVEL_ONE_FILE, "utf8").replace(/\s/g, "");
  const sources = [
    levelOne,
    ASCII,
    PUNCTUATION,
    FULLWIDTH,
    ...RADAR_FIXED_TEXT,
    ...Object.values(DIMENSION_LABELS),
    ...HORSE_TIERS,
    ...Object.values(POSITION_LABELS),
    "未知位置",
    ...Object.values(championNames.names),
  ];
  return [...new Set(sources.flatMap((text) => [...text]))].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
}

function parseArguments(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Unexpected argument: ${name ?? ""}`);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const inputs = [["Regular", args.get("regular")], ["Bold", args.get("bold")]] as const;
  if (inputs.some(([, file]) => !file)) {
    throw new Error("Usage: subset-radar-font.ts --regular <NotoSansSC-Regular.otf> --bold <NotoSansSC-Bold.otf> [--out <directory>] [--pyftsubset <command>]");
  }
  const outDirectory = path.resolve(args.get("out") ?? path.resolve(__dirname, "..", "assets", "fonts"));
  const pyftsubset = args.get("pyftsubset") ?? "pyftsubset";
  const characters = radarCharacters();
  const workDirectory = mkdtempSync(path.join(tmpdir(), "radar-font-"));
  try {
    const textFile = path.join(workDirectory, "characters.txt");
    writeFileSync(textFile, characters.join(""), "utf8");
    for (const [weight, input] of inputs) {
      const output = path.join(outDirectory, `NotoSansSC-${weight}.subset.otf`);
      const result = spawnSync(pyftsubset, [
        path.resolve(input!),
        `--text-file=${textFile}`,
        `--output-file=${output}`,
        // resvg reads plain OTF/TTF, so no woff2. Short horizontal labels need no layout, baseline or vertical tables.
        "--layout-features=",
        "--no-hinting",
        "--name-IDs=*",
        "--name-languages=*",
        "--notdef-outline",
        "--drop-tables+=DSIG,GSUB,GPOS,BASE,VORG,vhea,vmtx",
      ], { stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`pyftsubset failed for ${weight}: ${result.error?.message ?? `exit ${result.status}`}`);
      console.log(`${path.relative(process.cwd(), output)}: ${statSync(output).size} bytes`);
    }
    console.log(`${characters.length} characters kept.`);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) main();
