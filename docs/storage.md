# Local storage

The bot keeps server bindings and announcer voice preferences in a local SQLite database.
Restarting the bot preserves these settings.
The store API is synchronous, and importing the store modules alone does not create files or open a connection.

## Location

`DATABASE_PATH` selects the database file directly and takes precedence over `BOT_DATA_DIR`.
Without `DATABASE_PATH`, the file is `bot.sqlite3` inside `BOT_DATA_DIR`.
Without either setting, the location is `.data/bot.sqlite3` under the process working directory.
Relative paths resolve from the working directory, so launch the bot consistently from the repository or configure an absolute path.
Configure these variables before the first store operation; one connection is owned by each process until shutdown.
`:memory:` is also accepted as `DATABASE_PATH` for isolated tests, and its contents disappear when the connection closes.

New storage directories use mode `0700` and the database file uses mode `0600` on supported systems.
Existing parent directory permissions are preserved.
The database contains Discord member IDs and Riot account IDs, so keep it outside Git and shared folders.

## What survives restart

| Data | Owner | Persistence |
| --- | --- | --- |
| One tracked Discord member per guild | `src/store/bindingStore.ts` | SQLite |
| Ordered list of that member's Riot accounts | `src/store/bindingStore.ts` | SQLite |
| Announcer style, `sweet` or `old` | `src/store/announcerStore.ts` | SQLite |
| Polling timer | `src/store/announcerStore.ts` | Memory only |
| Current voice channel | `src/store/announcerStore.ts` | Memory only |
| Session match baseline | `src/store/announcerStore.ts` | Memory only |

An unconfigured guild uses the `sweet` voice.
Removing a binding removes its account rows while keeping the guild's chosen voice.
Each monitoring session establishes its own baseline, so old stored match IDs cannot trigger replay after restart.

`setBinding` replaces the member and account list in one transaction.
Duplicate PUUIDs within a guild are rejected and roll back the entire replacement.
Different guilds can bind the same Riot account independently.
The public command layer enforces the rule that changing the tracked member requires unbinding first.
Store reads return fresh values, so changing a returned object does not silently modify persisted settings.

`setVoiceStyle` persists its change before updating the runtime state.
`resetAnnouncerRuntime(guildId)` clears that guild's polling timer, voice channel, and match baseline while retaining its voice choice.
`listBindings()` returns saved bindings for startup reconciliation.

## Durability and shutdown

`src/store/database.ts` owns connection initialization, schema versioning, and `closeDatabase()`.
The schema uses foreign keys with cascading account deletion, WAL journaling, a five-second busy timeout, and full synchronous writes.
Call `closeDatabase()` during graceful shutdown after stopping monitors.
It closes only the SQLite connection; callers remain responsible for stopping their timers and voice processes.

A newer unsupported schema or a corrupt file produces an error.
The bot never silently replaces an existing database or falls back to an empty memory store.

For a backup, stop the bot cleanly, then copy the database file to a safe location.
If copying while the bot is running, include the `-wal` and `-shm` files or use SQLite's online backup API; copying just the main file can miss recent writes.
To restore, stop the bot and place the saved database at the configured path before restarting.

## Verification

`tests/store.test.ts` uses temporary databases and separate Node processes to verify real restart behavior.
It covers account ordering, guild isolation, atomic rollback, binding removal, voice preferences, runtime reset, filesystem permissions, configuration precedence, and visible failures for corrupt or unsupported database files.
The tests do not write to the bot's actual data directory.
