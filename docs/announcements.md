# Match monitoring and voice announcements

The bot monitors completed Summoner's Rift matches while the tracked Discord member is in a supported voice channel.
One monitoring session belongs to each guild.
The normal poll interval is 45 seconds, and manual simulation commands can request a poll immediately.

## Session behavior

`startPolling(client, guildId, channelId)` starts a session and immediately reads each bound account's latest match as its baseline.
The baseline is recorded without speaking, including a valid empty history.
Restarting monitoring after a departure or bot restart creates a new baseline, so offline matches are not replayed.
Moving channels during an existing session preserves its baseline.
Changing the tracked member or account list starts a new session when startup reconciliation runs.

`pollGuildNow(client, guildId, requiredVoiceChannelId?)` returns `{ announced, errors }` and waits for an already running poll, including the initial baseline poll.
Concurrent timer and command requests share that one poll instead of overlapping.
Manual simulation passes its authorized channel ID, and that restriction also applies when joining an existing automatic poll.
A move outside the required channel cancels the simulation instead of following the member.
A stopped guild returns zero counts.
`stopPolling(guildId)` cancels the session, timer, active voice channel, and match baselines.
`stopAllPolling()` performs the same cancellation for every active guild during shutdown.

Duplicate PUUIDs are queried once, and a shared match across bound accounts is announced once per guild.
The bot advances a match baseline only after voice playback succeeds.
TTS and playback failures remain eligible for retry on the next poll.
An account with no match history can announce its first match after the initial empty baseline.

Missing or rejected Riot credentials stop the guild's timer instead of repeatedly retrying an invalid key.
Correct the configuration, then restart the bot or its monitoring session.
In real mode, saved `MOCK-` PUUIDs are skipped without issuing a real API request.
The first skip produces an actionable warning to replace that binding using `/bind` with the same Riot ID.
Compatible real accounts in the same guild continue monitoring.
Mock automatic playback and retries also obey `TEST_GUILD_ID` and `TEST_VOICE_CHANNEL_ID` whenever those restrictions are configured.
Real automatic announcements continue following the tracked member's current channel.

## Speech and text

`src/services/announcementText.ts` builds deterministic Chinese speech and a channel report from one ranking.
Victory or defeat comes from the tracked account's PUUID, even when an enemy has the highest KDA.
The tracked player's five teammates are ranked from 特等马 to 没有马; enemies are never scored.
See [Horse ranking](scoring.md) for the scoring model and commentary rules.
Mock speech begins with `模拟战报`, and the mock report carries a mock title and footer.
Participant names are shortened and sanitized before use in speech or Discord text.
A five-horse report is typically 60 to 80 seconds of audio, so the transport allows 240 seconds of playback.

After successful voice playback, the bot posts the ranking as an embed in the voice channel's text chat.
It can mention only the bound Discord member whose Riot participant is present in the match and whose member ID is still in that channel.
Every send uses explicit `allowedMentions`, with automatic mentions and roles disabled.
Riot names cannot trigger mentions of other Discord members or `@everyone`.

The terminal logs each newly detected match with the tracked Riot ID, how many seconds have passed since the game ended, the queue and the length.
After playback it logs how many seconds speech generation and playback took after detection.
Together they show whether a slow announcement waited on Riot's match data, the poll interval or speech.
The silent baseline is not logged.

`announced` counts completed voice announcements.
`errors` counts observed Riot, speech, transport, or text-send failures.
A text-send failure after completed audio returns `{ announced: 1, errors: 1 }` and logs the failure without repeating audio next time.
Cancellation due to leaving, stopping, or rebinding is an expected result and adds no error count.

## Shared voice queue

`src/services/voiceAnnouncements.ts` owns a bounded queue for each guild, shared by automatic reports and `/testvoice`.
Generation and playback within a guild execute sequentially.
A failed job does not poison subsequent jobs, and different guilds have independent queues.
The local TTS worker still serializes model generation across guilds to bound model memory use.

`announceTextInVoiceChannel(channel, text, style, canPlay?)` is the manual test entry point.
The caller supplies an eligibility check that confirms the requesting member still belongs to the chosen channel and the command is still permitted.
Eligibility is checked before generation and again before connecting to Discord.

Automatic reports use `announceTextToCurrentChannel(guildId, text, style, resolveChannel, canPlay?, signal?)`.
Its resolver reads the tracked member's current channel after TTS generation, allowing a channel move while the model is speaking to file.
A session abort, departure, or rebind cancels the handoff before joining.
During playback, channel eligibility is checked every 100 milliseconds and a change aborts the transport.
The TTS request itself may finish before cancellation cleanup; a cancelled request never joins a channel afterward.

Generated WAV or MP3 files and optional JSON sidecars are removed on success, playback failure, or cancellation after generation.
Cleanup errors are logged without turning completed playback into a retry and duplicate speech.

## Discord transport

`src/utils/voicePlayback.ts` accepts both local WAV files and Azure MP3 files through the same FFmpeg decoder.
It attaches connection, player, source-stream, and decoder error handlers before starting playback.
It waits for the connection to become Ready, observes the player become Playing, then waits for Idle.
The player's initial Idle state cannot count as successful playback.
Timeouts, aborts, stream errors, and connection disconnects reject the operation.
Every exit stops the player, destroys the streams, and destroys the voice connection.
The bot self-deafens because listening to Discord speech is outside this feature's scope.

## Verification

Before fixing the old monitor, a public `startPolling` reproduction with fake Riot, TTS, and channel boundaries confirmed historical replay, an enemy-derived false victory, consumed matches after failed TTS, and overlapping lookups.

`tests/monitor.test.ts` exercises complete sessions using the real state store and shared queue with fake external I/O.
`tests/voiceAnnouncements.test.ts` verifies queue serialization, channel changes, cancellation, limits, and cleanup behavior.
`tests/voicePlayback.test.ts` uses the installed voice library's `entersState` with fake transports to verify playback lifecycle and failure cleanup.
These tests never connect to or mutate a real Discord server.
Real Discord playback and human listening remain separate acceptance steps.
