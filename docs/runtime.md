# Runtime

Use Node.js 22.12 or newer.
The current host uses Node 24.13.0.
Install the locked dependency graph with `npm ci`.

`npm run build` emits `dist/index.js`.
`npm start` runs that compiled entry point.
`npm run dev` runs TypeScript through tsx.
`npm test` runs deterministic node:test suites through tsx.
`npm run check` builds the bot and runs those suites.

Discord voice uses `@discordjs/voice` and `@snazzah/davey` for DAVE.
OpusScript provides the supported portable Opus encoder without the deprecated native Opus installer dependency chain.
Node's native AES-256-GCM supplies transport encryption on this Mac.
FFmpeg is installed through `ffmpeg-static` and must be verified as an executable, not merely as a package.
SQLite uses better-sqlite3.

Keep `.env`, `.data`, audio output and model weights outside source history.
Installing dependencies and compiling never proves that someone heard audio in Discord.
