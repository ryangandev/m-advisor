# Architecture

## Code map

| Location | Responsibility |
| --- | --- |
| `src/commands/` | Slash commands and permission checks |
| `src/handlers/commandHandler.ts` | Loads every compiled command file and registers guild commands |
| `src/events/ready.ts`, `voiceStateUpdate.ts`, `interactionCreate.ts` | Startup restore, voice membership, and `interactionCreate.ts` routing interactions to commands |
| `src/events/reportScheduler.ts` | Starts the 马报 scheduler once the client is ready |
| `src/events/guildAvailable.ts`, `guildDelete.ts` | Guild lifecycle: a guild becoming available and the bot being removed from one |
| `src/services/gameMonitor.ts` | Match monitoring and announcement orchestration |
| `src/services/monitorLifecycle.ts`, `shutdownState.ts`, `simulationLock.ts` | Monitor start and stop per guild, the shared stopping flag and the per-guild `/simulate` lock |
| `src/services/gameStartWatcher.ts`, `pregameBrief.ts`, `pregameRecap.ts` | 军师赛前锦囊: detect a game on the loading screen, write the brief and recap it after the game |
| `src/services/horseRanking.ts`, `partyRanking.ts` | Position-aware teammate scoring from 特等马 to 没有马, and the 车队内战 ranking of tracked friends |
| `src/services/announcementText.ts` | Chinese speech and channel report for a ranked match |
| `src/services/voiceAnnouncements.ts`, `channelChoice.ts` | Shared voice queue with retries and timeouts, and the choice of the voice channel to speak in |
| `src/services/rankTracker.ts`, `rankResults.ts`, `rankMath.ts`, `rankText.ts` | 段位变化: read ranked entries around a game, compare them, compute LP and 晋级/掉段, and word the 段位播报 |
| `src/services/horseRecords.ts`, `horseProfile.ts` | 马厩: turn an announced match into per-member records, and summarize a member's records into a profile |
| `src/services/horseVerdict.ts`, `src/utils/whyRadar.ts`, `whyEmbed.ts` | `/why`: explain one stored verdict, draw its radar PNG and word the 上诉 ruling |
| `src/services/reports.ts`, `reportScheduler.ts`, `reportRoles.ts` | 马报: build the daily and weekly reports, post them on schedule with restart catch-up, and rotate the weekly roles |
| `src/services/matchEvents.ts` | Timeline moments, such as a won baron fight, cited by the praise and roast |
| `src/services/riotData.ts` | The explicit mock/real provider behind every Riot call |
| `src/services/localTts.ts` | Persistent Python speech worker client |
| `src/services/commandMigration.ts` | Retires legacy global commands at registration |
| `src/data/` | Generated reference quantiles and Chinese champion names |
| `src/fixtures/riotFixtures.ts` | Labeled mock Riot data |
| `src/utils/riotApi.ts`, `riotMatchApi.ts`, `riotLeagueApi.ts`, `riotSpectatorApi.ts`, `riotId.ts` | Public Riot account, match, league-v4 and spectator-v5 operations and Riot ID parsing |
| `src/utils/matchTimeline.ts` | match-v5 timeline parsing, isolated so an upstream shape change stays in one file |
| `src/utils/embeds.ts`, `pregameEmbed.ts`, `stableEmbed.ts`, `reportEmbed.ts` | Discord embeds for profiles, the 锦囊, 马厩 and 马报 |
| `src/utils/bindingAccounts.ts`, `permissions.ts`, `testChannel.ts`, `userFacingErrors.ts`, `pacificTime.ts`, `log.ts` | Account list helpers, permission checks, test channel, user-facing error text, Pacific day boundaries and the timestamped log |
| `src/store/` | SQLite stores: bindings and preferences, announcer, 马厩 records, 马报, appeals, ranked results and the schema in `database.ts` |
| `src/utils/tts.ts` | Speech generation provider boundary |
| `src/utils/speechChunks.ts` | Splitting speech into sentence chunks |
| `src/utils/voicePlayback.ts` | Discord connection and audio playback |
| `tests/` | Reproducible behavioral and integration checks |
| `src/cli/` | Explicit guild command registration and local runtime diagnosis |
| `scripts/` | Local launcher, persistent Python speech worker, acceptance verifiers, the read-only spectator probe and reference data generators |

## Scope

The approved first delivery is local, on-demand hosting with NA profiles and game-end announcements.
Each server can track several Discord members, with at most 10 LoL accounts across them.
Free conversation, STT, LLM commentary and cloud deployment are later extensions.
The local speech model replaces the cloud synthesis step; the Node bot still owns Discord connections.

## Storage

Bindings, voice styles, 马厩 history, 马报 settings, pre-game settings, appeal cases and ranked results are persisted locally in SQLite.
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
Its `开局（赛前锦囊）` outcome instead starts a mock game on the loading screen and waits for the game start watcher's 锦囊; see [Game start](announcements.md#game-start).
Its `晋级（模拟）` and `掉段（模拟）` outcomes first place the account just below a tier line, then simulate a win or a loss; see [段位播报](announcements.md#段位播报).
Concurrent simulations for the same server are rejected until the first finishes.
Both test commands require an administrator in the configured server and permitted voice channel.
See [Acceptance](acceptance.md) for verification procedures and external prerequisites.
