import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import championNames from "../src/data/championNamesZh.json";
import { radarCharacters } from "../scripts/subset-radar-font";
import { HORSE_TIERS } from "../src/services/horseRanking";
import { POSITION_LABELS, buildVerdict } from "../src/services/horseVerdict";
import { POSITIONS } from "../src/types";
import { RADAR_HEIGHT, RADAR_WIDTH, buildVerdictRadarSvg, radarFontOptions, radarFontSource, renderVerdictRadar } from "../src/utils/whyRadar";
import { fontCodePoints } from "./helpers/fontCmap";
import { seededJungler, seededSupport } from "./helpers/verdicts";

const SNAPSHOT = join(__dirname, "snapshots", "why-radar-support.svg");
/** Review images for people; the directory is ignored by git. */
const REVIEW_DIRECTORY = join(__dirname, "..", "test-results", "why");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(png: Buffer): { width: number; height: number } {
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, "PNG signature");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("the radar SVG matches the reviewed snapshot", () => {
  const svg = buildVerdictRadarSvg(buildVerdict(seededSupport()));
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(join(__dirname, "snapshots"), { recursive: true });
    writeFileSync(SNAPSHOT, `${svg}\n`);
  }
  assert.ok(existsSync(SNAPSHOT), "the snapshot is missing; create it with UPDATE_SNAPSHOTS=1 and review it");
  assert.equal(`${svg}\n`, readFileSync(SNAPSHOT, "utf8"), "run with UPDATE_SNAPSHOTS=1 after reviewing an intended change");
});

test("the radar draws nine axes, the median ring, emphasized key axes and no one else's name", () => {
  const verdict = buildVerdict(seededSupport());
  const svg = buildVerdictRadarSvg(verdict);
  assert.match(svg, /没有马/);
  assert.match(svg, /1\.6 分/);
  assert.match(svg, /锤石·辅助·负·队内第 5\/5/);
  assert.equal((svg.match(/<line /g) ?? []).length, 9);
  assert.equal((svg.match(/stroke-dasharray/g) ?? []).length, 1, "one dashed median ring");
  for (const label of ["★参团", "★视野", "★功能"]) assert.ok(svg.includes(`>${label}<`), label);
  assert.ok(svg.includes(">输出<") && !svg.includes("★输出"), "damage is not a key dimension for a support");
  assert.ok(!svg.includes("模拟数据"), "a real record carries no mock label");
  assert.ok(!svg.includes("support-friend") && !svg.includes("puuid"), "the image never names anyone");
});

test("a mock record is labeled in the image", () => {
  const svg = buildVerdictRadarSvg(buildVerdict(seededSupport({ mock: true })));
  assert.match(svg, />模拟数据</);
  assert.match(svg, /模拟数据，不计入真实档案/);
});

test("a missing dimension is labeled as missing instead of drawn as a score", () => {
  const svg = buildVerdictRadarSvg(buildVerdict(seededSupport({ dimensions: { damage: 0.4, vision: 0.2 } })));
  assert.equal((svg.match(/>无数据</g) ?? []).length, 7);
  assert.equal((svg.match(/<circle /g) ?? []).length, 2);
});

test("champion names from records are escaped", () => {
  const svg = buildVerdictRadarSvg(buildVerdict(seededSupport({ championId: 999_999, championName: "<Kai'Sa&>" })));
  assert.ok(svg.includes("&#60;Kai&#39;Sa&#38;&#62;"));
  assert.ok(!svg.includes("<Kai"));
});

test("the radar renders a valid PNG of the expected size for review", async () => {
  mkdirSync(REVIEW_DIRECTORY, { recursive: true });
  for (const [name, record] of [["no-horse-support", seededSupport()], ["top-horse-jungler", seededJungler()], ["mock-support", seededSupport({ mock: true })]] as const) {
    const png = await renderVerdictRadar(buildVerdict(record));
    assert.deepEqual(pngSize(png), { width: RADAR_WIDTH, height: RADAR_HEIGHT });
    assert.ok(png.length > 20_000 && png.length < 1_000_000, `${name} is ${png.length} bytes`);
    writeFileSync(join(REVIEW_DIRECTORY, `${name}.png`), png);
  }
});

type FontOptions = { loadSystemFonts: boolean; fontFiles: string[] };
const render = (svg: string, font: FontOptions) => new Resvg(svg, { font }).render().pixels;

/** The number of non-transparent pixels, for text drawn on a transparent background. */
function ink(svg: string, font: FontOptions): number {
  const pixels = render(svg, font);
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1;
  return count;
}

/** The number of pixels that differ between two renderings of the same size. */
function difference(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) count += 1;
  }
  return count;
}

