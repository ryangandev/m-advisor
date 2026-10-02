# Architecture

## Code map

| Location | Responsibility |
| --- | --- |
| `src/commands/` | Slash commands and permission checks |
| `src/events/` | Discord lifecycle and voice membership |
| `src/services/gameMonitor.ts` | Match monitoring and announcement orchestration |
| `src/utils/riotApi.ts`, `riotMatchApi.ts` | Public Riot account and match operations |
| `src/store/` | Guild bindings, preferences and monitor state |
| `src/utils/tts.ts` | Speech generation provider boundary |
| `src/utils/voicePlayback.ts` | Discord connection and audio playback |
| `tests/` | Reproducible behavioral and integration checks |

## Scope

The approved first delivery is local, on-demand hosting with NA profiles and game-end announcements.
Each server tracks one Discord member with multiple LoL accounts.
Free conversation, STT, LLM commentary and cloud deployment are later extensions.
The local speech model replaces the cloud synthesis step; the Node bot still owns Discord connections.

## Storage

Bindings and voice styles are persisted locally in SQLite.
Timers, voice channels and match baselines are session state and never survive restart.
See [Storage](storage.md) for database ownership, durability, shutdown and test evidence.
