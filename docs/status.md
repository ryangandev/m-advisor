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

## User-only blockers

| ID | Needed | Blocks |
| --- | --- | --- |
| B1 | Resolved: Ryan authorized Ry的四合院 / General on 2026-10-02 | No longer blocks live operations |
| B2 | Resolved: Ryan heard the real five-horse report in General on 2026-10-07 | No longer blocks acceptance |
| B3 | Resolved: a real game with Ryan's account bound in real mode was announced on 2026-10-07 | No longer blocks acceptance |
| B4 | Resolved: Mac unlocked and Discord UI testing resumed | No longer blocks live operations |

Mock data allows implementation and voice integration to continue without B3.
Discord Portal or server-permission changes become a blocker only if the actual test demonstrates they are required and unavailable to the agent.

## Next

The approved engineering delivery, mock-to-real-Discord workflow and real Riot acceptance are complete.
The local bot is configured with `RIOT_MODE=real`, the eight registered commands, Ryan's real `not ry#tan90` binding and the Old Man voice preference; it is started on demand.
For later on-demand use, run `npm start` or double-click `scripts/launch.command`; see [Runtime](runtime.md).
Run `/recent` once in the live channel to close the remaining diagnostics check.
Record each verified acceptance separately; never treat mock success as real Riot success.
