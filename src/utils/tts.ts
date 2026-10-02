import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalTtsService, type LocalTtsStatus } from "../services/localTts";

const AZURE_OUTPUT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";
let localTts: LocalTtsService | undefined;
const azureOutputs = new Set<string>();

function provider(): "local" | "azure" {
  const selected = process.env.TTS_PROVIDER?.trim() || "local";
  if (selected !== "local" && selected !== "azure") {
    throw new Error("TTS_PROVIDER must be local or azure.");
  }
  return selected;
}

function localService(): LocalTtsService {
  localTts ??= new LocalTtsService();
  return localTts;
}

function azureConfiguration(): { key: string; region: string } {
  const key = process.env.AZURE_TTS_KEY?.trim();
  const region = process.env.AZURE_TTS_REGION?.trim();
  if (!key || !region || !/^[a-z0-9-]+$/.test(region)) {
    throw new Error("Azure TTS is not configured with a valid key and region.");
  }
  return { key, region };
}

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

      // Service response bodies can contain request details and credentials.
      return `Azure TTS request failed (${response.status}).`;
  }
}

export async function generateTTS(text: string, style = "sweet"): Promise<string> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("TTS text cannot be empty.");
  }
  if (normalizedText.length > 1_000) {
    throw new Error("TTS text must be at most 1000 characters.");
  }
  if (provider() === "local") return localService().generate(normalizedText, style);

  const { key, region } = azureConfiguration();

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
        signal: AbortSignal.timeout(30_000),
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
  azureOutputs.add(mp3Path);
  return mp3Path;
}

export async function checkTTS(): Promise<LocalTtsStatus | { provider: "azure"; ready: true }> {
  if (provider() === "local") return localService().prewarm();
  azureConfiguration();
  return { provider: "azure", ready: true };
}

export async function prewarmTTS(): Promise<void> {
  await checkTTS();
}

export async function shutdownTTS(): Promise<void> {
  await localTts?.shutdown();
  await Promise.all([...azureOutputs].map((output) => rm(output, { force: true }).catch(() => {})));
  azureOutputs.clear();
}
