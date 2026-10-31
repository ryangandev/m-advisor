# Match monitoring and voice announcements

The bot monitors completed Summoner's Rift matches while tracked Discord members are in a supported voice channel.
One monitoring session belongs to each guild and covers every tracked member who is in voice.
The normal poll interval is 45 seconds, and manual simulation commands can request a poll immediately.

## Session behavior

`syncMonitoring(client, guildId, presentMemberIds)` points the guild's session at the tracked members who are in voice now.
`src/services/monitorLifecycle.ts` calls it from voice events, startup and binding commands after reading every tracked member's voice state.
Those reconciliations run one after another per guild, so a slow lookup cannot apply an older view over a newer one.
Voice updates that do not change the channel, such as mute or deafen, and updates from untracked members are ignored.
After a gateway re-identify, for example after the Mac slept, discord.js reloads a guild's voice states without any voice event, so `src/events/guildAvailable.ts` reconciles the guild again when it becomes available.
It does nothing before the client is ready, because at startup every guild becomes available first and `restoreMonitoring` on ClientReady is the startup path.
When the bot is invited back to a server it was removed from, discord.js emits GuildCreate with the members' voice states and no voice event, so `src/events/guildCreate.ts` reconciles the guild the same way and monitoring resumes for members already in voice, again only once the client is ready.

The first tracked member in voice starts the session, which immediately reads each of their accounts' latest match as its baseline.
The baseline is recorded without speaking, including a valid empty history.
A member who joins an existing session gets their own baseline the same way, without speech, while everyone else keeps theirs.
If a poll is already running when someone joins, a follow-up poll runs right after it.
That first lookup can wait behind a long report, so for a member who joined a running session the bot reads the latest match's end time.
A latest match that ended after the member joined is announced instead of becoming the baseline; one that ended before they joined, or without an end time, is the baseline.
An account added to a member who is already in voice also gets a fresh baseline before anything is announced, counted from when it was added.
Accounts present when the session starts, at the first join or after a bot restart, take their latest match as the baseline without that check, so nothing is replayed.
A member who leaves voice or is unbound drops out of the session, and their accounts' baselines are cleared with `clearLastMatchIds`.
A member who leaves voice and still owns their accounts has those baselines kept in memory for 2 minutes (`KEEP_BASELINES_MS`), also when their leaving stops the session.
If the same member returns within the window, their accounts take the kept baselines back instead of a new one, so a match they finished meanwhile is announced once.
A baseline is kept only if its account was read recently (within two poll intervals, or ten minutes while a poll is running or within two poll intervals after the poll that read it finished), so a Mac that slept for hours and then reconciles cannot bring back a stale baseline and replay an old match.
The allowance outlasts the poll because a poll reads its accounts before it speaks, so right after a long report every read is old although the session was busy all along.
A finished poll extends only the accounts it read, so a poll whose Riot reads failed, as right after the Mac woke, extends nothing.
After the window, for an unbound member or an account that moved to another member or was removed, and after any `/bind` or `/unbind` of the member, the return gets a new baseline, so a match finished while away is never replayed.
`/bind` and `/unbind` drop the member's kept baselines at once, so a reconciliation still queued behind them cannot bring an old one back.
The session stops when no tracked member is left in voice, and a bot restart creates new baselines because the kept ones live in memory only, so offline matches are not replayed.
Moving between channels does not touch the session or its baselines.
When the bot is removed from a server, that server's session stops too (`src/events/guildDelete.ts` reconciles the guild through the same per-guild chain, which stops it because the guild is gone from the cache), so the match poll and the game-start watcher stop calling Riot for it.
A reconcile that was still reading voice states at that moment drops its older view instead of restarting the session.

