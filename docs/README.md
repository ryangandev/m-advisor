# Documentation routes

| Question | Read | Ownership |
| --- | --- | --- |
| How do I install, run, and validate the bot? | [Runtime](runtime.md) | Update with scripts and dependency changes |
| What is complete or waiting for Ryan? | [Status](status.md) | Update after verified milestones or acceptance |
| Where does each subsystem live? | [Architecture](architecture.md) | Update with module boundaries |
| How are bindings and voice preferences saved? | [Storage](storage.md) | Update with database and store behavior |
| What does the bot remember about each friend's horse tiers, and how does `/stable` read it? | [马厩](stable.md) | Update with the horse record table, profile math and commands that read it |
| How does `/why` explain a verdict with a radar image, and how does 上诉 work? | [/why 判决书](why.md) | Update with the verdict math, the radar image and the appeal flow |
| How are the daily and weekly 马报 scheduled, built and posted, and how do the weekly roles work? | [马报](ma-bao.md) | Update with report math, scheduling, catch-up, commands and role behavior |
| How do mock fixtures and real Riot requests work? | [Riot data](riot-data.md) | Update with provider, fixtures and request policy |
| How does local Qwen speech run? | [Local voice](local-voice.md) | Update with worker, providers and speech evidence |
| How are monitoring, retries and voice playback coordinated? | [Announcements](announcements.md) | Update with monitoring sessions and transport behavior |
| How are teammates ranked from 特等马 to 没有马, and how is the reference refreshed? | [Horse ranking](scoring.md) | Update with scoring features, weights, benchmarks and commentary rules |
| How do I verify the complete pipeline and finish live acceptance? | [Acceptance](acceptance.md) | Update with reproducible procedures and actual evidence |
| Where is the player-facing user site (`site/`), how do I run it locally with `npm --prefix site run dev`, and how does it deploy from `main`? | [User site](site.md) | Update with the site structure, config, content rules and deploy workflow |
| Which feature ideas are deferred for later? | [Backlog](backlog.md) | Update when an idea is added, started or dropped |

Subsystem implementation details belong in their routed document.
Git history records completed tasks; status records current evidence and remaining blockers.
