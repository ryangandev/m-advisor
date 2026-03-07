import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const VOICES: Record<string, string> = {
  sweet: "zh-CN-XiaoxiaoNeural",
  old: "zh-CN-YunxiNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  "zh-HK": "zh-HK-HiuGaaiNeural",
  en: "en-US-AriaNeural",
};

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function generateTTS(text: string, style = "sweet"): Promise<string> {
  const voice = VOICES[style] ?? VOICES.sweet;
  const langCode = voice.slice(0, 5);

  const key = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION;

  if (!key || !region) {
    throw new Error("AZURE_TTS_KEY and AZURE_TTS_REGION must be set in .env");
  }

  const ssml = [
    `<speak version='1.0' xml:lang='${langCode}'>`,
    `  <voice xml:lang='${langCode}' name='${voice}'>${escapeXml(text)}</voice>`,
    "</speak>",
  ].join("\n");

  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
        "User-Agent": "m-advisor",
      },
      body: ssml,
    },
  );

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`Azure TTS failed: ${response.status} ${message}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const base = path.join(os.tmpdir(), `m-advisor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const mp3Path = `${base}.mp3`;
  writeFileSync(mp3Path, audioBuffer);
  return mp3Path;
}
