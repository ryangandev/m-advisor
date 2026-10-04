# 策马军师 / M-Advisor

A locally hosted Discord bot that looks up League of Legends profiles and announces completed games in Chinese.
The default setup uses mock Riot data and the installed offline Qwen3-TTS model, so testing does not require Riot or cloud speech credentials.

| Command | Access | Behavior |
| --- | --- | --- |
| `/profile riotid` | Everyone | Show level, Solo/Duo and Flex statistics |
| `/bind user riotid` | Administrator | Add or refresh an account for the server's tracked member |
| `/unbind user` | Administrator | Remove that member's accounts and stop monitoring |
| `/bindings` | Administrator | Show saved accounts and identify simulated accounts |
| `/recent count` | Everyone, private reply | Show the bound accounts' recent matches and whether monitoring will announce them |
| `/announcer style` | Everyone | Choose Serena (`sweet`) or Uncle_Fu (`old`, the default) |
| `/testvoice` | Administrator, configured test server | Play a short announcement in the caller's voice channel |
| `/simulate outcome` | Administrator, configured test server, mock mode | Run a simulated win or loss through the match announcement pipeline |

Bindings and voice preferences persist in SQLite.
Each server tracks one Discord member with multiple LoL accounts.
Real profiles currently use the North America region.
New monitoring sessions establish a baseline, so starting the bot does not replay old games.

## Local setup

Use Node.js 22.12 or newer and the existing Apple Silicon Media speech installation.
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

```sh
# Actual offline speech and Opus conversion with isolated mock data.
npm run verify:local
```

The verifier produces ignored evidence in `test-results/` and does not connect to Discord.
Use [Acceptance](docs/acceptance.md) for the live channel checklist and remaining user actions.
Current implementation and verified acceptance are recorded in [Status](docs/status.md).
The [documentation index](docs/README.md) routes subsystem details.

Speech recognition, open-ended conversation, LLM commentary and cloud hosting remain outside this delivery.
Azure speech is available only when explicitly configured as an alternative provider.
