import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import ffmpegStatic from "ffmpeg-static";

const VOICES = { sweet: "Samantha", old: "Albert" } as const;

export function generateTTS(text: string, style: "sweet" | "old" = "sweet"): string {
  const voice = VOICES[style];
  const base = path.join(os.tmpdir(), `m-advisor-${Date.now()}`);
  const aiffPath = `${base}.aiff`;
  const wavPath = `${base}.wav`;
  const ffmpeg = ffmpegStatic ?? "ffmpeg";

  const escaped = text.replace(/"/g, '\\"').replace(/`/g, "\\`");
  execSync(`/usr/bin/say -v "${voice}" -o "${aiffPath}" "${escaped}"`);
  execSync(`${ffmpeg} -y -i "${aiffPath}" -ar 48000 -ac 2 "${wavPath}" 2>/dev/null`);

  try {
    unlinkSync(aiffPath);
  } catch {
    // Best-effort cleanup.
  }

  return wavPath;
}
