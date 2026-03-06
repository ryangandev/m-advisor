# Codex Task: M-Advisor Phase 3 + 4

Read REQUIREMENTS.md for full context. Implement Phase 3 (game-end voice announcement) and Phase 4 (announcer voice style command).

## Already installed packages:
- @discordjs/voice
- @discordjs/opus
- tweetnacl
- ffmpeg (system, available at /usr/local/bin/ffmpeg or /opt/homebrew/bin/ffmpeg)

## What to build:

---

## PHASE 3: Game End Auto Announcement

### Step 1: src/store/announcerStore.ts
In-memory store for per-guild announcer settings and polling state:
```typescript
interface AnnouncerState {
  voiceStyle: 'sweet' | 'old';     // default: 'sweet'
  lastMatchIds: Map<string, string>; // puuid -> last announced matchId
  pollingInterval: NodeJS.Timeout | null;
  activeVoiceChannelId: string | null;
}

// Map<guildId, AnnouncerState>
export function getAnnouncerState(guildId: string): AnnouncerState
export function setVoiceStyle(guildId: string, style: 'sweet' | 'old'): void
export function setPollingInterval(guildId: string, interval: NodeJS.Timeout | null): void
export function setLastMatchId(guildId: string, puuid: string, matchId: string): void
export function getLastMatchId(guildId: string, puuid: string): string | undefined
export function setActiveVoiceChannel(guildId: string, channelId: string | null): void
```
Auto-initialize state if not present.

---

### Step 2: src/utils/riotMatchApi.ts
Riot Match v5 API helpers:

```typescript
const AMERICAS = 'https://americas.api.riotgames.com';

// SR-only queue IDs (Summoner's Rift: normal + ranked only)
const SR_QUEUE_IDS = [400, 420, 430, 440];

// Get the most recent completed SR match ID for a puuid
// Returns null if no SR match found in last 5 matches
export async function getLatestSRMatchId(puuid: string): Promise<string | null>
  // Call: GET /lol/match/v5/matches/by-puuid/{puuid}/ids?count=5 (no queue filter, filter manually)
  // For each matchId, call getMatchDetail and check if queue is in SR_QUEUE_IDS
  // Return the first SR matchId found, or null

// Get full match details
export async function getMatchDetail(matchId: string): Promise<MatchDetail>
  // Call: GET /lol/match/v5/matches/{matchId}

// Get best and worst performer from match participants by KDA
// KDA = (kills + assists) / max(deaths, 1)
// Returns { best: ParticipantStats, worst: ParticipantStats }
export function getBestAndWorst(participants: ParticipantStats[]): { best: ParticipantStats; worst: ParticipantStats }
```

Add to src/types.ts (append):
```typescript
export interface ParticipantStats {
  puuid: string;
  summonerName: string;  // riotIdGameName
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  teamId: number;
}

export interface MatchDetail {
  metadata: { matchId: string; participants: string[] };
  info: {
    queueId: number;
    gameDuration: number;
    participants: Array<{
      puuid: string;
      riotIdGameName: string;
      kills: number;
      deaths: number;
      assists: number;
      win: boolean;
      teamId: number;
    }>;
  };
}
```

---

### Step 3: src/utils/tts.ts
TTS using macOS `say` command:

```typescript
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Voice map
const VOICES = { sweet: 'Samantha', old: 'Albert' };

// Generate TTS audio file using macOS `say` command
// Returns path to the generated AIFF file
export function generateTTS(text: string, style: 'sweet' | 'old' = 'sweet'): string {
  const voice = VOICES[style];
  const outputPath = path.join(os.tmpdir(), `m-advisor-${Date.now()}.aiff`);
  execSync(`say -v "${voice}" -o "${outputPath}" "${text.replace(/"/g, '\\"')}"`);
  return outputPath;
}
```

---

### Step 4: src/services/gameMonitor.ts
Core polling + announcement service:

```typescript
import { Client, VoiceChannel } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { getBinding } from '../store/bindingStore';
import { getAnnouncerState, setPollingInterval, setLastMatchId, getLastMatchId, setActiveVoiceChannel } from '../store/announcerStore';
import { getLatestSRMatchId, getMatchDetail, getBestAndWorst } from '../utils/riotMatchApi';
import { generateTTS } from '../utils/tts';
import fs from 'fs';

