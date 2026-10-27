import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderAsync } from "@resvg/resvg-js";
import { DIMENSION_LABELS } from "../services/horseProfile";
import type { HorseTier } from "../services/horseRanking";
import { MEDIAN } from "../services/horseVerdict";
import type { Verdict } from "../services/horseVerdict";
import { formatScore } from "../services/announcementText";
import { logWarn } from "./log";
import { championLabel } from "./stableEmbed";

export const RADAR_WIDTH = 800;
export const RADAR_HEIGHT = 940;

/**
 * The card carries its own dark background, so it reads the same in Discord's light and dark themes.
 * Tier colors are chosen to stay readable on that background.
 */
const COLORS = {
  card: "#171B24",
  cardEdge: "#2A3040",
  text: "#F2F4F8",
  muted: "#A3AABA",
  faint: "#8C94A6",
  grid: "#343B4C",
  keyAxis: "#6B7487",
  median: "#9AA3B5",
  below: "#FF8A80",
  above: "#7FD89A",
  badge: "#5A6170",
} as const;

export const TIER_COLORS: Record<HorseTier, string> = {
  特等马: "#F5C542",
  上等马: "#4FC3F7",
  中等马: "#81C784",
  下等马: "#FFB74D",
  没有马: "#EF5350",
};

/**
 * The font family of the bundled subset (see assets/fonts/README.md), then CJK families in order of preference.
 * A glyph the bundled subset lacks is drawn by the first listed system family that has it.
 */
const FONT_FAMILIES = ["Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei"];

/** The font subset shipped with the bot, regular first. `src/utils` and `dist/utils` are both two levels below the repository root. */
const BUNDLED_FONT_DIRECTORY = join(__dirname, "..", "..", "assets", "fonts");
const BUNDLED_FONT_NAMES = ["NotoSansSC-Regular.subset.otf", "NotoSansSC-Bold.subset.otf"];

/**
 * Known locations of system CJK fonts on macOS, Linux and Windows, the fallback for glyphs the bundled subset lacks.
 * Loading only these is much faster than scanning every system font.
 */
const FONT_FILES = [
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\msyhbd.ttc",
];

export interface RadarFontSource {
  /** The bundled font subset files that exist. */
  bundled: string[];
  /** The known system CJK font files found on this machine, the fallback for glyphs outside the subset. */
  system: string[];
  /** True only when neither was found, so every system font is scanned as the last resort. */
  systemScan: boolean;
}

let fontSource: RadarFontSource | undefined;

/** Which fonts the radar is drawn with, found once per process. */
export function radarFontSource(): RadarFontSource {
  if (!fontSource) {
    const bundled = BUNDLED_FONT_NAMES.map((name) => join(BUNDLED_FONT_DIRECTORY, name)).filter((file) => existsSync(file));
    const system = FONT_FILES.filter((file) => existsSync(file));
    fontSource = { bundled, system, systemScan: bundled.length === 0 && system.length === 0 };
    if (bundled.length === 0) logWarn("The bundled /why radar font is missing from assets/fonts; falling back to system fonts.");
    if (fontSource.systemScan) logWarn("No known CJK font file was found; the /why radar scans all system fonts instead.");
  }
  return fontSource;
}

/** The resvg font options: the bundled subset first, then the system fallback unless `system` is false. */
export function radarFontOptions(system = true): { loadSystemFonts: boolean; fontFiles: string[] } {
  const source = radarFontSource();
  return {
    loadSystemFonts: system && source.systemScan,
    fontFiles: system ? [...source.bundled, ...source.system] : [...source.bundled],
  };
}

/**
 * The fixed strings the radar draws itself. The labels from other modules (dimension names, tiers, positions, champion
 * names) are listed by scripts/subset-radar-font.ts, which together with these decides which characters the bundled font keeps.
 */
