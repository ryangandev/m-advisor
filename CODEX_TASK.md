# Codex Task: Fix Voice Audio Playback

## Problem
The bot successfully joins a Discord voice channel but plays no audio. The error is:
"The operation was aborted" — from `entersState(player, AudioPlayerStatus.Idle, 30_000)` timing out.

This means the player either:
- Immediately errors without reaching Playing state
- Gets stuck and never transitions to Idle

## Current approach (not working)
1. macOS `say -v Samantha -o file.aiff "text"` → generates AIFF
2. `ffmpeg -y -i file.aiff -c:a libopus -ar 48000 file.ogg` → converts to OGG Opus
3. `createAudioResource(createReadStream(oggPath), { inputType: StreamType.OggOpus })` → fails silently

## Files to fix
- `src/commands/testvc.ts` — the test command
- `src/services/gameMonitor.ts` — production announcement
- `src/utils/tts.ts` — TTS generation

## What to investigate and fix

### Step 1: Check @discordjs/opus installation
Run: `node -e "const opus = require('@discordjs/opus'); console.log('opus ok', opus.OpusEncoder)"` in the project directory.
If it errors, run `npm rebuild @discordjs/opus` and check again.

### Step 2: Install ffmpeg-static for reliable ffmpeg path
Run: `npm install ffmpeg-static`
This ensures @discordjs/voice can always find ffmpeg regardless of PATH.

After installing, add to src/utils/ffmpeg-setup.ts:
```typescript
import ffmpegStatic from 'ffmpeg-static';
import { setFfmpegPath } from '@discordjs/voice';

if (ffmpegStatic) {
  setFfmpegPath(ffmpegStatic);
  console.log('ffmpeg path set:', ffmpegStatic);
}
```

Then import this at the top of src/index.ts (before other imports):
```typescript
import './utils/ffmpeg-setup';
```

### Step 3: Rewrite src/utils/tts.ts to output WAV instead of OGG
WAV is simpler and @discordjs/voice handles it well via ffmpeg:
```typescript
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import ffmpegStatic from 'ffmpeg-static';

const VOICES = { sweet: "Samantha", old: "Albert" } as const;

export function generateTTS(text: string, style: "sweet" | "old" = "sweet"): string {
  const voice = VOICES[style];
  const base = path.join(os.tmpdir(), `m-advisor-${Date.now()}`);
  const aiffPath = `${base}.aiff`;
  const wavPath = `${base}.wav`;
  const ffmpeg = ffmpegStatic ?? 'ffmpeg';

  const escaped = text.replace(/"/g, '\\"').replace(/`/g, '\\`');
  execSync(`/usr/bin/say -v "${voice}" -o "${aiffPath}" "${escaped}"`);
  execSync(`${ffmpeg} -y -i "${aiffPath}" -ar 48000 -ac 2 "${wavPath}" 2>/dev/null`);
  
  // Clean up aiff
  try { require('node:fs').unlinkSync(aiffPath); } catch {}
  
  return wavPath;
}
```

### Step 4: Rewrite announce in src/services/gameMonitor.ts
Use StreamType.Arbitrary with the WAV file (let @discordjs/voice + ffmpeg handle conversion):
```typescript
import { StreamType } from '@discordjs/voice';

// In announce function, replace resource creation with:
const resource = createAudioResource(ttsPath, {
  inputType: StreamType.Arbitrary,
});
```

Also add verbose logging in announce():
```typescript
connection.on('stateChange', (old, next) => {
  console.log(`[Voice] Connection: ${old.status} → ${next.status}`);
});

player.on('stateChange', (old, next) => {
  console.log(`[Voice] Player: ${old.status} → ${next.status}`);
});

player.on('error', (error) => {
  console.error('[Voice] Player error:', error.message);
});
```

### Step 5: Same fix in src/commands/testvc.ts
Apply the same resource creation approach (StreamType.Arbitrary + WAV file).
Also add verbose state logging to both connection and player.

### Step 6: Build and verify
Run `npm run build` — fix all TypeScript errors.

Do NOT remove the `testvc` command — it's needed for testing.
Do NOT touch package.json scripts, tsconfig.json, or .env.
