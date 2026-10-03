# Documentation routes

| Question | Read | Ownership |
| --- | --- | --- |
| How do I install, run, and validate the bot? | [Runtime](runtime.md) | Update with scripts and dependency changes |
| What is complete or waiting for Ryan? | [Status](status.md) | Update after verified milestones or acceptance |
| Where does each subsystem live? | [Architecture](architecture.md) | Update with module boundaries |
| How are bindings and voice preferences saved? | [Storage](storage.md) | Update with database and store behavior |
| How do mock fixtures and real Riot requests work? | [Riot data](riot-data.md) | Update with provider, fixtures and request policy |
| How does local Qwen speech run? | [Local voice](local-voice.md) | Update with worker, providers and speech evidence |
| How are monitoring, retries and voice playback coordinated? | [Announcements](announcements.md) | Update with monitoring sessions and transport behavior |
| How are teammates ranked from 特等马 to 没有马, and how is the reference refreshed? | [Horse ranking](scoring.md) | Update with scoring features, weights, benchmarks and commentary rules |
| How do I verify the complete pipeline and finish live acceptance? | [Acceptance](acceptance.md) | Update with reproducible procedures and actual evidence |

Subsystem implementation details belong in their routed document.
Git history records completed tasks; status records current evidence and remaining blockers.
