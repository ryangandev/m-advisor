import { rm } from "node:fs/promises";
import { LocalTtsService, type LocalTtsStatus } from "../services/localTts";
import { isStopping } from "../services/shutdownState";

let localTts: LocalTtsService | undefined;
let stopped = false;
let shutdownPromise: Promise<void> | undefined;

function assertRunning(): void {
  if (stopped || isStopping()) throw new Error("TTS has been shut down.");
}

function localService(): LocalTtsService {
  localTts ??= new LocalTtsService();
  return localTts;
}

export async function generateTTS(text: string, style = "old"): Promise<string> {
  assertRunning();
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("TTS text cannot be empty.");
  }
  if (normalizedText.length > 1_000) {
    throw new Error("TTS text must be at most 1000 characters.");
  }
  const output = await localService().generate(normalizedText, style);
  // Speech that finishes after shutdown began must never reach a voice channel.
  if (stopped || isStopping()) {
    await rm(output, { force: true }).catch(() => {});
    throw new Error("TTS has been shut down.");
  }
  return output;
}

export async function checkTTS(): Promise<LocalTtsStatus> {
  assertRunning();
  const result = await localService().prewarm();
  assertRunning();
  return result;
}

export async function prewarmTTS(): Promise<void> {
  await checkTTS();
}

export function shutdownTTS(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopped = true;
  shutdownPromise = (async () => { await localTts?.shutdown(); })();
  return shutdownPromise;
}
