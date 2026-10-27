# Architecture

## Code map

| Location | Responsibility |
| --- | --- |
| `src/commands/` | Slash commands and permission checks |
| `src/events/` | Discord lifecycle and voice membership |
| `src/services/gameMonitor.ts` | Match monitoring and announcement orchestration |
| `src/services/horseRanking.ts` | Position-aware teammate scoring from 特等马 to 没有马 |
| `src/services/announcementText.ts` | Chinese speech and channel report for a ranked match |
| `src/services/horseRecords.ts`, `horseProfile.ts` | 马厩: turn an announced match into per-member records, and summarize a member's records into a profile |
| `src/services/horseVerdict.ts`, `src/utils/whyRadar.ts`, `whyEmbed.ts` | `/why`: explain one stored verdict, draw its radar PNG and word the 上诉 ruling |
| `src/services/reports.ts`, `reportScheduler.ts`, `reportRoles.ts` | 马报: build the daily and weekly reports, post them on schedule with restart catch-up, and rotate the weekly roles |
| `src/services/matchEvents.ts` | Timeline moments, such as a won baron fight, cited by the praise and roast |
| `src/data/` | Generated reference quantiles and Chinese champion names |
| `src/utils/riotApi.ts`, `riotMatchApi.ts` | Public Riot account and match operations |
| `src/utils/matchTimeline.ts` | match-v5 timeline parsing, isolated so an upstream shape change stays in one file |
| `src/store/` | Guild bindings, preferences and monitor state |
| `src/utils/tts.ts` | Speech generation provider boundary |
| `src/utils/speechChunks.ts` | Splitting speech into sentence chunks |
| `src/utils/voicePlayback.ts` | Discord connection and audio playback |
| `tests/` | Reproducible behavioral and integration checks |
| `src/cli/` | Explicit guild command registration and local runtime diagnosis |
| `scripts/` | Local launcher, persistent Python speech worker, acceptance verifiers and reference data generators |

## Scope

The approved first delivery is local, on-demand hosting with NA profiles and game-end announcements.
Each server can track several Discord members, with at most 10 LoL accounts across them.
Free conversation, STT, LLM commentary and cloud deployment are later extensions.
The local speech model replaces the cloud synthesis step; the Node bot still owns Discord connections.

## Storage

Bindings and voice styles are persisted locally in SQLite.
Timers, voice channels and match baselines are session state and never survive restart.
See [Storage](storage.md) for database ownership, durability, shutdown and test evidence.

## Riot data

The public account and match wrappers share an explicit mock/real provider.
Mock data is labeled in profiles and errors; real failures never switch providers.
See [Riot data](riot-data.md) for fixture names, rate limiting, endpoint policy and queue support.

## Local voice

The bot owns one bounded, persistent Python speech worker.
It reads the installed Media model record without modifying the shared environment or downloading weights.
See [Local voice](local-voice.md) for configuration, protocol, provider choice and measured performance.

## Announcements

Each monitoring session establishes a baseline and prevents concurrent polls.
The shared voice queue generates the first sentence before joining a channel, keeps generating the rest during playback and records success only after the last sentence plays.
See [Announcements](announcements.md) for retry, cancellation, channel authorization and safe mention behavior.

## Lifecycle and test commands

The entry point enables the daily log file, loads commands and events, validates the selected data mode and logs into Discord.
`src/utils/log.ts` timestamps every bot message for the terminal and, once the entry point enables it, appends it to that file.
The ready event restores eligible monitoring and prewarms speech.
A shared stopping flag prevents new work during asynchronous teardown.
SIGINT and SIGTERM close monitoring, voice connections, the client, speech and SQLite.
Explicit registration is separate from startup and is limited to the configured test server.

`/testvoice` uses the same speech and playback queue as game announcements.
`/simulate` uses the earliest-bound tracked member who is in the test channel, establishes a baseline, creates one mock result on that member's first account and verifies that this exact match was announced.
Concurrent simulations for the same server are rejected until the first finishes.
Both test commands require an administrator in the configured server and permitted voice channel.
See [Acceptance](acceptance.md) for verification procedures and external prerequisites.
