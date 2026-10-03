# Runtime

Use Node.js 22.12 or newer.
The current host uses Node 24.13.0.
Install the locked dependency graph with `npm ci`.

`npm run build` emits `dist/index.js`.
`npm start` runs that compiled entry point.
`npm run dev` runs TypeScript through tsx.
`npm test` runs deterministic node:test suites through tsx.
`npm run check` builds the bot and runs those suites.
`npm run doctor` checks the executable codec, SQLite, encryption and configuration without contacting Discord or loading the model.
`npm run doctor -- --voice` also prewarms the selected speech provider and closes it afterward.
`npm run register` explicitly replaces this application's guild command definitions in `TEST_GUILD_ID`.
`npm run verify:local` exercises isolated mock match monitoring with real local speech and Opus conversion; see [Acceptance](acceptance.md).
`npm run verify:discord -- --confirm-live` exercises actual Discord voice and report messages with an isolated mock binding; stop the normal bot first and use only an authorized target.
`npm run benchmarks:sample`, `npm run benchmarks:build` and `npm run champions:update` refresh the ranking reference data; see [Horse ranking](scoring.md).
Bot startup never registers commands automatically.

## Configuration and launch

Preserve an existing `.env`.
For a new installation, copy `.env.example` and set `DISCORD_TOKEN` and `CLIENT_ID` locally.
Do not commit credentials or put them in chat.
`RIOT_MODE=mock` and `TTS_PROVIDER=local` are the defaults.
Real Riot mode requires `RIOT_API_KEY`; see [Riot data](riot-data.md).
The installed speech paths and provider settings are described in [Local voice](local-voice.md).

Set `TEST_GUILD_ID` to the authorized server before registering or running test commands.
Set `TEST_VOICE_CHANNEL_ID` to restrict tests and mock announcements to a particular voice channel.
Changing command definitions requires running `npm run build` and `npm run register` again.
Guild registration replaces this application's existing commands in that server; commands in other servers are untouched.
Existing global command definitions are not removed by guild registration.
If an older installation exposes duplicate command choices, use the explicit migration:

```sh
npm run register -- --migrate-legacy-globals
```

Migration verifies that the bot belongs only to the authorized server and that all replacement guild commands are registered before retiring known legacy global slash commands.
It preserves unrelated commands and context-menu commands.
For a bot in multiple servers, migration refuses global changes so an administrator can plan a wider rollout separately.
Repeating migration after completion is a no-op for globals.
Reload the Discord client after migration if its command picker still caches removed definitions.
If a cached retired `/testvc` remains visible, the handler replies privately with migration guidance and never starts a second voice-test control.

```sh
npm ci
npm run check
npm run doctor
npm run register
npm start
```

Alternatively, double-click `scripts/launch.command` on this Mac.
The launcher enters the repository, locates Node through PATH or an existing nvm installation, builds and starts the bot.
Wait for `Speech provider ready.` before testing audio.
Ctrl+C or SIGTERM stops monitoring and closes voice connections, the Discord client, the speech worker and SQLite.
Starting again restores saved bindings and checks whether the tracked members are already in voice.

The bot requests the standard Guilds and GuildVoiceStates intents.
Its current commands do not require privileged Presence or Server Members gateway intents.
The bot needs View Channel, Connect and Speak permissions in the voice channel.
Optional match messages in the voice channel chat also need Send Messages.
Invite the application with the `bot` and `applications.commands` scopes.

## Native dependencies

Discord voice uses `@discordjs/voice` and `@snazzah/davey` for DAVE.
OpusScript provides the supported portable Opus encoder without the deprecated native Opus installer dependency chain.
Node's native AES-256-GCM supplies transport encryption on this Mac.
FFmpeg is installed through `ffmpeg-static` and must be verified as an executable, not merely as a package.
SQLite uses better-sqlite3.

Keep `.env`, `.data`, audio output and model weights outside source history.
Installing dependencies and compiling never proves that someone heard audio in Discord.
