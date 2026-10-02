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
Command/lifecycle integration passed the complete 139-test suite and compilation.
An independent temporary checkout without credentials or user data passed `npm ci` and the current 139 tests with no failures, skips or warnings.
That clean installation also reported zero npm audit vulnerabilities.
The actual Discord Gateway login, local speech prewarm and SIGTERM shutdown also passed with an isolated empty database and exit code 0.
That Gateway check did not register commands, join voice or send messages.
The read-only Discord preflight confirmed that the proposed General channel is accessible and that the bot has View Channel, Connect, Speak and Send Messages permissions there.
The server currently has no guild-scoped command registrations; the application retains older global definitions, including retired `/testvc`.
The current handler acknowledges retired and unknown commands privately instead of allowing a timeout; seven regression tests cover this path and safe error replies.
Current registration and actual voice playback still await B1.
The pre-implementation audit verified Discord credentials and the installed offline Qwen model.
The pre-implementation Riot credential check returned HTTP 401.
Live Discord playback and human listening have not passed.

## User-only blockers

| ID | Needed | Blocks |
| --- | --- | --- |
| B1 | Confirm the test Discord server and voice channel | Live channel operations only |
| B2 | Listen once inside that channel | Human audio acceptance only |
| B3 | Supply a valid Riot API key in local configuration | Real Riot acceptance only |

Mock data allows implementation and voice integration to continue without B3.
Discord Portal or server-permission changes become a blocker only if the actual test demonstrates they are required and unavailable to the agent.

## Next

All independent implementation and automated acceptance work is complete.
Confirm B1, register commands in that server and run the [live acceptance procedure](acceptance.md).
Confirm audible playback for B2; finish real Riot acceptance only after B3 is supplied locally.
Record each verified acceptance separately; never treat mock success as real Riot success.
