# Runtime

Use Node.js 22.12 or newer.
The current host uses Node 24.13.0.
Install the locked dependency graph with `npm ci`.

`npm run build` emits `dist/index.js`.
`npm start` runs that compiled entry point.
`npm run dev` runs TypeScript through tsx.
`npm test` runs deterministic node:test suites through tsx.
`npm run typecheck` also type-checks the scripts and tests, which the build does not compile.
`npm run check` builds the bot, runs that type check and runs those suites.
`npm run doctor` checks the executable codec, SQLite, encryption and configuration without contacting Discord or loading the model.
It also counts the saved bindings and, in real mode, warns about each saved mock account that monitoring would skip; it never creates a missing database.
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
`RIOT_MODE=mock` is the default; speech always uses the local Qwen model.
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
In real mode, startup warns about each saved mock account; `/bind` with a real Riot ID removes them.

## Logs

The bot prints each message to the terminal with the local time.
It also appends them to one file per local day, `<BOT_DATA_DIR>/logs/bot-YYYY-MM-DD.log`, which is `.data/logs/` by default.
Each file line starts with the local date, time and UTC offset, followed by `INFO`, `WARN` or `ERROR`.
Node's own warnings and the stack trace of a crash are copied into the file as well, while Node still prints them to the terminal.
Daily files older than 14 days are deleted at startup and when a new day begins; other files in that directory are left alone.
Any message that quotes the Discord token or Riot key has it replaced with `[DISCORD_TOKEN]` or `[RIOT_API_KEY]`.
If the file cannot be written, the terminal shows one warning and still shows every message.
Only the bot entry point writes log files; tests, the doctor and the verifiers print to the terminal only.
Logs contain Riot IDs, Discord usernames and server names, so keep them local like the database.

The bot requests the standard Guilds and GuildVoiceStates intents.
Its current commands do not require privileged Presence or Server Members gateway intents.
The bot needs View Channel, Connect and Speak permissions in the voice channel.
Optional match messages in the voice channel chat also need Send Messages.
Invite the application with the `bot` and `applications.commands` scopes.
The avatar is `assets/m-advisor-avatar.png` (1024 x 1024), rendered from `assets/m-advisor-avatar.svg`.
The Bot page icon and the General Information app icon are separate settings; both use this image since 2026-10-04.
Either can be changed on the Developer Portal or with the bot token through `PATCH /users/@me` (`avatar`) and `PATCH /applications/@me` (`icon`).
Discord rate-limits avatar changes, and clients may show the old image until they refresh.

## Native dependencies

Discord voice uses `@discordjs/voice` and `@snazzah/davey` for DAVE.
OpusScript provides the supported portable Opus encoder without the deprecated native Opus installer dependency chain.
Node's native AES-256-GCM supplies transport encryption on this Mac.
FFmpeg is installed through `ffmpeg-static` and must be verified as an executable, not merely as a package.
SQLite uses better-sqlite3.

Keep `.env`, `.data`, audio output and model weights outside source history.
Installing dependencies and compiling never proves that someone heard audio in Discord.