const labelSvg = (text: string, family = "'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB'") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text x="5" y="42" font-size="36" font-family="${family}">${text}</text></svg>`;

test("the bundled radar font is Noto Sans SC in regular and bold, with its license, and stays small", () => {
  const source = radarFontSource();
  assert.deepEqual(source.bundled.map((file) => file.split("/").pop()), ["NotoSansSC-Regular.subset.otf", "NotoSansSC-Bold.subset.otf"]);
  const total = source.bundled.reduce((sum, file) => sum + statSync(file).size, 0);
  assert.ok(total < 2_000_000, `the bundled fonts are ${total} bytes`);
  const license = readFileSync(join(__dirname, "..", "assets", "fonts", "LICENSE"), "utf8");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(buildVerdictRadarSvg(buildVerdict(seededSupport())), /font-family="'Noto Sans SC', /);
});

test("the bundled subset covers every character the radar can draw", () => {
  const covered = fontCodePoints(radarFontSource().bundled[0]);
  assert.deepEqual(fontCodePoints(radarFontSource().bundled[1]), covered, "regular and bold keep the same characters");
  const missing = new Set<string>();
  const needs = (text: string) => { for (const character of text.replace(/[\r\n]/g, "")) if (!covered.has(character.codePointAt(0)!)) missing.add(character); };

  // The characters the subset script keeps are really in the files.
  for (const character of radarCharacters()) needs(character);
  // Every text node of real SVGs: each champion with each tier and position, real and mock, with and without data.
  const champions = Object.entries(championNames.names);
  champions.forEach(([id, name], index) => {
    const tier = HORSE_TIERS[index % HORSE_TIERS.length];
    const position = POSITIONS[index % POSITIONS.length];
    for (const mock of [false, true]) {
      const svg = buildVerdictRadarSvg(buildVerdict(seededSupport({ championId: Number(id), championName: name, tier, position, mock, won: index % 2 === 0 })));
      needs(svg.replace(/<[^>]*>/g, ""));
    }
  });
  needs(buildVerdictRadarSvg(buildVerdict(seededSupport({ position: null, dimensions: { damage: 0.4 } }))).replace(/<[^>]*>/g, ""));
  for (const label of [...HORSE_TIERS, ...Object.values(POSITION_LABELS), "未知位置"]) needs(label);
  assert.deepEqual([...missing], [], "characters the radar draws but the bundled font lacks");
  assert.ok(covered.size >= 3500, `${covered.size} code points in the subset`);
});

test("with system fonts disabled the radar still draws its Chinese labels from the bundled font", async () => {
  const bundledOnly = radarFontOptions(false);
  assert.equal(bundledOnly.loadSystemFonts, false);
  assert.deepEqual(bundledOnly.fontFiles, radarFontSource().bundled);
  assert.ok(ink(labelSvg("没有马参团视野"), bundledOnly) > 1500);
  assert.equal(ink(labelSvg("没有马参团视野", "'Hiragino Sans GB'"), { loadSystemFonts: false, fontFiles: [] }), 0, "with no font at all nothing is drawn");

  // The whole radar: the same card with its text removed has far fewer inked pixels.
  const svg = buildVerdictRadarSvg(buildVerdict(seededSupport()));
  const labelPixels = difference(render(svg, bundledOnly), render(svg.replace(/<text[^>]*>.*?<\/text>/g, ""), bundledOnly));
  assert.ok(labelPixels > 15_000, `the labels drew ${labelPixels} pixels`);
  const png = await renderVerdictRadar(buildVerdict(seededSupport()), { systemFonts: false });
  assert.deepEqual(pngSize(png), { width: RADAR_WIDTH, height: RADAR_HEIGHT });
});

test("the bundled bold weight is a different face from the regular one", () => {
  const [regular, bold] = radarFontSource().bundled;
  const text = "输出参团";
  const regularInk = ink(labelSvg(text), { loadSystemFonts: false, fontFiles: [regular] });
  const boldInk = ink(labelSvg(text).replace("<text ", `<text font-weight="bold" `), { loadSystemFonts: false, fontFiles: [regular, bold] });
  assert.ok(boldInk > regularInk, `bold ${boldInk} vs regular ${regularInk}`);
});

test("a character outside the subset falls back to a system CJK font when one exists", { skip: process.platform !== "darwin" }, () => {
  const outside = "镕";
  assert.ok(!fontCodePoints(radarFontSource().bundled[0]).has(outside.codePointAt(0)!), "the test character must be outside the subset");
  assert.ok(radarFontSource().system.length > 0);
  // Without a system font the missing glyph is the font's placeholder box; with one, the real character is drawn instead.
  const placeholder = render(labelSvg(outside), radarFontOptions(false));
  const fallback = render(labelSvg(outside), radarFontOptions(true));
  assert.ok(difference(placeholder, fallback) > 100, "a system font draws the character instead of the placeholder");
  assert.ok(ink(labelSvg(outside), radarFontOptions(true)) > 100);
  // The covered characters of the same name still come from the bundled font.
  const mixedBundled = render(labelSvg(`没有马${outside}`), radarFontOptions(false));
  const mixedFallback = render(labelSvg(`没有马${outside}`), radarFontOptions(true));
  assert.ok(difference(mixedBundled, mixedFallback) > 100);
  assert.ok(difference(render(labelSvg("没有马"), radarFontOptions(false)), render(labelSvg("没有马"), radarFontOptions(true))) === 0, "covered text is identical with or without system fonts");
});
