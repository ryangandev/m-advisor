# Codex Task: Replace macOS `say` TTS with Azure Cognitive Services TTS

## Goal
Replace the current `generateTTS()` in `src/utils/tts.ts` with Azure TTS REST API.
The function must become async. Update all callers accordingly.
The bot should still work exactly the same — just use Azure instead of macOS `say`.

## Why
`say` is a synchronous blocking call that drops the Discord voice connection.
Azure TTS is async (non-blocking) and supports Chinese (Mandarin, Cantonese) + English.

## Implementation

### 1. Install dependencies
```bash
npm install node-fetch@3
```
Actually, use Node.js built-in `fetch` (Node 18+ has it). No extra deps needed.

### 2. Voice mapping
Define voices for Chinese and English:
```typescript
const VOICES = {
  // Chinese (Mandarin)
  zh: 'zh-CN-XiaoxiaoNeural',
  // Cantonese
  'zh-HK': 'zh-HK-HiuGaaiNeural',
  // English
  en: 'en-US-AriaNeural',
  // Legacy style aliases (keep for announcer command compatibility)
  sweet: 'zh-CN-XiaoxiaoNeural',
  old: 'zh-CN-YunxiNeural',
} as const;
```

### 3. Rewrite `src/utils/tts.ts`
```typescript
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import ffmpegStatic from "ffmpeg-static";
import { spawn } from "node:child_process";

const VOICES: Record<string, string> = {
  sweet: "zh-CN-XiaoxiaoNeural",
  old: "zh-CN-YunxiNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  "zh-HK": "zh-HK-HiuGaaiNeural",
  en: "en-US-AriaNeural",
};

export async function generateTTS(text: string, style: string = "sweet"): Promise<string> {
  const voice = VOICES[style] ?? VOICES["sweet"];
  const langCode = voice.slice(0, 5); // e.g. "zh-CN"

  const key = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION;
  if (!key || !region) {
    throw new Error("AZURE_TTS_KEY and AZURE_TTS_REGION must be set in .env");
  }

  const ssml = `<speak version='1.0' xml:lang='${langCode}'>
    <voice xml:lang='${langCode}' name='${voice}'>${text}</voice>
  </speak>`;

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
    }
  );

  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`Azure TTS failed: ${response.status} ${msg}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const base = path.join(os.tmpdir(), `tts-${Date.now()}`);
  const mp3Path = `${base}.mp3`;
  writeFileSync(mp3Path, audioBuffer);
  return mp3Path;
}
```

### 4. Update callers — generateTTS is now async

In `src/commands/testvc.ts`:
- Change `ttsPath = generateTTS(text, "sweet")` → `ttsPath = await generateTTS(text, "sweet")`
- The outer execute function is already async, so this is fine

In `src/services/gameMonitor.ts`:
- Change `ttsPath = generateTTS(text, style)` → `ttsPath = await generateTTS(text, style)`

### 5. Audio playback — use MP3 directly
Since we now have MP3 (not WAV), use StreamType.Arbitrary with the file path directly:
```typescript
// Replace the ffmpeg spawn + StreamType.Raw approach with:
import { createReadStream } from "node:fs";
const resource = createAudioResource(mp3Path, {
  inputType: StreamType.Arbitrary, // discord voice will use ffmpeg internally to decode MP3
});
```
Remove the `ffmpegProcess` spawn, `ffmpegProcess.kill()` in finally, and related imports.

### 6. Update .env.example
Add:
```
# Azure Text-to-Speech
AZURE_TTS_KEY=your_azure_speech_key_here
AZURE_TTS_REGION=eastus
```

### 7. Remove dead code
- Remove unused `execFileSync`, `execSync` imports from tts.ts
- Remove `afinfo` validation code if present (from previous Codex patch)
- Remove the old `say`-based implementation entirely

### 8. Build & verify
Run `npm run build` — must pass with 0 TypeScript errors.
Fix any type errors.

## Do NOT
- Do not change `.env` (actual secrets file)
- Do not change slash command logic
- Do not remove `/testvc` command
- Do not change tsconfig.json or package.json scripts