const TEXT = {
  score: "分",
  won: "胜",
  lost: "负",
  teamRank: "队内第",
  separator: "·",
  keyMark: "★",
  noData: "无数据",
  mockBadge: "模拟数据",
  legendKey: "最看重的维度　虚线 = 同位置中位数 (50%)",
  legendPercent: "百分比 = 这一项超过了多少同位置玩家",
  legendMock: "　模拟数据，不计入真实档案",
} as const;
export const RADAR_FIXED_TEXT: readonly string[] = Object.values(TEXT);

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const fixed = (value: number) => value.toFixed(1);
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The radar of one verdict as SVG: nine dimensions against the same position, with the median ring for reference. */
export function buildVerdictRadarSvg(verdict: Verdict): string {
  const { record } = verdict;
  const tierColor = TIER_COLORS[record.tier];
  const centerX = RADAR_WIDTH / 2;
  const centerY = 525;
  const radius = 225;
  const count = verdict.dimensions.length;
  const angle = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / count;
  const point = (index: number, distance: number) =>
    [centerX + Math.cos(angle(index)) * distance, centerY + Math.sin(angle(index)) * distance] as const;
  const ring = (fraction: number) => verdict.dimensions.map((_, index) => point(index, radius * fraction).map(fixed).join(",")).join(" ");

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${RADAR_WIDTH}" height="${RADAR_HEIGHT}" viewBox="0 0 ${RADAR_WIDTH} ${RADAR_HEIGHT}" font-family="${FONT_FAMILIES.map((family) => `'${family}'`).join(", ")}, sans-serif">`);
  parts.push(`<rect x="1" y="1" width="${RADAR_WIDTH - 2}" height="${RADAR_HEIGHT - 2}" rx="32" fill="${COLORS.card}" stroke="${COLORS.cardEdge}" stroke-width="2"/>`);

  // Header: the verdict, then what was played.
  parts.push(`<text x="48" y="96" font-size="56" font-weight="bold"><tspan fill="${tierColor}">${escapeXml(record.tier)}</tspan><tspan dx="24" fill="${COLORS.text}">${formatScore(record.score)} ${TEXT.score}</tspan></text>`);
  const subtitle = [championLabel(record), verdict.positionLabel, record.won ? TEXT.won : TEXT.lost, `${TEXT.teamRank} ${record.teamRank}/${record.teamSize}`].join(TEXT.separator);
  parts.push(`<text x="48" y="146" font-size="28" fill="${COLORS.muted}">${escapeXml(subtitle)}</text>`);
  if (record.mock) {
    parts.push(`<rect x="588" y="48" width="164" height="52" rx="26" fill="${COLORS.badge}"/>`);
    parts.push(`<text x="670" y="84" font-size="28" font-weight="bold" fill="${COLORS.text}" text-anchor="middle">${TEXT.mockBadge}</text>`);
  }

  // Grid: quarter rings, the dashed median ring and one axis per dimension, brighter where the position looks most.
  for (const fraction of [0.25, 0.75, 1]) {
    parts.push(`<polygon points="${ring(fraction)}" fill="none" stroke="${COLORS.grid}" stroke-width="1.5"/>`);
  }
  verdict.dimensions.forEach((entry, index) => {
    const [x, y] = point(index, radius);
    parts.push(`<line x1="${fixed(centerX)}" y1="${fixed(centerY)}" x2="${fixed(x)}" y2="${fixed(y)}" stroke="${entry.key ? COLORS.keyAxis : COLORS.grid}" stroke-width="${entry.key ? 2.5 : 1.5}"/>`);
  });
  parts.push(`<polygon points="${ring(MEDIAN)}" fill="none" stroke="${COLORS.median}" stroke-width="2.5" stroke-dasharray="10 8"/>`);

  // The member: a missing dimension sits at the centre and is labelled as missing rather than as zero.
  const vertices = verdict.dimensions.map((entry, index) => point(index, radius * (entry.percentile ?? 0)));
  parts.push(`<polygon points="${vertices.map((vertex) => vertex.map(fixed).join(",")).join(" ")}" fill="${tierColor}" fill-opacity="0.28" stroke="${tierColor}" stroke-width="4" stroke-linejoin="round"/>`);
  verdict.dimensions.forEach((entry, index) => {
    if (entry.percentile === undefined) return;
    const [x, y] = vertices[index];
    parts.push(`<circle cx="${fixed(x)}" cy="${fixed(y)}" r="7" fill="${tierColor}" stroke="${COLORS.card}" stroke-width="2"/>`);
  });

  // Labels: name and percentile outside each axis.
  verdict.dimensions.forEach((entry, index) => {
    const [x, y] = point(index, radius + 46);
    const cos = Math.cos(angle(index));
    const sin = Math.sin(angle(index));
    const anchor = cos > 0.25 ? "start" : cos < -0.25 ? "end" : "middle";
    const nameY = sin < -0.5 ? y - 36 : sin > 0.5 ? y + 22 : y - 4;
    const name = `${entry.key ? TEXT.keyMark : ""}${DIMENSION_LABELS[entry.dimension]}`;
    const value = entry.percentile === undefined ? TEXT.noData : percent(entry.percentile);
    const valueColor = entry.percentile === undefined ? COLORS.keyAxis : entry.percentile < MEDIAN ? COLORS.below : COLORS.above;
    parts.push(`<text x="${fixed(x)}" y="${fixed(nameY)}" font-size="30" text-anchor="${anchor}" fill="${entry.key ? COLORS.text : COLORS.muted}"${entry.key ? ` font-weight="bold"` : ""}>${name}</text>`);
    parts.push(`<text x="${fixed(x)}" y="${fixed(nameY + 32)}" font-size="26" text-anchor="${anchor}" fill="${valueColor}">${value}</text>`);
  });

  // Legend.
  parts.push(`<text x="48" y="880" font-size="22" fill="${COLORS.faint}">${TEXT.keyMark} ${escapeXml(verdict.positionLabel)}${TEXT.legendKey}</text>`);
  parts.push(`<text x="48" y="912" font-size="22" fill="${COLORS.faint}">${TEXT.legendPercent}${record.mock ? TEXT.legendMock : ""}</text>`);
  parts.push("</svg>");
  return parts.join("\n");
}

/** Rasterizes the radar to a PNG off the main thread. */
export async function renderVerdictRadar(verdict: Verdict, options: { systemFonts?: boolean } = {}): Promise<Buffer> {
  const image = await renderAsync(buildVerdictRadarSvg(verdict), {
    font: radarFontOptions(options.systemFonts ?? true),
    fitTo: { mode: "width", value: RADAR_WIDTH },
    logLevel: "off",
  });
  return image.asPng();
}
