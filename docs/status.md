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
The pre-implementation audit verified Discord credentials and the installed offline Qwen model.
The pre-implementation Riot credential check returned HTTP 401.
Live short voice playback and complete simulated-match Discord transport have passed; human listening remains pending.

## User-only blockers

| ID | Needed | Blocks |
| --- | --- | --- |
| B1 | Resolved: Ryan authorized Ry的四合院 / General on 2026-10-02 | No longer blocks live operations |
| B2 | Listen once inside that channel | Human audio acceptance only |
| B3 | Supply a valid Riot API key in local configuration | Real Riot acceptance only |
| B4 | Resolved: Mac unlocked and Discord UI testing resumed | No longer blocks live operations |

Mock data allows implementation and voice integration to continue without B3.
Discord Portal or server-permission changes become a blocker only if the actual test demonstrates they are required and unavailable to the agent.

## Next

The local bot is running with registered current commands.
Finish the remaining native [live acceptance procedure](acceptance.md), including restart persistence and cancellation.
Confirm audible playback for B2; finish real Riot acceptance only after B3 is supplied locally.
Record each verified acceptance separately; never treat mock success as real Riot success.
