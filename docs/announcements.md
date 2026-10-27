# Match monitoring and voice announcements

The bot monitors completed Summoner's Rift matches while tracked Discord members are in a supported voice channel.
One monitoring session belongs to each guild and covers every tracked member who is in voice.
The normal poll interval is 45 seconds, and manual simulation commands can request a poll immediately.

## Session behavior

`syncMonitoring(client, guildId, presentMemberIds)` points the guild's session at the tracked members who are in voice now.
`src/services/monitorLifecycle.ts` calls it from voice events, startup and binding commands after reading every tracked member's voice state.
Those reconciliations run one after another per guild, so a slow lookup cannot apply an older view over a newer one.
Voice updates that do not change the channel, such as mute or deafen, and updates from untracked members are ignored.

The first tracked member in voice starts the session, which immediately reads each of their accounts' latest match as its baseline.
The baseline is recorded without speaking, including a valid empty history.
A member who joins an existing session gets their own baseline the same way, without speech, while everyone else keeps theirs.
If a poll is already running when someone joins, a follow-up poll runs right after it.
An account added to a member who is already in voice also gets a fresh baseline before anything is announced.
A member who leaves voice or is unbound drops out of the session, and their accounts' baselines are cleared with `clearLastMatchIds`.
When they return, they get a new baseline, so a match they finished while away is never replayed.
An account that moves to another member or is removed from its member loses its baseline the same way.
The session stops when no tracked member is left in voice, and a bot restart creates new baselines, so offline matches are not replayed.
Moving between channels does not touch the session or its baselines.

Each poll reads only the accounts of members in the session, and duplicate PUUIDs are queried once.
An account's new latest match is grouped with every other polled account that reported the same match, so a shared match is announced once per guild.
A match already announced in this session only advances the reporting account's baseline.
Pending matches are announced one at a time, oldest `gameEndTimestamp` first, with unknown end times last and then by match ID.
After a match plays, the baseline of every polled account that reported it advances; a failure leaves them all untouched for a retry.

`pollGuildNow(client, guildId, requiredVoiceChannelId?)` returns `{ announced, errors }` and waits for an already running poll, including the initial baseline poll.
Concurrent timer and command requests share that one poll instead of overlapping.
Manual simulation passes its authorized channel ID, and that restriction also applies when joining an existing automatic poll.
A move outside the required channel cancels the simulation instead of following the member.
A stopped guild returns zero counts.
`stopPolling(guildId)` cancels the session, timer, and match baselines.
`stopAllPolling()` performs the same cancellation for every active guild during shutdown.
`getMonitorStatus(guildId)` reports `presentMemberIds`, the members the session covers in bind order, along with the activity, last check and last error.

The bot advances a match baseline only after voice playback succeeds.
TTS and playback failures remain eligible for retry on the next poll.
An account with no match history can announce its first match after the initial empty baseline.

Missing or rejected Riot credentials stop the guild's timer instead of repeatedly retrying an invalid key.
Correct the configuration, then restart the bot or its monitoring session.
In real mode, saved `MOCK-` PUUIDs are skipped without issuing a real API request.
The first skip produces an actionable warning to replace that binding using `/bind` with the same Riot ID.
Compatible real accounts in the same guild continue monitoring.
Mock automatic playback and retries also obey `TEST_GUILD_ID` and `TEST_VOICE_CHANNEL_ID` for every member whenever those restrictions are configured.
Real automatic announcements follow the channel choice below.

## Channel choice

Each match is announced in the voice channel of the tracked members who played it.
When they are spread over several channels, it goes to the channel with the most of them.
A tie keeps the channel the bot used last, then goes to the channel with more people who are not bots, then to the channel of the earliest-bound member, then to the lower channel ID.
With one tracked member this is simply that member's channel.
Only channels a member may be announced in count, so the `TEST_*` restrictions apply per member.

If none of a match's players is in a usable channel, the match is neither announced nor consumed in that poll and adds no error.
It is logged once and waits until a player is in a usable channel; if its players leave voice instead, their baselines are dropped with them.

