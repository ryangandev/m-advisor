import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const AZURE_OUTPUT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";

const VOICES: Readonly<Record<string, string>> = {
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

function buildSsml(text: string, voice: string): string {
  const langCode = voice.slice(0, 5);

  return [
    `<speak version='1.0' xml:lang='${langCode}'>`,
    `  <voice xml:lang='${langCode}' name='${voice}'>${escapeXml(text)}</voice>`,
    "</speak>",
  ].join("\n");
}

async function getAzureErrorMessage(response: Response): Promise<string> {
  const details = (await response.text().catch(() => "")).trim();

  switch (response.status) {
    case 401:
    case 403:
      return "Azure TTS authentication failed.";
    case 404:
      return "Azure TTS region is invalid or unavailable.";
    case 429:
      return "Azure TTS rate limit reached.";
    default:
      if (response.status >= 500) {
        return "Azure TTS service is unavailable.";
      }

      return details
        ? `Azure TTS request failed (${response.status}): ${details}`
        : `Azure TTS request failed (${response.status} ${response.statusText}).`;
  }
}

export async function generateTTS(text: string, style = "sweet"): Promise<string> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("TTS text cannot be empty.");
  }

  const key = process.env.AZURE_TTS_KEY?.trim();
  const region = process.env.AZURE_TTS_REGION?.trim();

  if (!key || !region) {
    throw new Error("Azure TTS is not configured.");
  }

  const voice = VOICES[style] ?? VOICES.sweet;
  const ssml = buildSsml(normalizedText, voice);

  let response: Response;
  try {
    response = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT,
          "User-Agent": "m-advisor",
        },
        body: ssml,
      },
    );
  } catch {
    throw new Error("Azure TTS service could not be reached.");
  }

  if (!response.ok) {
    throw new Error(await getAzureErrorMessage(response));
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (audioBuffer.length === 0) {
    throw new Error("Azure TTS returned an empty audio response.");
  }

  const mp3Path = path.join(os.tmpdir(), `m-advisor-${Date.now()}-${randomUUID()}.mp3`);
  await writeFile(mp3Path, audioBuffer);
  return mp3Path;
}
