# Current status

## Approved delivery

Restore the runtime, implement explicit mock/real Riot modes, persist settings, repair monitoring, integrate local Qwen and add restricted voice/simulation test commands.
Each independently verified task is committed and pushed separately on `codex/local-qwen-e2e`.

## Acceptance

Runtime restoration passed compilation, executable FFmpeg conversion, Opus frame round-trip, native encryption and DAVE loading checks.
The updated dependency graph reports zero npm audit vulnerabilities.
SQLite persistence passed 12 tests, including separate-process restart, transaction rollback and guild isolation.
Mock flow, local TTS and command integration are in progress.
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

Complete independent implementation and automated validation before requesting manual acceptance.
Record each verified acceptance separately; never treat mock success as real Riot success.