The report speaks for one tracked player, chosen when the match is queued.
It uses the team with the most of the match's tracked players in the chosen channel, on a tie the earliest-bound member's team, and then that team's earliest-bound member.
A tracked member on the other team counts as an enemy: they are neither scored nor named, but they are still mentioned if they are in the channel.
The speech text is fixed before generation, so a later move changes only where it plays.

After generation the channel is chosen again, keeping the current pick on a tie.
A move during generation is followed when another channel now has strictly more of the match's players.
During playback the channel is checked every 100 milliseconds the same way.
A tie, such as one player leaving, keeps playing; a channel with strictly more players aborts playback without consuming the match, and the next poll plays it there.
Rebinding or unbinding the member whose view the report uses cancels it, and the match stays pending for the other players still in voice; an unrelated `/bind` does not cancel it.

Several matches go through the guild's shared voice queue one after another, and a full queue is an error that the next poll retries.
Internally each queued match is a `DetectedMatch` with its detail, every tracked player of it and the chosen channel, which later features build on.

## Speech and text

`src/services/announcementText.ts` builds deterministic Chinese speech and a channel report from one ranking.
Victory or defeat comes from the PUUID of the tracked player the report speaks for, even when an enemy has the highest KDA.
That player's five teammates are ranked from 特等马 to 没有马; enemies are never scored.
See [Horse ranking](scoring.md) for the scoring model and commentary rules.
Mock speech begins with `模拟战报`, and the mock report carries a mock title and footer.
Participant names are shortened and sanitized before use in speech or Discord text.
A five-horse report is typically 60 to 80 seconds of audio, so the transport allows 240 seconds of playback.

After successful voice playback, the bot posts the ranking as an embed in the voice channel's text chat.
It mentions every tracked member who played the match and is still in that channel, in bind order, and no one else.
Every send uses explicit `allowedMentions` whose `users` list is exactly those members, with automatic mentions and roles disabled.
Riot names cannot trigger mentions of other Discord members or `@everyone`.

## Diagnostics

