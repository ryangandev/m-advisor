import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const VOICES = { sweet: "Samantha", old: "Albert" } as const;

export function generateTTS(text: string, style: "sweet" | "old" = "sweet"): string {
  const voice = VOICES[style];
  const outputPath = path.join(os.tmpdir(), `m-advisor-${Date.now()}.aiff`);
  const escapedText = text.replace(/"/g, '\\"');

  execSync(`say -v "${voice}" -o "${outputPath}" "${escapedText}"`);
  return outputPath;
}
