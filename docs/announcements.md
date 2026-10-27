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

## Diagnostics

The bot logs to the terminal and its daily log file, described in [Runtime](runtime.md#logs).
It logs when monitoring starts, with the bound Riot IDs and voice channel, and when it stops, with the reason.
It logs each account's baseline match, after which finished matches are announced.
It logs each newly detected match with the tracked Riot ID, how many seconds have passed since the game ended, the queue and the length.
After playback it logs how many seconds speech generation and playback took after detection.
Together they show whether a slow announcement waited on Riot's match data, the poll interval or speech.
A saved mock account skipped in real mode is logged as a monitoring failure that names the account.
Startup in real mode and `npm run doctor` also warn about each saved mock account before anyone joins voice.
In real mode `/bind` removes the member's saved mock accounts, names them in its reply and logs the change, as does `/unbind`.

`/recent` replies privately with the monitoring state and the bound accounts' recent matches in every queue.
The state shows whether monitoring is active, the tracked member's voice channel, the last check and the last error, which survives a stop caused by rejected credentials.
Each match shows the result, champion, K/D/A, queue, length and end time.
It is marked as the baseline, already announced, due at the next check, or in a mode that is never announced.
In real mode a saved mock account is flagged without a Riot request.

`announced` counts completed voice announcements.
`errors` counts observed Riot, speech, transport, or text-send failures.
A text-send failure after completed audio returns `{ announced: 1, errors: 1 }` and logs the failure without repeating audio next time.
Cancellation due to leaving, stopping, or rebinding is an expected result and adds no error count.

## Shared voice queue

`src/services/voiceAnnouncements.ts` owns a bounded queue for each guild, shared by automatic reports and `/testvoice`.
Announcements within a guild execute sequentially, from the first generated sentence to the end of playback.
A failed job does not poison subsequent jobs, and different guilds have independent queues.
The local TTS worker still serializes model generation across guilds to bound model memory use.

Each announcement is split into sentence chunks, described in [Local voice](local-voice.md#sentence-chunks).
The chunks are generated in order, one request at a time, and generation continues during playback without waiting for it.
The bot joins the channel as soon as the first chunk is ready, and later chunks join the same stream as they finish.
A warm worker has generated speech between 1.35 and 3 times faster than it plays, so later chunks are normally ready before they are needed.

`announceTextInVoiceChannel(channel, text, style, canPlay?)` is the manual test entry point.
The caller supplies an eligibility check that confirms the requesting member still belongs to the chosen channel and the command is still permitted.
Eligibility is checked before each chunk is generated and again before connecting to Discord.

Automatic reports use `announceTextToCurrentChannel(guildId, text, style, resolveChannel, canPlay?, signal?)`.
Its resolver reads the tracked member's current channel after the first chunk is generated, allowing a channel move while the model is speaking the first sentence to file.
A session abort, departure, or rebind cancels the handoff before joining and stops any further chunk from starting.
During playback, channel eligibility is checked every 100 milliseconds and a change aborts the transport.
A cancelled announcement waits for the chunk request already in progress, never joins a channel afterward and reports `AnnouncementCancelledError`.

A generation failure in any chunk stops playback immediately and fails the announcement, so the match stays eligible for retry.
The retry speaks the whole report again from its first sentence, because only a completed playback advances the match baseline.
A failure of the first chunk never joins a channel.

Every generated chunk file and optional JSON sidecar is removed when the announcement settles, after success, playback failure, generation failure or cancellation.
Cleanup errors are logged for each file without turning completed playback into a retry and duplicate speech.

## Discord transport

`src/utils/voicePlayback.ts` plays the chunks as one continuous stream through one audio player and one audio resource.
FFmpeg decodes each chunk file to 48 kHz stereo PCM as soon as it is available.
The transport fades the first and last 2.5 milliseconds of each chunk, inserts 350 milliseconds of silence before every chunk after the first, and pads each chunk to a whole 20 millisecond frame.
Those pauses match the model's own pauses at full stops, the fades prevent clicks at chunk edges, and the padding keeps a partial frame from waiting in the Opus encoder for the next chunk.
The PCM goes straight into the voice library's Opus encoder, so no decoder buffer can hold the end of a sentence back.
If generation falls behind, the player sends Opus silence until the next chunk arrives instead of stopping, so a slow chunk only lengthens the pause between sentences.

The transport attaches connection, player, source-stream, and encoder error handlers before starting playback.
It waits for the connection to become Ready, observes the player become Playing, then waits for Idle.
The player's initial Idle state cannot count as successful playback, and neither can an Idle state before the last chunk was written.
Timeouts, aborts, stream errors, chunk failures, and connection disconnects reject the operation.
The 240 second playback timeout covers the whole stream, including any wait for later chunks.
Every exit stops the player, destroys the streams, and destroys the voice connection.
The bot self-deafens because listening to Discord speech is outside this feature's scope.

## Verification

Before fixing the old monitor, a public `startPolling` reproduction with fake Riot, TTS, and channel boundaries confirmed historical replay, an enemy-derived false victory, consumed matches after failed TTS, and overlapping lookups.

`tests/monitor.test.ts` exercises complete sessions using the real state store and shared queue with fake external I/O.
`tests/voiceAnnouncements.test.ts` verifies queue serialization, chunk ordering, playback before later chunks exist, mid-stream generation failure, cancellation between chunks and during playback, channel changes, limits, and cleanup of every chunk file.
`tests/speechChunks.test.ts` verifies sentence boundaries, decimal scores, short and long sentences and the length limits.
`tests/voicePlayback.test.ts` uses the installed voice library's `entersState` with fake transports to verify playback lifecycle, chunk stitching, gaps while a chunk generates, and failure cleanup.
It also decodes a real WAV through the installed FFmpeg.
These tests never connect to or mutate a real Discord server.
Real Discord playback and human listening remain separate acceptance steps.
