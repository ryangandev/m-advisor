# 策马军师 / M-Advisor

A locally hosted Discord bot that looks up League of Legends profiles and announces completed games in Chinese.
The default setup uses mock Riot data and the installed offline Qwen3-TTS model, so testing does not require Riot or cloud speech credentials.
Player-facing documentation, in Chinese, is at https://madvisor.rystudio.app.

| Command | Access | Behavior |
| --- | --- | --- |
| `/profile riotid` | Everyone | Show level, Solo/Duo and Flex statistics |
| `/bind user riotid` | Administrator | Track a member, or add or refresh one of their accounts; an account another member owns is refused |
| `/unbind user` | Administrator | Stop tracking that member and remove their accounts; other members stay monitored |
| `/bindings` | Administrator | Show every tracked member in bind order with their accounts, identifying simulated accounts |
| `/recent count user` | Everyone, private reply | Show each member's voice and monitoring state and their accounts' recent matches (default: the whole server) |
| `/stable user` | Everyone, public reply | Show a friend's 马厩 profile: tier counts and rates, average score, streaks, strongest and weakest dimension and recent games (default: you) |
| `/stable-erase user confirm` | Administrator, private reply | Erase one member's whole 马厩 history; without `confirm` it only counts the records |
| `/why user match` | Everyone, public reply | Explain a horse verdict with a radar image: the costliest dimensions for the position, the gap to the neighbouring tiers and what the 军师 said, with an 上诉 button only the member can press (default: your latest game) |
| `/report day` and `/report week` | Everyone, public reply | Show the 马报 of the day or week in progress (or the previous one with `when`): who was 特等马 and 没有马, the leaderboard and the best and worst game |
| `/report-settings` | Administrator, private reply | Choose the channel for the automatic daily and weekly 马报, switch each on or off and optionally manage the 本周特等马 and 本周没有马 roles |
| `/announcer [style] [pregame_voice]` | `style`: everyone; `pregame_voice`: Administrator | Choose Serena (`sweet`) or Uncle_Fu (`old`, the default); `pregame_voice` turns the voice line of the pre-game 锦囊 on or off (on by default, and the text card is posted either way); at least one option is required |
| `/testvoice` | Administrator, configured test server | Play a short announcement in the caller's voice channel |
| `/simulate outcome` | Administrator, configured test server, mock mode | Run a simulated win (`胜利`), loss (`失败`), 晋级 (`晋级（模拟）`) or 掉段 (`掉段（模拟）`) for the earliest-bound tracked member in the test channel through the match announcement pipeline, or start a simulated game (`开局（赛前锦囊）`) for the tracked members in that channel and post and speak the pre-game 锦囊; ending the game later with `胜利` or `失败` reuses the same match |

Bindings, voice preferences, each tracked member's 马厩 history and the 马报 settings persist in SQLite, and `/unbind` keeps the history.
Each server can track several Discord members, with at most 10 LoL accounts across them.
Real profiles currently use the North America region.
New monitoring sessions establish a baseline, so starting the bot does not replay old games.
When two or more tracked friends play a game on the same team, the report adds a 车队内战 ranking of just those friends and the voice names the 车队 best and the 背锅.

## Local setup

Use Node.js 24 or newer and the existing Apple Silicon Media speech installation.
See [Runtime](docs/runtime.md) for configuration, permissions, launch and shutdown.
See [Local voice](docs/local-voice.md) for the model paths and measured startup behavior.

```sh
npm ci
cp .env.example .env # Only when there is no existing .env
# Set DISCORD_TOKEN, CLIENT_ID and the authorized TEST_GUILD_ID in .env.
npm run check
npm run doctor
# Register commands in that authorized server once, or after command definitions change.
npm run register
npm start
```

On this Mac, `scripts/launch.command` also builds and starts the bot.
Wait for `Speech provider ready.` before the first voice test.
Stop with Ctrl+C to close the Discord client, speech worker and database.
Logs are also saved per day in `.data/logs/`; see [Runtime](docs/runtime.md#logs).

```sh
# Actual offline speech and Opus conversion with isolated mock data.
npm run verify:local
```

The verifier produces ignored evidence in `test-results/` and does not connect to Discord.
Use [Acceptance](docs/acceptance.md) for the live channel checklist and remaining user actions.
Current implementation and verified acceptance are recorded in [Status](docs/status.md).
The [documentation index](docs/README.md) routes subsystem details.

Speech recognition, open-ended conversation, LLM commentary and cloud hosting remain outside this delivery.
