# 策马军师 / M-Advisor requirements

The approved delivery is a local bot Ryan launches when playing with friends.
It must support the existing profile, account binding, voice selection and game-end announcement features, plus reproducible test commands.
Implementation details and verification evidence belong in the routed [documentation](docs/README.md).

## Profiles and bindings

- `/profile` accepts `GameName#TAG` and displays summoner level, profile icon and both ranked queues in a Discord embed.
- Real Riot requests use the North America platform and Americas account/match routing.
- Each server tracks one Discord member with multiple LoL accounts.
- Administrators manage and inspect bindings through `/bind`, `/unbind` and `/bindings`.
- Binding another account adds it; binding the same identity refreshes it without duplicates.
- Removing a binding removes all its accounts and stops that server's monitoring.
- Bindings and the chosen announcer voice survive bot restarts in local SQLite storage.
- Simulated accounts and results are visibly identified, including after switching to real mode.

## Match announcements

- Monitoring begins when the tracked member is in a voice channel, including when binding or restarting the bot while they are already there.
- It stops when that member leaves voice or the binding is removed.
- A new monitoring session establishes the latest completed match as its baseline without announcing historical games.
- Polls run approximately every 45 seconds while the member remains in voice.
- Supported Summoner's Rift queues are listed in [Riot data](docs/riot-data.md).
- The result is the tracked account's win or loss.
- Commentary ranks the tracked player's five teammates as 特等马, 上等马, 中等马, 下等马 and 没有马; enemies are not scored.
- Ranking must not follow KDA alone: it compares each player with the same position across damage, teamfight, survival, economy, frontline, vision, objectives, utility and lane matchup, so supports and tanks are judged fairly.
- After reading the ranking, the bot praises the 特等马 extravagantly and roasts the 没有马 in an abstract, in-game style.
- Remakes, aborted games without a winner and games shorter than 10 minutes are not ranked.
- The bot generates speech, joins the current permitted voice channel, finishes playback and leaves.
- A failed announcement remains eligible for a later retry; successful playback prevents duplicate speech.
- Overlapping polls and manual announcements must not create competing voice connections.
- Optional chat mentions apply only to known bound participants present in the same channel.
- Startup, channel changes and shutdown must cancel stale work and release speech, audio and database resources.

## Local voice and test modes

- Local Qwen3-TTS is the default speech provider and uses the installed model without downloading weights or modifying the Media environment.
- `/announcer` selects the Chinese Serena or Uncle_Fu voice and saves the preference per server.
- The worker stays loaded for reuse and serializes speech requests through a bounded queue.
- Mock Riot data is the default development mode and never appears as actual match history.
- Real Riot failures must report their cause without silently substituting mock data.
- Azure is an explicit optional provider and never a fallback for local speech errors.
- `/testvoice` and `/simulate` require administrator permissions and a configured test server.
- A configured test voice channel must be respected before, during and after speech generation.
- `/simulate` is available only in mock mode and exercises the shared match-to-voice pipeline.
- Guild command registration is an explicit operation against the authorized server.
- Automated offline checks must distinguish real speech/codec execution from simulated Discord transport.

## Acceptance and boundaries

Compilation, automated checks, actual local inference and live Discord acceptance are recorded separately.
A valid Riot API key is required only for real Riot acceptance.
Server/channel confirmation and a listener are required only for the corresponding live acceptance steps.
Permission changes become user blockers only when a live check shows they are necessary and unavailable to the agent.
Speech recognition, LLM APIs, free conversation, cloud deployment and multi-region support are later work.
Each server tracks one member: when that member is in voice, the bot watches their account for a new game and ranks their whole team, so friends on the same team are covered without separate bindings.