The bot logs to the terminal and its daily log file, described in [Runtime](runtime.md#logs).
It logs when monitoring starts, with each present member's Riot IDs and voice channel, and when it stops, with the reason.
It logs when a member joins or leaves an existing session.
It logs each account's baseline match, after which finished matches are announced.
It logs each newly detected match with the reporting Riot IDs, how many seconds have passed since the game ended, the queue and the length.
It logs once when a match waits because none of its players is in a usable voice channel.
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
Cancellation due to leaving, stopping, rebinding, or a majority move is an expected result and adds no error count.

## Shared voice queue

`src/services/voiceAnnouncements.ts` owns a bounded queue for each guild, shared by automatic reports and `/testvoice`.
Announcements within a guild execute sequentially, from the first generated sentence to the end of playback.
A failed job does not poison subsequent jobs, and different guilds have independent queues.
The local TTS worker still serializes model generation across guilds to bound model memory use.

Each announcement is split into sentence chunks, described in [Local voice](local-voice.md#sentence-chunks).
The chunks are generated in order, one request at a time, and generation continues during playback without waiting for it.
The bot joins the channel once the first two chunks are ready, or the only chunk of a one-sentence report, and later chunks join the same stream as they finish.
Waiting for the second chunk means an early chunk that keeps failing is never heard as a partial report.
A warm worker has generated speech between 1.35 and 3 times faster than it plays, so later chunks are normally ready before they are needed.
A failed chunk is retried once inline before the announcement fails.
One 360 second deadline covers each announcement from its first request to the end of playback, including a cold model start.

`announceTextInVoiceChannel(channel, text, style, canPlay?)` is the manual test entry point.
The caller supplies an eligibility check that confirms the requesting member still belongs to the chosen channel and the command is still permitted.
Eligibility is checked before each chunk is generated and again before connecting to Discord.

Automatic reports use `announceTextToCurrentChannel(guildId, text, style, resolveChannel, canPlay?, signal?)`.
Its resolver repeats the channel choice after the first two chunks are generated, allowing a majority move while the model is speaking the first sentences to file.
A session abort, or the departure or rebind of the member the report speaks for, cancels the handoff before joining and stops any further chunk from starting.
During playback, channel eligibility is checked every 100 milliseconds and a different choice aborts the transport.
A cancelled announcement cancels the chunk request in progress instead of waiting for it, never joins a channel afterward and reports `AnnouncementCancelledError`.
Audio from a cancelled request that still arrives is deleted.

A chunk that fails twice stops playback immediately and fails the announcement, so the match stays eligible for retry.
The deadline fails the announcement the same way, and is not reported as a cancellation.
The retry speaks the whole report again from its first sentence, because only a completed playback advances the match baseline.
A failure of either of the first two chunks never joins a channel.
A third or later chunk that fails on every attempt is still heard as a partial report on each poll until the match monitor caps its attempts for that match.

Every generated chunk file and optional JSON sidecar is removed when the announcement settles, after success, playback failure, generation failure, timeout or cancellation.
Cleanup errors are logged for each file without turning completed playback into a retry and duplicate speech.

## Discord transport

`src/utils/voicePlayback.ts` plays the chunks as one continuous stream through one audio player and one audio resource.
FFmpeg decodes each chunk file to 48 kHz stereo PCM as soon as it is available.
The first chunk is decoded before joining, so an unreadable first chunk never joins a channel and the stream starts with audio ready.
The transport fades the first and last 2.5 milliseconds of each chunk, inserts 350 milliseconds of silence before every chunk after the first, and pads each chunk to a whole 20 millisecond frame.
Those pauses match the model's own pauses at full stops, the fades prevent clicks at chunk edges, and the padding keeps a partial frame from waiting in the Opus encoder for the next chunk.
The PCM goes straight into the voice library's Opus encoder, so no decoder buffer can hold the end of a sentence back.
If generation falls behind, the player sends Opus silence until the next chunk arrives instead of stopping, so a slow chunk only lengthens the pause between sentences.

The transport attaches connection, player, source-stream, and encoder error handlers before starting playback.
It waits for the connection to become Ready, observes the player become Playing, then waits for Idle.
The player's initial Idle state cannot count as successful playback, and neither can an Idle state before the last chunk was written.
Timeouts, aborts, stream errors, chunk failures, and connection disconnects reject the operation.
The 240 second playback timeout covers the whole stream, including any wait for later chunks, inside the announcement's overall deadline.
Every exit stops the player, destroys the streams, and destroys the voice connection.
The bot self-deafens because listening to Discord speech is outside this feature's scope.

## Verification

Before fixing the old monitor, a reproduction through the then-public `startPolling` with fake Riot, TTS, and channel boundaries confirmed historical replay, an enemy-derived false victory, consumed matches after failed TTS, and overlapping lookups.

`tests/monitor.test.ts` exercises complete sessions using the real state store and shared queue with fake external I/O, for one member and for several members across channels.
`tests/voicePresence.test.ts` drives voice events through the real lifecycle into a monitor with fake Riot I/O.
`tests/voiceAnnouncements.test.ts` verifies queue serialization, chunk ordering, the two-chunk join, inline retry, early and mid-stream generation failure, cancellation between chunks and during playback, the announcement deadline with a chunk that never resolves, channel changes, limits, and cleanup of every chunk file.
`tests/speechChunks.test.ts` verifies sentence boundaries, ASCII end marks inside names, preserved separators, decimal scores, hard cuts that keep words and numbers whole, short and long sentences and the length limits.
`tests/voicePlayback.test.ts` uses the installed voice library's `entersState` with fake transports to verify playback lifecycle, chunk stitching, decoding before joining, gaps while a chunk generates, and failure cleanup.
It also decodes a real WAV through the installed FFmpeg.
These tests never connect to or mutate a real Discord server.
Real Discord playback and human listening remain separate acceptance steps.
