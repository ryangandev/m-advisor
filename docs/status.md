# Current status

## Approved delivery

Restore the runtime, implement explicit mock/real Riot modes, persist settings, repair monitoring, integrate local Qwen and add restricted voice/simulation test commands.
Each independently verified task is committed and pushed separately on `codex/local-qwen-e2e`.

## Acceptance

Runtime restoration passed compilation, executable FFmpeg conversion, Opus frame round-trip, native encryption and DAVE loading checks.
The updated dependency graph reports zero npm audit vulnerabilities.
SQLite persistence passed 12 tests, including separate-process restart, transaction rollback and guild isolation.
Explicit mock/real Riot data and mock UI labels passed 20 provider/request/UI tests.
Persistent local Qwen speech passed worker/provider tests and actual offline generation with both Serena and Uncle_Fu.
Warm Node API validation generated a valid WAV and shutdown removed its temporary directory.
Monitoring and shared voice playback passed behavioral tests for historical baselines, correct tracked-account results, retries, duplicate prevention, cancellation and channel restrictions.
An isolated mock-loss match passed real Qwen generation and FFmpeg Opus conversion through the shared pipeline in 19.58 seconds.
That local pipeline verification used a simulated Discord transport, not a live channel.
Command/lifecycle integration and command migration passed the complete 148-test suite and compilation.
An independent temporary checkout without credentials or user data passed `npm ci` and the earlier 139-test suite with no failures, skips or warnings.
That clean installation also reported zero npm audit vulnerabilities.
The actual Discord Gateway login, local speech prewarm and SIGTERM shutdown also passed with an isolated empty database and exit code 0.
That Gateway check did not register commands, join voice or send messages.
The read-only Discord preflight confirmed that the proposed General channel is accessible and that the bot has View Channel, Connect, Speak and Send Messages permissions there.
After Ryan authorized the proposed target on 2026-10-02, local configuration was set to Ry的四合院 / General with mock Riot data and local Qwen speech.
The current seven commands were registered in that server.
Actual Discord UI testing exposed duplicate global and guild command choices, including an obsolete announcer definition without the current parameter.
The explicit single-server migration retired six known legacy global definitions; a fresh REST inventory confirmed zero globals and all seven guild commands.
The current handler acknowledges retired and unknown commands privately instead of allowing a timeout; seven regression tests cover this path and safe error replies.
Both Serena and Uncle_Fu `/testvoice` invocations completed the actual Discord playback lifecycle and returned their completion reply in the client.
The bot left General after each playback, while Ryan's client remained muted and listening.
The isolated live Discord verifier then passed full win and loss announcements with real Qwen speech, actual voice transport and two actual mock report messages in 95.279 seconds.
Gateway observations confirmed two joins, two leaves and no remaining voice connection; repeat polls produced no duplicate announcements.
That verifier left the normal bot's stored bindings and voice preference untouched.
After the Mac was unlocked and Discord reloaded, actual `/profile`, `/bind` and `/bindings` confirmed the labeled mock profile and intended saved account.
Both native `/simulate` outcomes completed and returned their explicit simulated-data confirmations.
An actual Ctrl+C shutdown exited cleanly, and relaunch restored the saved MockWin binding and Old Man voice preference.
The subsequent native `/bindings` command confirmed the restored account; neither startup nor later polls replayed a historical report.
Leaving General during a new simulation cancelled the pending announcement and returned a failure reply without claiming success.
A fresh actual message inventory confirmed exactly four reports from the two completed win/loss runs, with no duplicate or cancelled-match report.
Native `/unbind` and `/bindings` confirmed removal and an empty list, while the voice preference remained saved.
The MockWin binding was then restored for continued testing, and Ryan rejoined General with the microphone muted.
The pre-implementation audit verified Discord credentials and the installed offline Qwen model.
The pre-implementation Riot credential check returned HTTP 401.
Live short voice playback and complete simulated-match Discord transport have passed; human listening remains pending.

## Horse ranking delivery

