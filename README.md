# M-Advisor

A League of Legends Discord bot that monitors your games and announces results in voice chat using Azure Text-to-Speech.

## Features

- **`/profile <RiotID>`** — Look up any player's ranked stats (Solo/Duo + Flex)
- **`/bind @user <RiotID>`** — Bind a Discord member to their LoL account (admin only)
- **`/unbind @user`** — Remove a member's binding (admin only)
- **`/bindings`** — View the server's current bindings (admin only)
- **`/announcer <style>`** — Switch the TTS voice style (`sweet` or `old`)
- **Game-end voice announcements** — When a bound member finishes a game, the bot joins their voice channel and announces the result with best/worst KDA highlights

## Setup

### Prerequisites

- Node.js 18+
- A [Discord application](https://discord.com/developers/applications) with a bot token
- A [Riot Games API key](https://developer.riotgames.com/)
- An [Azure Speech resource](https://portal.azure.com) (Free tier F0: 500K chars/month)

### Installation

```bash
git clone https://github.com/ryangandev/m-advisor.git
cd m-advisor
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Application ID from Discord Developer Portal |
| `RIOT_API_KEY` | Riot Games API key (`RGAPI-...`) |
| `AZURE_TTS_KEY` | Azure Speech resource key |
| `AZURE_TTS_REGION` | Azure region (e.g. `westus`, `eastus`) |

### Discord Bot Setup

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Under **Bot**, enable **Server Members Intent** and **Presence Intent**
2. Invite the bot to your server with scopes: `bot` + `applications.commands`
3. Bot permissions needed: `Connect`, `Speak`, `Send Messages`, `Use Slash Commands`

### Running

```bash
# Development (ts-node, hot-ish)
npm run dev

# Production build
npm run build
node dist/index.js
```

## Architecture

```
src/
├── commands/          # Slash command handlers
│   ├── profile.ts     # /profile
│   ├── bind.ts        # /bind
│   ├── unbind.ts      # /unbind
│   ├── bindings.ts    # /bindings
│   └── announcer.ts   # /announcer
├── events/
│   ├── interactionCreate.ts   # Routes slash commands
│   └── voiceStateUpdate.ts    # Triggers game polling on VC join/leave
├── services/
│   └── gameMonitor.ts         # Polls Riot API, announces game results
├── store/
│   ├── bindingStore.ts        # In-memory guild → member → accounts map
│   └── announcerStore.ts      # Per-guild voice style + polling state
├── utils/
│   ├── riotApi.ts             # Riot account + summoner + ranked endpoints
│   ├── riotMatchApi.ts        # Match history + best/worst KDA logic
│   ├── riotId.ts              # Riot ID format validation
│   ├── tts.ts                 # Azure TTS REST API (async)
│   ├── voicePlayback.ts       # Join VC + play MP3 + cleanup
│   ├── embeds.ts              # Discord embed builders
│   ├── permissions.ts         # Admin permission check
│   └── userFacingErrors.ts    # Safe error messages for Discord replies
└── handlers/
    └── commandHandler.ts      # Auto-loads and registers slash commands
```

## How Game Monitoring Works

1. A Discord member is bound to their LoL account via `/bind`
2. When they join a voice channel, the bot starts polling their match history (~45s interval)
3. When a new Summoner's Rift game is detected, the bot:
   - Joins their voice channel
   - Calls Azure TTS to generate an announcement
   - Plays the audio
   - Leaves the channel
4. Polling stops when they leave the voice channel

**Supported queues:** Normal Draft (400), Ranked Solo (420), Normal Blind (430), Ranked Flex (440)

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript |
| Discord | discord.js v14 |
| Voice | @discordjs/voice + @snazzah/davey (DAVE/E2EE) |
| TTS | Azure Cognitive Services (REST) |
| Riot API | Official Riot Games API |
| Storage | In-memory (resets on restart) |

## Limitations (Phase 1)

- One LoL account tracked per Discord member per server
- In-memory storage only — bindings are lost on restart
- NA region only (hardcoded)
- Dev API key rate limits apply
