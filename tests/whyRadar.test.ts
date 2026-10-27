import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { buildVerdict } from "../src/services/horseVerdict";
import { RADAR_HEIGHT, RADAR_WIDTH, buildVerdictRadarSvg, radarFontSource, renderVerdictRadar } from "../src/utils/whyRadar";
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

test("a known CJK font is used on macOS and draws Chinese labels", { skip: process.platform !== "darwin" }, () => {
  const source = radarFontSource();
  assert.equal(source.systemScan, false);
  assert.ok(source.files.length > 0);
  const label = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><text x="5" y="38" font-size="32" font-family="'PingFang SC', 'Hiragino Sans GB', 'Heiti SC'">没有马</text></svg>`,
    { font: { loadSystemFonts: false, fontFiles: source.files } },
  ).render();
  let ink = 0;
  for (let index = 3; index < label.pixels.length; index += 4) if (label.pixels[index] > 0) ink += 1;
  assert.ok(ink > 500, `the label drew ${ink} pixels`);
});