On 2026-10-03 the local Riot key returned HTTP 200.
Real league-v4 entry, match-v5 history and match-v5 detail requests then collected the reference sample described in [Horse ranking](scoring.md).
That proves real API access; real-mode bot acceptance with Ryan's own bound account and a finished game is still pending.
The position-aware ranking replaced KDA commentary, and the fairness report is recorded in [Horse ranking](scoring.md#validation).
`npm run check` passed the build and the complete suite, including ranking, commentary, parsing and transport-timeout tests.
`npm run verify:local` generated the full mock report with real offline Qwen speech and FFmpeg Opus conversion; Discord transport was simulated.
A separate Uncle_Fu rendering of the mock win report produced 74.8 seconds of audio in 55.3 seconds.
Both voices now use exaggerated, sarcastic style instructions; human listening of the new style is pending.
The new embed report has not yet been checked in the live Discord channel.

## Diagnostics delivery

On 2026-10-04 a real game finished while the bot was running and was not announced.
The cause was configuration, not detection: local `.env` had switched to `RIOT_MODE=real`, but the server was still bound to the mock `MockWin#NA1`, which real mode skips.
The running process also predated the detection log.
Monitoring now logs its start, each account's baseline, each detected match with the seconds since the game ended, completed playback and its stop reason.
`/recent` shows the bound accounts' recent matches, the monitoring state and the last error; see [Announcements](announcements.md#diagnostics).
The unused Azure speech provider and its configuration were removed; speech is local only.
`npm run check` passed the build, the full type check including `scripts/` and `tests/`, and 181 tests.
In real mode `npm run doctor` passed, eight commands were registered, and the live bot logged the start of monitoring and the skipped mock account.
`/recent` has not yet been run in the live Discord channel.

On 2026-10-05 the bot gained daily log files and a guard against saved mock accounts in real mode; see [Runtime](runtime.md#logs).
`npm run check` passed with 197 tests, and mutation checks confirmed that the new tests fail when each guarded behavior is removed.
In real mode `npm run doctor` and the restarted live bot both warned that the saved `MockWin#NA1` is skipped.
The live bot wrote its startup messages and that warning to `.data/logs/bot-2026-10-05.log` with mode `0600`.
The real-mode `/bind` cleanup is covered by tests but has not yet been run in Discord.

## Real Riot acceptance

On 2026-10-06 the live bot in real mode removed the saved `MockWin#NA1` binding and bound Ryan's real account `not ry#tan90`.
Monitoring started in General and recorded `NA1_5654095416` as the baseline.
On 2026-10-07 the bot detected the finished match `NA1_5655858513` (queue 400, 36 minutes) 44 seconds after it ended.
Speech generation and voice playback completed 132 seconds after detection, about three minutes after the game ended.
A read-only REST read of General found exactly one bot report for that match at 07:26:55 UTC, 0.2 seconds after playback finished.
The embed carries the 马匹排行, 军师表扬 and 军师批评 fields and the `Riot 实时数据` footer, with no mock label.
Ryan confirmed that he heard the spoken report in the channel.
The log shows no Riot, speech, transport or text-send error, and monitoring stopped normally when Ryan left voice.
This is the first real-mode end-to-end acceptance; `/recent` has still not been run in the live channel.

## Streamed speech delivery

On 2026-10-27 announcements began playing after their first sentence instead of after the whole report.
On a warm worker the mock win report's first audio arrived after 2.89 seconds instead of 24.92, and the whole announcement took 85.49 seconds instead of 96.71; see [Local voice](local-voice.md#sentence-chunk-latency).
Playback starts once two chunks are ready, a failed chunk is retried once, and one 360 second deadline bounds each announcement.
A later chunk that fails on every attempt is still heard as a partial report on each poll until the monitor caps attempts per match.
`npm run verify:local` passed with real Qwen speech in 14 chunks and simulated Discord transport, before the two-chunk join and retry were added.
Live Discord playback and human listening of the chunked delivery are pending.

## Feature round delivery

On 2026-10-27 the nine features chosen in the 2026-10-26 product review were delivered, followed by rank and LP changes.
Each PR had an independent review before merge, and the final `npm run check` on main passed 827 tests.

- Several tracked members per server, each with several Riot accounts, and each match announced in the channel where its players are ([#6](https://github.com/ryangandev/m-advisor/pull/6), [#9](https://github.com/ryangandev/m-advisor/pull/9), [#13](https://github.com/ryangandev/m-advisor/pull/13)).
- Speech that starts after the first generated sentence ([#8](https://github.com/ryangandev/m-advisor/pull/8)); see [Streamed speech delivery](#streamed-speech-delivery).
- Match-v5 timeline moments cited in the praise and roast ([#7](https://github.com/ryangandev/m-advisor/pull/7)).
- 马厩 horse records with `/stable` and `/stable-erase` ([#10](https://github.com/ryangandev/m-advisor/pull/10)); see [马厩](stable.md).
- `/why` 判决书 with a radar image and 上诉 ([#11](https://github.com/ryangandev/m-advisor/pull/11)); since [#28](https://github.com/ryangandev/m-advisor/pull/28) closed appeal cases survive restart and the radar bundles its own Chinese font; see [Why](why.md).
- Daily and weekly 马报 with optional weekly roles ([#12](https://github.com/ryangandev/m-advisor/pull/12)); see [马报](ma-bao.md).
- 车队内战 in-party ranking in the finished-game report ([#17](https://github.com/ryangandev/m-advisor/pull/17)).
- 军师赛前锦囊 on the loading screen, rating teammates only, with a per-server voice switch ([#14](https://github.com/ryangandev/m-advisor/pull/14), [#15](https://github.com/ryangandev/m-advisor/pull/15), [#16](https://github.com/ryangandev/m-advisor/pull/16), [#18](https://github.com/ryangandev/m-advisor/pull/18)), and a text-only 锦囊回顾 on the finished report ([#19](https://github.com/ryangandev/m-advisor/pull/19)).
- Rank and LP changes: each ranked report shows every bound member's tier, LP and LP change, promotions and demotions get a separate 段位播报 card and a short voice line, and final LP results are stored ([#27](https://github.com/ryangandev/m-advisor/pull/27), [#29](https://github.com/ryangandev/m-advisor/pull/29), [#30](https://github.com/ryangandev/m-advisor/pull/30), [#31](https://github.com/ryangandev/m-advisor/pull/31)); see [Announcements](announcements.md).
- A Chinese user site at madvisor.rystudio.app ([#25](https://github.com/ryangandev/m-advisor/pull/25), [#32](https://github.com/ryangandev/m-advisor/pull/32)); see [Site](site.md).

The schema is now at v7.
Ryan's local database is at v7: a test run on 2026-10-31 upgraded it before the tests were isolated from `.data` (see [Audit round 2](#audit-round-2)).
The 13 slash commands were registered again in Ry的四合院 after #30.

This round's evidence is compilation and mock tests only.
Live Discord posting and playback of the new cards, human listening of the 锦囊 and 段位播报 lines, and real Riot acceptance of these features are pending.
A demotion row shows the new LP without a change until real games confirm the LP Riot reports after a demotion.
The bot logs how long league-v4 takes to catch up after each game, and about 10 real ranked games are needed to tune the report's later edit.
[#24](https://github.com/ryangandev/m-advisor/issues/24) waits for a spectator-v5 capture during a real game.

## Audit round

On 2026-10-27 and 2026-10-28 a read-only audit of main filed 32 issues ([#34](https://github.com/ryangandev/m-advisor/issues/34) to [#65](https://github.com/ryangandev/m-advisor/issues/65)), 6 of them p1.
All 32 are fixed; each fix PR had an independent review before merge, and the final `npm run check` on main passed 896 tests.

- Tooling: a GitHub Actions `check` workflow runs `npm ci` and `npm run check` on every PR, the build clears `dist` first, the Node floor is 24 because better-sqlite3 crashed on 22.12, and `npm run probe:spectator` captures spectator-v5 fields for #24 ([#66](https://github.com/ryangandev/m-advisor/pull/66)).
- Commands: every interaction reply sets `allowedMentions` explicitly, enforced by a test that scans the sources ([#67](https://github.com/ryangandev/m-advisor/pull/67)).
- Storage: `/stable-erase` overwrites erased rows and truncates the WAL, and the privacy page discloses the pre-upgrade backups ([#68](https://github.com/ryangandev/m-advisor/pull/68)).
- 马报 and `/why`: ties, medals and gaps follow the printed numbers ([#69](https://github.com/ryangandev/m-advisor/pull/69)).
- Riot data: match and queue caches are bounded, `/recent` limits its concurrency, mock match IDs no longer collide across restarts, and a rank result whose pre-game snapshot never loaded is shown as not attributable instead of a wrong LP change ([#70](https://github.com/ryangandev/m-advisor/pull/70)).
- Monitoring: each server remembers the matches it already handled, so leaving and rejoining voice never repeats an announcement, and a full or AFK voice channel falls back to a text-only report ([#71](https://github.com/ryangandev/m-advisor/pull/71)).
- Tests: migration backup log lines no longer print among the test results ([#72](https://github.com/ryangandev/m-advisor/pull/72)).

The schema stays at v7.
This round's evidence is compilation, mock tests and CI only; it adds no live Discord or real Riot acceptance, so B5 to B7 still cover it.
[#73](https://github.com/ryangandev/m-advisor/issues/73) tracks a lifecycle test that failed once under parallel load.

## Audit round 2

From 2026-10-31 an autonomous round audited the areas the first round covered least, then reviewed how its own fixes combine.
It closed 54 issues ([#73](https://github.com/ryangandev/m-advisor/issues/73), [#77](https://github.com/ryangandev/m-advisor/issues/77) to [#83](https://github.com/ryangandev/m-advisor/issues/83), [#87](https://github.com/ryangandev/m-advisor/issues/87), [#89](https://github.com/ryangandev/m-advisor/issues/89) to [#95](https://github.com/ryangandev/m-advisor/issues/95), [#100](https://github.com/ryangandev/m-advisor/issues/100), [#103](https://github.com/ryangandev/m-advisor/issues/103) to [#106](https://github.com/ryangandev/m-advisor/issues/106), [#109](https://github.com/ryangandev/m-advisor/issues/109) to [#112](https://github.com/ryangandev/m-advisor/issues/112), [#117](https://github.com/ryangandev/m-advisor/issues/117) to [#124](https://github.com/ryangandev/m-advisor/issues/124), [#131](https://github.com/ryangandev/m-advisor/issues/131) to [#133](https://github.com/ryangandev/m-advisor/issues/133), [#135](https://github.com/ryangandev/m-advisor/issues/135), [#137](https://github.com/ryangandev/m-advisor/issues/137), [#139](https://github.com/ryangandev/m-advisor/issues/139), [#140](https://github.com/ryangandev/m-advisor/issues/140), [#144](https://github.com/ryangandev/m-advisor/issues/144), [#145](https://github.com/ryangandev/m-advisor/issues/145), [#147](https://github.com/ryangandev/m-advisor/issues/147) to [#150](https://github.com/ryangandev/m-advisor/issues/150) [#154](https://github.com/ryangandev/m-advisor/issues/154) to [#157](https://github.com/ryangandev/m-advisor/issues/157), [#164](https://github.com/ryangandev/m-advisor/issues/164), [#165](https://github.com/ryangandev/m-advisor/issues/165), [#167](https://github.com/ryangandev/m-advisor/issues/167) and [#168](https://github.com/ryangandev/m-advisor/issues/168)) and [#20](https://github.com/ryangandev/m-advisor/issues/20).
Each logic fix had an independent review or a mutation-checked self-review before merge, and `npm run check` on main passes 1044 tests.

- Dependencies and tests: undici is bumped past the audit advisory ([#75](https://github.com/ryangandev/m-advisor/pull/75)), and the lifecycle and timeline 429 tests are stable under parallel load ([#76](https://github.com/ryangandev/m-advisor/pull/76), [#107](https://github.com/ryangandev/m-advisor/pull/107)).
- 马报: after a day or more off the newest missed period that has games is posted, Mac sleep no longer counts toward the 6-hour give-up, and a server the bot was removed from, even mid-send, is skipped without losing its period ([#84](https://github.com/ryangandev/m-advisor/pull/84), [#113](https://github.com/ryangandev/m-advisor/pull/113)).
- Shutdown: closing the launcher's Terminal window (SIGHUP) runs the normal shutdown, and stale speech temp folders are swept at start ([#85](https://github.com/ryangandev/m-advisor/pull/85)).
- Monitoring: a session that stops while its report send is in flight never posts it twice, a brief leave right after a long report keeps the baseline, the wait on another session's send is bounded, and a report whose earlier send hung and then failed is still posted ([#86](https://github.com/ryangandev/m-advisor/pull/86), [#88](https://github.com/ryangandev/m-advisor/pull/88), [#115](https://github.com/ryangandev/m-advisor/pull/115)).
- Server removal: removing the bot stops that server's monitoring through the per-server chain, and inviting it back resumes monitoring for members already in voice ([#114](https://github.com/ryangandev/m-advisor/pull/114)).
- 军师赛前锦囊: the 打野 label needs Smite, the trend labels its earlier window by the real game count, and a new game ID at the in-game recheck counts as a fresh start that is rechecked every tick once the old match is finished ([#97](https://github.com/ryangandev/m-advisor/pull/97), [#98](https://github.com/ryangandev/m-advisor/pull/98), [#101](https://github.com/ryangandev/m-advisor/pull/101)).
- Diagnostics: `npm run doctor` exits non-zero when the configuration cannot start the bot, and `npm run probe:spectator` prints raw spectator-v5 fields and exits non-zero on a Riot error ([#99](https://github.com/ryangandev/m-advisor/pull/99)).
- Docs: drift between the docs, the site and the code is corrected ([#96](https://github.com/ryangandev/m-advisor/pull/96)).
- Test isolation: every test process gets its own temporary data directory and `TMPDIR`, never inherits Discord or Riot credentials, and the next run removes folders an interrupted run left behind ([#102](https://github.com/ryangandev/m-advisor/pull/102), [#108](https://github.com/ryangandev/m-advisor/pull/108)).
- Commands: changes to the 马报 roles and channel run in the per-server queue, so two admins cannot interleave them, and their replies match what was saved ([#127](https://github.com/ryangandev/m-advisor/pull/127)).
- 马厩 and privacy: a confirmed `/stable-erase` also stops a game already in progress from writing rows afterwards, even when it erased nothing, and the privacy page states which games are still recorded after an erase, the retention of closed appeals and what logs contain ([#128](https://github.com/ryangandev/m-advisor/pull/128), [#134](https://github.com/ryangandev/m-advisor/pull/134)).
- 马报 counts: a match shared by several members counts once in the 总评 line ([#129](https://github.com/ryangandev/m-advisor/pull/129)).
- Rank text: `/profile` prints no division for 大师, 宗师 and 王者, and the 段位播报 voice keeps two members with the same game name distinct ([#126](https://github.com/ryangandev/m-advisor/pull/126), [#130](https://github.com/ryangandev/m-advisor/pull/130)).
- Voice playback: a brief voice reconnect pauses the announcement and resumes it within 5 seconds instead of aborting and replaying it, and audio never continues in a channel the bot was moved to ([#141](https://github.com/ryangandev/m-advisor/pull/141)).
- Shutdown: one Ctrl+C under `npm start` no longer kills the bot before cleanup (npm delivers the signal twice), `scripts/launch.command` runs Node directly, closing the window during a stop joins the running shutdown, and SQLite is never reopened after shutdown closed it ([#142](https://github.com/ryangandev/m-advisor/pull/142)).
- User site: the 段位播报 page says the voice speaks one sentence each for at most two members ([#136](https://github.com/ryangandev/m-advisor/pull/136)).
- Text edge cases: 烈娜塔·戈拉斯克's name is no longer split by the row separator, and the 马报 reads correctly for a one-game 特等马, a tie of three or more and a week with nobody qualified ([#146](https://github.com/ryangandev/m-advisor/pull/146)).
- Discord changes under the bot: a deleted channel or a removed server is an info line instead of an error in the late 段位变化 edit and the 段位播报, and the text-only fallback channel must allow embeds ([#151](https://github.com/ryangandev/m-advisor/pull/151)).
- 马报 roles: a current week's report that is given up, for example because its channel was deleted, still takes the roles from last week's holders, and the rotation runs in the per-server queue on freshly read settings, so roles switched off or changed during the send are respected ([#152](https://github.com/ryangandev/m-advisor/pull/152)).
- Riot errors in monitoring: a failed first read when a member joins voice no longer swallows the game they finish next, each kind of read failure is logged once until it recovers, and during an outage each poll makes one request per account instead of three ([#159](https://github.com/ryangandev/m-advisor/pull/159), [#162](https://github.com/ryangandev/m-advisor/pull/162)).
- Riot key: after login in real mode the bot checks `RIOT_API_KEY` with one request, and a 401 or 403 in `/profile`, `/bind` or `/recent` logs one line saying to paste a new key ([#160](https://github.com/ryangandev/m-advisor/pull/160)).
- Riot pacing: every Riot request goes through one pacer per host that keeps under the development key's limits, `/recent` waits behind a reserve kept for monitoring, and concurrent `/recent` commands share match details ([#161](https://github.com/ryangandev/m-advisor/pull/161)); a Riot cooldown or retry wait also ends at shutdown, and the docs state the na1 worst case correctly ([#166](https://github.com/ryangandev/m-advisor/pull/166)).
- `/why`: typing in the `match` option searches all of the member's games, not only the latest 25, and a match ID typed with a lower-case `na1_` is found ([#169](https://github.com/ryangandev/m-advisor/pull/169)).
- A sweep of the repo rules (mock labels, `allowedMentions`, enemies never named, deterministic phrases, no secrets in logs, live-script guards) found no violations.

Before #102, running `npm run check` in the main checkout opened Ryan's real `.data/bot.sqlite3` through the GuildDelete test and upgraded it from v5 to v7, writing `.data/bot.sqlite3.v5.bak`.
A read-only comparison of copies found every row unchanged: the tracked member, the `not ry#tan90` binding and the Old Man voice preference; `.data/logs` was not touched.

The schema stays at v7.
This round's evidence is compilation, mock tests and CI only; it adds no live Discord or real Riot acceptance, so B5 to B7 still cover it.
The shutdown and voice reconnect fixes are proven by tests only; a real Ctrl+C of the bot and a real voice reconnect have not been observed.
The Riot key check and request pacing have not run against real Riot.
Three questions wait for Ryan: the wording of the 推塔拿龙全程缺席 roast ([#125](https://github.com/ryangandev/m-advisor/issues/125)), whether a member disconnecting the bot mid-report should stop the replay ([#138](https://github.com/ryangandev/m-advisor/issues/138)), and whether a game that ended while the Riot key was expired should be announced after a restart ([#158](https://github.com/ryangandev/m-advisor/issues/158)).

## User-only blockers

| ID | Needed | Blocks |
| --- | --- | --- |
| B1 | Resolved: Ryan authorized Ry的四合院 / General on 2026-10-02 | No longer blocks live operations |
| B2 | Resolved: Ryan heard the real five-horse report in General on 2026-10-07 | No longer blocks acceptance |
| B3 | Resolved: a real game with Ryan's account bound in real mode was announced on 2026-10-07 | No longer blocks acceptance |
| B4 | Resolved: Mac unlocked and Discord UI testing resumed | No longer blocks live operations |
| B5 | Set `RIOT_MODE=mock`, start the bot, run `/simulate` 晋级（模拟） and 掉段（模拟） in General and listen, then switch back to `RIOT_MODE=real` (see the Live Discord test in [Acceptance](acceptance.md)) | Live acceptance of the feature round |
| B6 | Play about 10 real ranked games with the bot running | Tuning the LP edit and showing the LP change on demotion |
| B7 | Run `npm run probe:spectator -- "name#tag"` once on a loading screen and once in game, in real mode | Closing [#24](https://github.com/ryangandev/m-advisor/issues/24) |

Mock data allows implementation and voice integration to continue without B3.
Discord Portal or server-permission changes become a blocker only if the actual test demonstrates they are required and unavailable to the agent.

## Next

The approved engineering delivery, mock-to-real-Discord workflow and real Riot acceptance are complete.
The feature round and both audit rounds are merged and wait on B5 to B7.
The local bot is configured with `RIOT_MODE=real`, the 13 registered commands, Ryan's real `not ry#tan90` binding and the Old Man voice preference; it is started on demand.
For later on-demand use, run `npm start` or double-click `scripts/launch.command`; see [Runtime](runtime.md).
Run `/recent` once in the live channel to close the remaining diagnostics check.
Record each verified acceptance separately; never treat mock success as real Riot success.