const POLL_INTERVAL_MS = 45_000;

// Start polling for a guild (called when bound member joins VC)
export function startPolling(client: Client, guildId: string, voiceChannelId: string): void

// Stop polling for a guild (called when bound member leaves all VCs)
export function stopPolling(guildId: string): void

// Core poll function: check for new matches and announce
async function pollAndAnnounce(client: Client, guildId: string): Promise<void>

// Join VC and play TTS announcement
async function announce(client: Client, guildId: string, voiceChannelId: string, text: string): Promise<void>
```

Implementation details for `pollAndAnnounce`:
1. Get binding for guildId — if none, stop polling
2. For each account in binding.accounts:
   a. Call getLatestSRMatchId(puuid)
   b. If matchId is null or matches getLastMatchId(guildId, puuid): skip (no new match)
   c. If new match found:
      - setLastMatchId(guildId, puuid, matchId)
      - Get match detail
      - Extract participants using getBestAndWorst
      - Get the active VC for this guild (from announcerState.activeVoiceChannelId)
      - If no VC: skip announcement
      - Build announcement text:
        ```
        const win = best.win ? 'Victory' : 'Defeat';
        const text = `${win}! Best player: ${best.summonerName}, with ${best.kills} kills, ${best.deaths} deaths, and ${best.assists} assists. Worst player: ${worst.summonerName}, with ${worst.kills} kills, ${worst.deaths} deaths, and ${worst.assists} assists.`;
        ```
      - Call announce(client, guildId, vcId, text)
3. Handle errors gracefully (log, don't crash)

Implementation details for `announce`:
1. Get voice channel from client.channels.cache
2. Create voice connection with joinVoiceChannel
3. Wait for connection to be Ready (entersState with 5s timeout)
4. Generate TTS file with generateTTS(text, voiceStyle)
5. Create audio resource from file path
6. Create audio player, subscribe connection to player
7. Play resource
8. Wait for player to be Idle (entersState with 60s timeout)
9. Clean up: destroy connection, delete temp TTS file
10. Handle errors: destroy connection on failure

---

### Step 5: src/events/voiceStateUpdate.ts
Discord VoiceStateUpdate event handler:

```typescript
export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState): Promise<void>
}
```

Logic:
1. Get guildId from newState.guild.id
2. Get binding for guildId — if none, return
3. Check if the user is the bound Discord member (newState.member?.id === binding.discordUserId OR oldState.member?.id === binding.discordUserId)
4. If bound member JOINED a VC (oldState.channelId is null/undefined, newState.channelId is not null):
   - setActiveVoiceChannel(guildId, newState.channelId)
   - startPolling(client, guildId, newState.channelId)
5. If bound member MOVED to different VC:
   - setActiveVoiceChannel(guildId, newState.channelId)
   (polling continues, just update channel)
6. If bound member LEFT all VCs (newState.channelId is null):
   - setActiveVoiceChannel(guildId, null)
   - stopPolling(guildId)

Note: The `client` must be accessed via `oldState.client` or `newState.client`

---

## PHASE 4: Announcer Voice Style Command

### src/commands/announcer.ts
Slash command:
- name: "announcer"
- description: "Change the announcer voice style"
- Option: "style" (String type, required) with choices: [{ name: "Sweet Girl", value: "sweet" }, { name: "Old Man", value: "old" }]

Execute:
1. Check isAdmin(interaction) — if not admin, reply ephemeral error
2. Get style option
3. setVoiceStyle(guildId, style)
4. Reply with success embed: "Announcer voice set to [Sweet Girl / Old Man]"

---

## After writing all files:
1. Run: npm run build
2. Fix ALL TypeScript errors until zero errors remain
3. Do NOT modify package.json, tsconfig.json, or .env files

## Notes:
- The macOS `say` binary is at /usr/bin/say — no need to find it
- Use `entersState` from @discordjs/voice for waiting on connection/player state transitions
- Always destroy voice connections after playback and clean up temp files
- Log errors to console but never throw unhandled rejections in polling loop