Separately from the baselines, the guild remembers every match whose text report it posted or that it consumed, whichever session did it and whether or not anyone's baseline was kept.
Any session of the guild, new or continuing, treats a remembered match that was consumed as already announced for every account that reports it.
That covers a member who returns after a teammate's session announced the match, and a player whose Riot match list shows the game later than a teammate's.
A remembered match whose text went out but whose voice did not finish is carried on by whichever session sees it next: the text is never posted again, its voice attempts keep counting toward the cap of three, and its 段位播报 voice line follows the new session.
A text post is remembered as soon as it is sent, before Discord answers, so a session that stops during the send and a quick return never post it twice.
The session that carries such a match on waits for that send to settle, for its own stop, or for 2 minutes (`IN_FLIGHT_WAIT_MS`) at most, before it decides anything: a post that went out is not posted again, and one that failed is forgotten and posted by that session, so the report is never lost and its voice plays once.
If the send is still unanswered after 2 minutes, its outcome is unknown: the session logs one warning, skips the text so it is never posted twice, and still speaks the report once, and a later answer of the old send posts and speaks nothing more.
A send that fails after the wait ran out, once the session has spoken, is not tried again, so that match is voice only.
When no player is in a channel the voice can use, an unknown post is not the whole report: the match stays pending, with no new warning, until the old send answers.
If it landed, the next poll consumes the match as text only; if it failed, the next poll posts the text.
A 段位播报 whose report text never posts because the old send failed after the match was consumed is dropped with one info line, as in [段位播报](#段位播报).
A match is remembered for 12 minutes (`HANDLED_MS`) after it was last handled, or after the session holding it let go of it; that is the longest a kept baseline can be restored after its account's last read.
At most 50 matches are remembered per guild, the oldest forgotten first, and like the kept baselines they live in memory only.

Each poll reads only the accounts of members in the session, and duplicate PUUIDs are queried once.
An account's new latest match is grouped with every other polled account that reported the same match, so a shared match is announced once per guild.
A match already announced in this session, or remembered as consumed by the guild, only advances the reporting account's baseline.
Pending matches are announced one at a time, oldest `gameEndTimestamp` first, with unknown end times last and then by match ID.
After a match plays, the baseline of every polled account that reported it advances; a failure leaves them all untouched for a retry.
A match whose voice fails three times is consumed the same way without voice, as described in [Text first, timeline and 马厩 records](#text-first-timeline-and-马厩-records).

`pollGuildNow(client, guildId, requiredVoiceChannelId?)` returns `{ announced, errors }` and waits for an already running poll, including the initial baseline poll.
Concurrent timer and command requests share that one poll instead of overlapping.
Manual simulation passes its authorized channel ID, and that restriction also applies when joining an existing automatic poll.
A move outside the required channel cancels the simulation instead of following the member.
A stopped guild returns zero counts.
`stopPolling(guildId)` cancels the session, timer, and match baselines.
`stopAllPolling()` performs the same cancellation for every active guild during shutdown.
`getMonitorStatus(guildId)` reports `presentMemberIds`, the members the session covers in bind order, along with the activity, last check and last error.

The bot advances a match baseline only after voice playback succeeds, or after the third failed voice attempt for that match.
TTS and playback failures before that remain eligible for retry on the next poll.
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
A channel also counts only if the bot can join it (it can see and connect to it, and it is not full unless the bot is in it already) and speak in it, and it is not the server's AFK channel.
Otherwise the join never reaches Ready, which would count as a voice failure.
The test commands refuse the AFK channel and a full channel the same way.

If none of a match's players is in a channel the voice can use, but some are in a voice channel the bot can see and post in, the text report is still posted there, in the channel the same rules choose among those, and the voice is skipped.
The choice is made again after the timeline wait, so a player who reached a channel the voice can use meanwhile gets the voice report there instead.
That covers a full channel, the AFK channel and a channel where the bot lacks Connect or Speak; the bot needs only View Channel and Send Messages in it.
The match is consumed with one info line, `Announced match <id> as text only`, and nothing counts as a voice failure.
A text that cannot be posted is retried on the next poll, counted toward the same attempt cap.
The 锦囊 and the 段位播报 text follow the same rule, and the 锦囊 has no voice line then.
A channel the voice can use is always preferred when any player is in one, and the `TEST_*` restrictions still apply to both.

If none of a match's players is in a channel the text can go to either, the match is neither announced nor consumed in that poll and adds no error.
It is logged once and waits until a player is in a usable channel; if its players leave voice instead, their baselines are dropped with them.
A waiting match keeps its fetched detail for the session, so later polls neither fetch it again nor log it as newly detected.
It is forgotten once none of the accounts that reported it is tracked any more, and at most 20 matches wait per session, the oldest forgotten first.

The report speaks for one tracked player, the speaker, chosen when the match is queued.
It uses the team with the most of the match's tracked players in the chosen channel, on a tie the earliest-bound member's team, and then that team's earliest-bound member, preferring members the session covers.
A tracked member on the other team counts as an enemy: they are neither scored nor named, but they are still mentioned if they are in the channel.
The speech text is fixed before generation, so a later move changes only where it plays.
The text report is posted to the channel chosen before generation and stays there when the voice follows a move.
The speaker stays the one picked for the first channel even when a majority move takes the report to another channel whose players are on the other team.

Only tracked players who still own the account they played on count, read again at every check, so a player unbound during the report neither counts for the channel nor is mentioned.
Once the first two chunks are ready the channel is chosen again, keeping the current pick on a tie.
A move during generation is followed when another channel now has strictly more of the match's players.
During playback the channel is checked every 100 milliseconds the same way.
A tie, such as one player leaving, keeps playing; a channel with strictly more players aborts playback without consuming the match, and the next poll plays it there.

The speaker must still be in voice before each chunk generated ahead of joining and when the bot joins.
If they leave before that, the report is cancelled without being consumed, and the next poll picks a new speaker among the players still in voice.
A retry otherwise keeps the speaker of the earlier attempt while that member still owns the account, is covered by the session and is in a usable channel, even when the report now plays in another channel, so the voice matches the text already posted.
Once playback has started, the speaker leaving does not stop it, so a teammate who played the same game and stays hears the whole report, and the match is not replayed.
Rebinding or unbinding the speaker cancels the report at any point, and the match stays pending for the other players still in voice; an unrelated `/bind` does not cancel it.

Several matches go through the guild's shared voice queue one after another.
A full queue rejects with `AnnouncementQueueFullError` before anything is attempted; it counts as a poll error, the next poll retries it, and it never counts toward the attempt cap.
Internally each queued match is a `DetectedMatch` with its detail, every tracked player of it and the chosen channel, which later features build on.

## Speech and text

`src/services/announcementText.ts` builds deterministic Chinese speech and a channel report from one ranking.
Victory or defeat comes from the PUUID of the tracked player the report speaks for, even when an enemy has the highest KDA.
That player's five teammates are ranked from 特等马 to 没有马; enemies are never scored.
See [Horse ranking](scoring.md) for the scoring model and commentary rules.
Mock speech begins with `模拟战报`, and the mock report carries a mock title and footer.
Participant names are shortened and sanitized before use in speech or Discord text.
A five-horse report is typically 60 to 80 seconds of audio, so the transport allows 240 seconds of playback.

The bot posts the ranking as an embed in the voice channel's text chat before speech generation starts, as described below.
It mentions every tracked member who played the match, still owns the account they played on and is in that channel when it posts, in bind order, and no one else.
Every send uses explicit `allowedMentions` whose `users` list is exactly those members, with automatic mentions and roles disabled.
Riot names cannot trigger mentions of other Discord members or `@everyone`.

### 车队内战

When two or more bound friends play a match on the same team, the report adds a separate in-party ranking.
`src/services/partyRanking.ts` builds it from the team ranking the report already computed, so it adds no new metric and stores nothing, and the 马厩 records are unchanged.

The party is every bound member on the speaker's team, whether or not they are in voice, who still owns the account they played on.
A bound friend on the other team counts as an enemy: they are not ranked, scored or named, though they are still mentioned when they are in the channel.
With fewer than two members, and for remakes, aborted and short games, there is no party and the report and speech are exactly as without the feature.

Members are ordered by the team ranking, so equal scores keep team rank order.
Ties are decided on the displayed score, one decimal place.
The members sharing the top score are the 车队 MVP together, and the 本局背锅 is named only when exactly one member has the lowest score.
When several members share the lowest score nobody takes the blame: they are 并列垫底.
When every member has the same score there is neither an MVP nor a 背锅, and the members are simply 并列.
A single 背锅 is blamed even when that member is 特等马 or 上等马, because the blame is only relative.

A second embed titled `车队内战` is sent in the same message right after the report embed.
It lists each member's mention, champion, tier, score and team rank, such as 队内第 2/5, then names the MVP and the 背锅, each with a short 军师 line about play only.
Tied members share one field, titled `车队 MVP 并列`, `垫底并列 (无人背锅)` or `车队并列`.
In mock mode the title is `模拟战报 · 车队内战`, with the report's gray colour and mock footer.
The members appear as mentions inside the embed, which notifies nobody, so `allowedMentions.users` stays exactly the participants in the channel that the report already pings.

The speech ends with one more sentence, such as `车队内战，A最好，B背锅。`.
It names no tier, and its names are the report's sanitized names, trimmed to keep it within 29 characters.
When the 背锅 is a 特等马 or 上等马 it reads `B今天只是相对背锅` or `B只是相对背锅` instead.
When the best member is only 中等马 or lower, which a duo that finished 4th and 5th can be, it claims no lead: `车队内战，A相对最好，B背锅。`, and the embed line says 相对靠前.
Ties read `A和B并列最好` (or `并列靠前` when they are only 中等马 or lower), `B和C并列垫底`, and `车队内战，A和B并列。` when everyone is tied.
Names that would sound the same after trimming keep the distinguishing end of the name instead, and fall back to the champions when that is not enough.
The wording comes from its own seed built from the match ID, so the same match always produces the same sentence and the report's own wording does not shift.
The sentence is built again for every voice attempt from the members who still own their accounts.
So if a member is unbound between the text post and a voice retry, the spoken sentence follows the live party and can differ from the posted embed.

## Text first, timeline and 马厩 records

Each match goes through these steps once it has a usable channel, in order:

1. The timeline moments are fetched once per match with `fetchMatchEvents`, injected as the monitor's `events` dependency.
2. The speaker, the speech and the channel report are built from the match and those moments with `buildMatchAnnouncement(detail, speakerPuuid, mock, { events })`.
3. The text report is posted to the chosen channel, unless it was already posted for this match.
4. When the post succeeds, the 马厩 records of the posted report are written.
5. The voice report is queued and played.
6. When the voice succeeded but the text could not be posted, for example without Send Messages, the 马厩 records of the spoken report are written then.

A timeline that fails, or that has not answered after 8 seconds, falls back to no moments, logs once and never blocks or fails the report.
The request itself is aborted after 5 seconds, so the monitor's own limit only guards against a stuck dependency.
Stopping the session ends that wait at once as a cancellation, with nothing posted or logged as a fallback.

The text goes out only when the voice is about to be queued: the session is current, the speaker still owns the account and is in voice, and the channel matches any required `/simulate` channel.
So a report that cannot play yet posts nothing, and its text waits for the attempt that can.
Each match's progress is kept for the session: its detail, detection time, timeline moments, whether the text was posted and how many voice attempts failed.
A voice retry on a later poll reuses all of it, so the text is posted at most once per match and the match is not logged as newly detected again.
That progress lives in memory, so after a process restart mid-way a second text post for the same match is possible and accepted.
A failed text post counts as an error and is logged, the voice still plays, and the post is tried again only if the voice also fails and the match is retried.
If the voice then succeeds without a posted text, the records are written after the voice instead, so the 马厩 still has the match.

The records come from `buildHorseRecords` with the posted announcement, the speaker as `perspectivePuuid` and the same moments.
`tracked` is read from every currently tracked member's accounts just before the write, so a member unbound during the report is simply absent.
The write happens once per match, with the text or after the voice when the text failed, and `recordHorseRecords` also leaves an existing (server, member, match, mock) record untouched.
A failed write, including `UntrackedMemberError`, is logged and never fails, repeats or undoes the announcement.
A retry that speaks for a different speaker, because the first one left voice, does not change the records already written from the posted text.

An attempt fails when anything after the match got a channel throws: building the report, for example from a malformed match, speech generation or playback.
A cancellation, such as the speaker leaving or a majority move, and a full voice queue are not failures.
After the third failed attempt for the same match the match is consumed: it joins the session's announced matches, the baselines of the accounts that reported it advance, one line is logged and it is never retried.
Its text report was normally posted on the first attempt, so the channel still has the result; a malformed match is consumed without text or voice.

## Game start

When a tracked member's game is on its loading screen, the bot posts the 军师赛前锦囊 and, unless the server turned it off, speaks a short line of about 15 seconds.
The 锦囊 content is described in [马厩](stable.md#军师赛前锦囊); this section covers when and where it goes out.

### Detection

`src/services/gameStartWatcher.ts` belongs to the guild's monitoring session and starts and stops with it.
It has its own 20 second timer and its own in-flight check, apart from the 45 second match poll, so a long report never delays it.
It checks once right away when the session starts, and soon after a member joins an existing session.
Each tick asks spectator-v5 through `getActiveGame` for every account of the members in the session, once per PUUID, in bind order.
In real mode a saved `MOCK-` account is skipped without a request or a log line; the match poll already warns about it.
Once one account returns a game, every other account among that game's participants counts as in that game for this tick without its own request, so a premade costs one request.
An account already seen in a game is asked again only on every sixth tick (2 minutes), until spectator answers that it is not in a game.
Once the match it was seen in is finished it may already be in the next game, so it is asked on every tick like an account in no game, until spectator no longer lists the old game or lists a different one.
No account is ever asked twice within 20 seconds, counted from the start of the tick that asked it and across monitoring sessions of the guild.
So an early check for a member who joins only asks accounts that were not asked in the last 20 seconds, and a member flapping in and out of voice adds no requests.
Ten accounts therefore cost at most 60 requests in any 2 minutes on na1, which counts its rate limit apart from americas.

Each account has a state for the current presence of its member: unknown, not in a game, or in a game.
A member who leaves voice, is unbound or loses the account starts over as unknown when they are back.
A game is announced when one check finds it still loading (`gameStartTime` 0), or when this account was not in that game at its previous check in this presence and the game has run at most 60 seconds.
Not in that game means no game then, or a different match: a quick requeue found by the in-game recheck.
A game first seen already in progress is recorded as skipped with one log line and is never announced, so joining voice mid-game stays silent.
Only Summoner's Rift (map 11) in a queue the bot announces counts, so ARAM, Arena, custom games and an unknown queue or map are skipped the same way.
A game whose finished match the session already knows (waiting for a channel, being announced or announced) is skipped too.
Every decided game, announced or skipped, is remembered by its match ID for the session, at most 50, so it is announced once even when several members are in it.
The match ID is `NA1_<gameId>`, the ID the finished match will have, and the reserved mock ID in mock mode.

The monitor also remembers, per guild and across sessions, the games whose 锦囊 went out, at most 50 and each for 15 minutes.
A 锦囊 counts as out once its card was attempted.
When the only member in voice leaves during loading, the session stops; when they rejoin, the new session sees the same game loading and skips it with one log line, so nobody hears it twice.
A game that was detected but never got a card, because nobody was in a usable channel, can still be announced by the next session.

A spectator 401 or 403 turns the watcher off for the rest of the session with one log line; finished matches are still announced.
A spectator 429 skips that account for this tick quietly and is never shown to anyone.
Any other failure, including a 404 that is not Riot's `NOT_FOUND`, is a failed check that leaves the account's state as it was, and it never turns the watcher off.
Each kind of failure is logged once, and the first check that answers after that logs one line saying the checks work again, so a stuck watcher and a recovered one look different.
A failure anywhere else in a tick, such as a database read, is logged and counted the same way; a tick never rejects, because its timer does not wait for it.
The watcher's log lines start with `Game start check failed:`, apart from the match poll's `Match monitoring failed:`.

### Text and voice

The channel is chosen as in [Channel choice](#channel-choice), from the game's tracked players who still own the account they play on, both teams included.
The team rated is the one with the most of those players in that channel, on a tie the earliest-bound member's team, preferring members the session covers.
Only bound members on that team reach the brief, with the game name stored with their binding, never the spectator `riotId`.
Other players on that team are a count of 路人队友, bots not counted, and the other team is never scored or named.
A tracked member on the other team in that channel is mentioned in the message so they hear about the game, but is never named or rated in the card or the line.
When none of the game's players is in a usable channel, nothing is posted, and the next tick tries again within the window.

The brief is fixed the first time a player has a usable channel.
The card is posted to that voice channel's chat first, with every send's `allowedMentions` exactly `{ parse: [], roles: [], users, repliedUser: false }` where `users` are the game's tracked players in that channel.
A failed post is logged and not tried again; the voice line still plays.
When the server's pregame voice is on (see [Storage](storage.md)), the line then goes through the guild's shared voice queue as one plain job.
It waits behind a report that is already queued or playing, and a playing report is never cut for it.
Mock cards carry `模拟数据 · 军师赛前锦囊` and the mock footer, and mock lines start with `模拟锦囊，`.

### Window and cancellation

The loading screen lasts about one to three minutes, so the line has 90 seconds from detection to start playing.
Before each generated chunk and before joining, it needs the window, a finished match for the same ID that the session does not know yet, a player of the rated team who is still in voice, and a usable channel.
If any of those fails before playback, nothing is heard, and the next tick may queue it again while the window lasts.
After 90 seconds a line that has not started is dropped with one log line, and the text stays.
Once the line is playing it finishes where it started, even when its players leave or move; only the session stopping, when the last tracked member leaves voice, aborts it.
A generation or playback failure is not retried, because the text is already there.
The memory lives in the process, so a bot restart during loading may announce the game again; that duplicate is accepted.

`/simulate outcome:开局（赛前锦囊）` works only in mock mode.
It starts a labeled mock game for the tracked members in the test channel on their first accounts, asks the watcher to check at once and waits for the card and the line.
Ending the game later with `/simulate outcome:胜利` or `失败` reuses the same match ID, so the start and the finished report are one match.

### Recap

When a 锦囊 card had a 军师之选, the horse embed of that game's finished report gets one more field, `锦囊回顾`, naming the pick and how the call turned out.
It is text only: the spoken report is the same with and without it.
The monitor remembers the pick per guild, across monitoring sessions, with the match ID, the member, the account they played on and whether the card was mock.
A pick is remembered only once somebody could see or hear its card: when the card's text was posted, or when its voice line started playing.
A card that failed to post and never played leaves nothing to recap.
That memory is kept for 3 hours, at most 50 picks, the oldest dropped first, because a game lasts 20 to 45 minutes and its report may wait for a channel.
It lives in the process like the rest of the game start memory, so a bot restart during the game loses it and the report simply has no field.
The field appears only when the pick is among the players the report ranks, which are the team it rates, and the account is still bound to the same member.
The card and the report must be in the same data mode, so a mock pick never decorates a real report and the reverse.
No pick, because the card was cold or never shown, means no field, and so does a match the report does not rate, such as a remake, an aborted game or one that was too short.
The tier and the name come from the report's own ranking (`players` on the announcement), the same data as the rows of the embed, so the line can never disagree with them.
The wording depends on the pick's tier in that match and is chosen from a small pool, seeded by `recap:<matchId>` so the same match always shows the same line.
A 特等马 pick celebrates the call, a 上等马 pick says it held up, and a 中等马 pick calls it so-so.
For a 下等马 or a 没有马 pick the 军师 admits to misjudging, and the joke stays on the 军师, never on the player.
The line names only the pick, by the name that player's row in the same embed shows, and nothing about enemies or other players.
Chinese text has no spaces around the name, and a name gets a space only on a side where its first or last character is an ASCII letter or digit, as in `军师点名的小明本局` and `军师点名的 Faker 本局`.
Mock reports keep their mock label.

## 段位变化

A finished solo/duo (queue 420) or flex (queue 440) match that is not a remake or aborted gets one more field on the horse embed, `段位变化`.
The field is text only: the spoken report never mentions LP, so it stays the same length whether or not LP is ready.
A promotion or demotion additionally gets its own [段位播报](#段位播报).
How the reads are made, paced and retried is in [Riot data](riot-data.md#rank-tracking); this section covers when they happen and what the report shows.

### Reads around a game

`src/services/rankTracker.ts` keeps one process-wide tracker, the monitor's `rank` dependency, shared by every guild so an account bound in two servers costs one read.
It reads an account's rank at three points:

- When Phase A records an account's baseline, as the fallback before-value.
- When the game start watcher first decides about a ranked game, announced or skipped, for every bound player in it on both teams, because LP does not move during a game. This read absorbs a dodge, decay or a remake penalty since the last read. A game whose finished match the session already knows is over and reads nothing.
- When Phase B detects the finished match, for every bound player of it on both teams. A read that caught up is the before-value of that account's next game, although only the reported team gets a row.

The read at the game's start is retried on later in-game rechecks, up to 3 more times per player, for the players who still have no successful read since the first sighting; see [Riot data](riot-data.md#rank-tracking).
A game the watcher saw at its start whose before-value is still older than that sighting shows as unattributable, because the older read may hold a dodge or decay.
A game the watcher never saw, such as one that began before monitoring, and mock data keep using the newest read from before the game ended.

A match's before-value is the newest of the account's recent reads that was sent at or before the game's end, or the newest read when the end time is unknown.
So when a player requeues and the next game's start is read before the poll detects the last game, that read, which already holds the last game's result, is not compared with it.
A read sent after the game ended is never its before-value; with nothing older the row is left out.

A remake, an aborted game and every other queue read nothing.
So a leaver penalty from a remake without a later game start read leaks into the next game's change, a documented limitation.

### Waiting and the late edit

The report waits for the first after-reads only inside the timeline's wait: both start together and share the same 8 second limit, so LP never adds to the worst case.
A row that league-v4 has not updated by then is posted as pending, and the tracker reads it again in the background.
Once every pending row of the report has settled, the report message is edited once, with the same content, the same embeds apart from `段位变化` and the same `allowedMentions`.
The posted `Message` is kept in the match's progress, and the edit goes to that message.
The edit runs apart from the poll and changes nothing else when it fails.
A report someone deleted (Discord's Unknown Message, code 10008) is one info line, and any other failed edit is logged as an error.
At shutdown `stopAllPolling` stops the tracker as well: queued reads do nothing, retries are cleared, pending rows settle with no row, and no edit goes out on the closing client.
A bot restart drops pending reads, so such a row keeps saying it is not updated.

No LP failure delays the report beyond the timeline wait, fails it, counts as an error of the poll or counts toward the voice attempt cap.

### Rows

There is one row per bound member on the reported team, from the same party list as the 车队内战: every tracked member on the speaker's team who still owns the account they played on, in voice or not.
Strangers, enemies and a bound friend on the other team never get a row.
Members appear as mentions inside the embed, which notifies nobody, so `allowedMentions` stays exactly the report's ping set.
`src/services/rankText.ts` owns the wording: tiers as `黄金 II` (MASTER, GRANDMASTER and CHALLENGER without a division), and the queues as `单双排` and `灵活组排`.

| Case | Row |
| --- | --- |
| One game, same division | `<@id> 单双排 黄金 II · 86 LP · 本局 +22` |
| Promotion | `<@id> 单双排 铂金 IV · 7 LP · 本局 +24 · 晋级！` |
| Demotion | `<@id> 单双排 白银 I · 75 LP · 本局掉段` |
| No start read, or several games since the before-value | `<@id> 单双排 黄金 II · 64 LP · 赛前段位没读到或中间隔了几局，本局变化算不出来` |
| Placements finished | `<@id> 单双排 · 定级完成：黄金 IV` |
| League-v4 not updated yet | `<@id> 单双排 · 段位还没更新，稍后补上` |
| Still not updated after the last read | `<@id> 单双排 · 段位一直没更新，本局变化算不出来` |
| The read failed | `<@id> 单双排 · 段位暂时查不到` |

A demotion shows the new rank and its LP, which are Riot's, but no change, because the ladder distance is not the LP Riot actually takes on a demotion until a real one has been measured.
Every division and tier change counts as a promotion or demotion, in both queues; a move between MASTER, GRANDMASTER and CHALLENGER happens through cutoffs and shows as a plain change.
No row is shown for an account that is unranked before and after, whose entry disappeared, whose tier is unknown, that has no before-value at all, or when LP is off after a 401 or 403.
A mock before-value is never used in real mode, or the reverse.

### Stored results

A row that reaches a final state is also written to `rank_results` (see [LP results](storage.md#lp-results)), once per member and match, for the same members as the rows.
The final states are a change, a promotion, a demotion, a placement and an unattributable change; a pending, stale or unavailable row and a row that is left out are not stored.
The monitor writes at two points: with the report, for the rows the first reads already settled, and after the late update, for the rows that settled since.
The late write offers every final row again, and the key ignores the ones already stored, so a row cannot be stored twice or changed.
Each write reads the bindings live and offers only the members who still own the account they played on, and the store checks the same ownership inside its transaction, so a member who unbinds while a row is pending never gets that row back.
An erase leaves the member bound, so both the LP write and the 马厩 write also skip a member whose `/stable-erase` came after the match was detected (an in-memory cutoff, see [storage](storage.md#马厩-horse-records)); a match detected after the erase is recorded normally.
The write follows the posted report, so a match whose text report never posted stores nothing. Both the LP and the 马厩 writes are skipped once the monitor has shut down, even when the send was already under way, so the closed database is never reopened.
A storage failure is logged as an error line, `The LP results of match <id> were not saved`, and never affects the report, the late edit, the 段位播报 or the voice attempt count.

## 段位播报

A bound member on the reported team whose row in a ranked match (420 单双排 or 440 灵活组排) is a promotion or a demotion gets a separate announcement, in addition to the `段位变化` row.
Every division and tier change counts, in both queues.
A move among MASTER, GRANDMASTER and CHALLENGER happens through cutoffs, so it is a plain change and is never announced.
A row that is unattributable (several games since the before-value), placed, pending, stale or unavailable is never announced either.
`src/services/rankText.ts` owns the decision (`rankMoveOf`) and the wording.

### Text

The announcement is its own embed in the report's channel, titled `段位播报`, or `模拟数据 · 段位播报` in mock mode.
It has one line per announced member, in party order, with tiers as `黄金 II` and the current LP:

| Case | Line |
| --- | --- |
| Promotion | `<@id> 单双排 晋级：黄金 I → 铂金 IV · 7 LP` |
| Demotion | `<@id> 单双排 掉段：黄金 IV → 白银 I · 86 LP` |

A demotion shows no LP change number, for the same reason as the `段位变化` row: the ladder distance is not the LP Riot actually takes until a real demotion has been measured.
The members are mentions inside the embed, which notifies nobody, and the message carries no content and an `allowedMentions` that pings no one.
Strangers, enemies and a friend on the other team are never listed.

### When it is sent

It is sent after the report's text, once per member per match:

- as soon as the first LP reads show a promotion or demotion, and
- again, as a follow-up message, for each member whose move only the late update shows.

The monitor keeps the members it announced in each match, so nobody is announced twice, and a follow-up lists only the members not announced yet.
The `段位变化` field still shows every member.
The messages go to the channel where the report text was actually posted; if a retry posts the report in another channel, the 段位播报 follows it.
A message that fails to send is logged and never retried, and it never affects the report.
If the report's text never posts, the 段位播报 is dropped with one info line.

### Voice

Each message has one short plain voice job in the shared voice queue, with one attempt and no retry, like the 锦囊.

- A line is queued only after the report's own voice has finished, never before it and never ahead of it. Lines that become ready earlier wait in a queue and are flushed in order when it finishes; lines that become ready later, from the late update, are queued at once.
- It is queued only if a member of the reported team is still in a usable voice channel and still owns the account; an enemy or a stranger in voice does not count. Otherwise the announcement stays text only, with one info line.
- If the report's voice hits its attempt cap, the waiting lines stay text only, with one info line.
- It speaks tiers as `黄金二`, for example `军师贺喜！小明单双排升到铂金四了。` or `小明单双排掉回黄金一，别急，军师陪你重新上马。`
- Each sentence is chosen from a small pool, seeded by `rank:<matchId>:<puuid>`, so the same match always says the same thing.
- A line has at most two sentences. Further members of the same message are in the text only. The names of one line share a budget of 12 characters, so a line stays at about 15 seconds or less.
- Two names that would sound the same after trimming to the budget keep their distinct ends instead, so two members are never spoken as one.
- Mock lines start with `模拟段位播报，`.
- A voice failure, or any failure on this path, is logged and never counts toward the report's voice attempts or replays the report: the line is handled after the match was consumed.

### /simulate

`/simulate outcome:晋级（模拟）` and `掉段（模拟）` work only in mock mode and are refused in real mode like the other choices.
They place the first bound mock account of the earliest-bound member in the test channel at GOLD I 90 LP (solo) or GOLD IV 5 LP, keeping its games.
They make that entry the before-value of the next game, then simulate a win (+22, so PLATINUM IV 12) or a loss (-19, so SILVER I 86).
The result is the `段位变化` row and the `段位播报` with its voice line.
Adding the choices changes the registered command definition, so `npm run register` has to run once after this change.

## Diagnostics

The bot logs to the terminal and its daily log file, described in [Runtime](runtime.md#logs).
It logs when monitoring starts, with each present member's Riot IDs and voice channel, and when it stops, with the reason.
It logs when a member joins or leaves an existing session.
It logs each account's baseline match, after which finished matches are announced, or that a joining member's latest match ended after they joined and is announced.
It logs each newly detected match with the reporting Riot IDs, how many seconds have passed since the game ended, the queue and the length.
It logs once when a match waits because none of its players is in a usable voice channel.
It logs when a match's timeline is unavailable and the report falls back to statistics.
It logs how many 马厩 records it saved for a match after posting its text, or after its voice when the text failed.
When the bot joins a channel with the first two speech chunks ready, it logs how many seconds that was after detection, the latency until the first sentence plays apart from the connection itself.
After playback it logs how many seconds speech generation and playback took after detection.
It logs once when it gives up on a match's voice after three failed attempts.
For a game start it logs the detection, a skipped game once with the reason, the posted card, when the line starts and ends, and a dropped line.
For LP it logs, once per account and match, `league-v4 caught up N s after game end (read k)` or that it had not caught up after the last read, a row left out as `none/entry_lost`, and the late `段位变化` edit; see [Riot data](riot-data.md#rank-tracking).
It also logs a posted `段位播报`, one that stays text only, a spoken one, and a voice line that was not played or failed.
Together they show whether a slow announcement waited on Riot's match data, the poll interval or speech.
A saved mock account skipped in real mode is logged as a monitoring failure that names the account.
Startup in real mode and `npm run doctor` also warn about each saved mock account before anyone joins voice.
In real mode `/bind` removes the member's saved mock accounts, names them in its reply and logs the change, as does `/unbind`.

`/recent [count] [user]` replies privately with the monitoring state and the bound accounts' recent matches in every queue, for the whole server or one member.
The state shows whether monitoring is active, the last check and the last error, which survives a stop caused by rejected credentials.
It lists each member shown with their place in the bind order, their voice channel or 不在语音, and whether the session covers them.
Each account's field starts with its member's number, and the embed shows at most 25 accounts across all members.
Discord also caps an embed at 6000 characters, so the match lists share what the title, status lines, footer and field names leave evenly.
A list that does not fit keeps its newest matches and ends with `…`, and every account keeps at least its newest match.
Each match shows the result, champion, K/D/A, queue, length and end time.
It is marked as the baseline, already announced, due at the next check, or in a mode that is never announced.
In real mode a saved mock account is flagged without a Riot request.

`announced` counts completed voice announcements.
`errors` counts observed Riot, speech, transport, or text-send failures.
A text-send failure followed by completed audio returns `{ announced: 1, errors: 1 }` and nothing is repeated next time.
A failed 马厩 write is logged but adds no error count, since the announcement itself did not fail.
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
A session abort, the speaker leaving voice, or the speaker's rebind cancels the handoff before joining and stops any further chunk from starting.
After joining, only a session abort, the speaker's rebind or a different channel choice stops it.
During playback, channel eligibility is checked every 100 milliseconds and a different choice aborts the transport.
A cancelled announcement cancels the chunk request in progress instead of waiting for it, never joins a channel afterward and reports `AnnouncementCancelledError`.
Audio from a cancelled request that still arrives is deleted.

A chunk that fails twice stops playback immediately and fails the announcement, so the match stays eligible for retry.
The deadline fails the announcement the same way, and is not reported as a cancellation.
The retry speaks the whole report again from its first sentence, because only a completed playback advances the match baseline.
A failure of either of the first two chunks never joins a channel.
A third or later chunk that fails on every attempt is still heard as a partial report on each poll until the match monitor's three-attempt cap consumes the match.

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
It also pins the text-first order, the once-only text and 马厩 write across voice retries, the timeline fallback and its prompt end on a stop, the sticky speaker, records written after the voice when the text fails, the three-attempt cap for voice and report-building failures but not a full queue, and the silent mock baseline after a restart.
It also pins a leave and quick return while the text is being sent: one post and one voice when the send succeeds, a repost by the new session when it fails, and a stop or shutdown during the wait that ends it at once.
It also pins the freshness allowance: a blip during or right after a teammate's long report keeps the baseline, while one two poll intervals after the last poll, or after a poll whose reads all failed, does not.
It also pins the `段位变化` rows of the reported team only, a stuck LP read that still posts within the timeline wait, LP failures that never fail the report, an LP 403 that turns off only LP, and the single late edit with the same mentions.
It also pins the `段位播报`: the separate mock-labeled message right after the report, the voice line queued only after the report's voice finished, no announcement for a move among the apex tiers, text only when nobody of the team is in voice, a single announcement per member with a follow-up for a late move, lines queued behind the report's voice, a rank failure that never replays the report, and a failed line that is neither retried nor counted against the report.
`tests/simulateRank.test.ts` runs `/simulate` 晋级 twice and 掉段 through the real command, monitor and tracker.
`tests/rankText.test.ts` pins which rows are announced, the line wording, the seeded and capped voice wording and the mock prefix, and `tests/commands.test.ts` pins `/simulate` 晋级 and 掉段.
`tests/rankTracker.test.ts` pins the row wording, the mode-keyed snapshots, the 60 second floor and the 4-read cap under fake timers, serialized reads and each failure kind.
`tests/partyRanking.test.ts` pins the 车队内战 order, the 背锅 wording, the sentence length, the exclusion of other-team friends and the embed, and `tests/monitor.test.ts` pins the second embed and the unchanged ping set.
`tests/voicePresence.test.ts` drives voice events through the real lifecycle into a monitor with fake Riot I/O.
`tests/gameStart.test.ts` runs the real monitor, watcher and voice queue with a fake spectator, clock, speech and Discord.
It pins the detection rules, the premade dedup and the sixth-tick recheck, the requeue found by that recheck and the early recheck after a finished match, the request budget with fake timers, the queue filter, the voice switch, the 90 second window, the finished-match cancel, leaving before and during playback, the rated team, the exact mentions, the quiet 429 and the 403 that leaves match monitoring on.
It also feeds a game with enemies, strangers and a friend on the other team through the watcher and checks that none of their names, PUUIDs or champions reach the card or the line.
It checks that a ranked game's start reads both teams' bound players, announced or skipped, so a dodge before it never shows as that game's LP.
It covers the guild memory: the only member leaving and rejoining during loading gets one card and one line, a 锦囊 is forgotten after 15 minutes, and the memory keeps at most 50 games.
It also checks that a member flapping in and out of voice costs at most 6 requests per account in 2 minutes, that a failure inside a tick is logged once and never rejects, that the first working check after a failure logs one recovery line, and that the watcher logs with its own prefix.
`tests/voiceAnnouncements.test.ts` verifies queue serialization, chunk ordering, the two-chunk join, inline retry, early and mid-stream generation failure, cancellation between chunks and during playback, the announcement deadline with a chunk that never resolves, channel changes, limits, and cleanup of every chunk file.
`tests/speechChunks.test.ts` verifies sentence boundaries, ASCII end marks inside names, preserved separators, decimal scores, hard cuts that keep words and numbers whole, short and long sentences and the length limits.
`tests/voicePlayback.test.ts` uses the installed voice library's `entersState` with fake transports to verify playback lifecycle, chunk stitching, decoding before joining, gaps while a chunk generates, and failure cleanup.
It also decodes a real WAV through the installed FFmpeg.
These tests never connect to or mutate a real Discord server.
Real Discord playback and human listening remain separate acceptance steps.
