import { existsSync } from "node:fs";
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

/** CJK families in order of preference; the first one installed is used. */
const FONT_FAMILIES = ["PingFang SC", "Hiragino Sans GB", "Heiti SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei"];

/**
 * Known locations of system CJK fonts on macOS, Linux and Windows. Loading only these is much faster than scanning
 * every system font; when none exists the renderer falls back to the full system scan, and nothing is bundled.
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
  /** The known CJK font files found on this machine. */
  files: string[];
  /** True when none was found and every system font is scanned instead. */
  systemScan: boolean;
}

let fontSource: RadarFontSource | undefined;

/** Which fonts the radar is drawn with, found once per process. */
export function radarFontSource(): RadarFontSource {
  if (!fontSource) {
    const files = FONT_FILES.filter((file) => existsSync(file));
    fontSource = { files, systemScan: files.length === 0 };
    if (fontSource.systemScan) logWarn("No known CJK font file was found; the /why radar scans all system fonts instead.");
  }
  return fontSource;
}

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
  parts.push(`<text x="48" y="96" font-size="56" font-weight="bold"><tspan fill="${tierColor}">${escapeXml(record.tier)}</tspan><tspan dx="24" fill="${COLORS.text}">${formatScore(record.score)} 分</tspan></text>`);
  const subtitle = [championLabel(record), verdict.positionLabel, record.won ? "胜" : "负", `队内第 ${record.teamRank}/${record.teamSize}`].join("·");
  parts.push(`<text x="48" y="146" font-size="28" fill="${COLORS.muted}">${escapeXml(subtitle)}</text>`);
  if (record.mock) {
    parts.push(`<rect x="588" y="48" width="164" height="52" rx="26" fill="${COLORS.badge}"/>`);
    parts.push(`<text x="670" y="84" font-size="28" font-weight="bold" fill="${COLORS.text}" text-anchor="middle">模拟数据</text>`);
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
    const name = `${entry.key ? "★" : ""}${DIMENSION_LABELS[entry.dimension]}`;
    const value = entry.percentile === undefined ? "无数据" : percent(entry.percentile);
    const valueColor = entry.percentile === undefined ? COLORS.keyAxis : entry.percentile < MEDIAN ? COLORS.below : COLORS.above;
    parts.push(`<text x="${fixed(x)}" y="${fixed(nameY)}" font-size="30" text-anchor="${anchor}" fill="${entry.key ? COLORS.text : COLORS.muted}"${entry.key ? ` font-weight="bold"` : ""}>${name}</text>`);
    parts.push(`<text x="${fixed(x)}" y="${fixed(nameY + 32)}" font-size="26" text-anchor="${anchor}" fill="${valueColor}">${value}</text>`);
  });

  // Legend.
  parts.push(`<text x="48" y="880" font-size="22" fill="${COLORS.faint}">★ ${escapeXml(verdict.positionLabel)}最看重的维度　虚线 = 同位置中位数 (50%)</text>`);
  parts.push(`<text x="48" y="912" font-size="22" fill="${COLORS.faint}">百分比 = 这一项超过了多少同位置玩家${record.mock ? "　模拟数据，不计入真实档案" : ""}</text>`);
  parts.push("</svg>");
  return parts.join("\n");
}

/** Rasterizes the radar to a PNG off the main thread. */
export async function renderVerdictRadar(verdict: Verdict): Promise<Buffer> {
  const source = radarFontSource();
  const image = await renderAsync(buildVerdictRadarSvg(verdict), {
    font: {
      loadSystemFonts: source.systemScan,
      fontFiles: source.files,
    },
    fitTo: { mode: "width", value: RADAR_WIDTH },
    logLevel: "off",
  });
  return image.asPng();
}
