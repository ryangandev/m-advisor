# Codex Task: Diagnose and Fix Voice Audio

## Problem
Bot joins Discord VC successfully but plays no audio. Error: "The operation was aborted"
from `entersState(player, AudioPlayerStatus.Idle, 30_000)` — player never reaches Idle.

We've tried:
1. Raw PCM via ffmpeg pipe → failed
2. OGG Opus via createReadStream + StreamType.OggOpus → failed
3. WAV file + ffmpeg-static + StreamType.Arbitrary → still failing

## Diagnosis Tasks

### Task 1: Check all voice dependencies
Run these diagnostic commands and show the output:
```bash
node -e "const o = require('@discordjs/opus'); console.log('opus ok:', typeof o.OpusEncoder)"
node -e "require('tweetnacl'); console.log('tweetnacl ok')"
node -e "require('sodium-native'); console.log('sodium ok')" 2>&1 || echo "sodium not installed"
node -e "const f = require('ffmpeg-static'); console.log('ffmpeg-static:', f)"
```

### Task 2: Test WAV generation
```bash
node -e "
const { execSync } = require('child_process');
const { existsSync, statSync } = require('fs');
const os = require('os');
const path = require('path');
const f = require('ffmpeg-static');

const aiff = path.join(os.tmpdir(), 'test-diag.aiff');
const wav = path.join(os.tmpdir(), 'test-diag.wav');
execSync('/usr/bin/say -v Samantha -o ' + aiff + ' \"Hello world\"');
execSync(f + ' -y -i ' + aiff + ' -ar 48000 -ac 2 ' + wav);
console.log('aiff exists:', existsSync(aiff), statSync(aiff).size);
console.log('wav exists:', existsSync(wav), statSync(wav).size);
"
```

### Task 3: Based on diagnosis, apply the correct fix

**If @discordjs/opus fails to load:**
- Run: `npm install opusscript` as fallback
- OR: `npm rebuild @discordjs/opus`

**If sodium/tweetnacl is an issue:**
- Run: `npm install sodium-native`

**Regardless of above — try this alternative playback approach in testvc.ts:**

Replace the current resource creation with a child_process approach using the explicit ffmpeg-static path:
```typescript
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

// Instead of createAudioResource(ttsPath, ...)
// Do this:
const ffmpegPath = ffmpegStatic ?? 'ffmpeg';
const ffmpegProcess = spawn(ffmpegPath, [
  '-hide_banner',
  '-loglevel', 'error', 
  '-i', ttsPath,
  '-f', 's16le',
  '-ar', '48000',
  '-ac', '2',
  'pipe:1',
], { stdio: ['ignore', 'pipe', 'pipe'] });

ffmpegProcess.stderr?.on('data', (d) => console.log('[ffmpeg]', d.toString()));

const resource = createAudioResource(ffmpegProcess.stdout!, {
  inputType: StreamType.Raw,
});
```

Also add these to the player in testvc.ts:
```typescript
player.on('stateChange', (o, n) => console.log(`[Player] ${o.status} → ${n.status}`));
player.on('error', (e) => console.error('[Player error]', e.message, e.stack));
```

And to the connection:
```typescript
connection.on('stateChange', (o, n) => console.log(`[Connection] ${o.status} → ${n.status}`));
```

### Task 4: Apply same fix to gameMonitor.ts

### Task 5: Run `npm run build` and fix all TypeScript errors

Do NOT remove testvc command.
Do NOT touch .env, package.json scripts, or tsconfig.json.
