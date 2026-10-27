# Local storage

The bot keeps each server's tracked members, their Riot accounts, the announcer voice preference and the 马厩 horse records in a local SQLite database.
Restarting the bot preserves these settings.
The store API is synchronous, and importing the store modules alone does not create files or open a connection.

## Location

`DATABASE_PATH` selects the database file directly and takes precedence over `BOT_DATA_DIR`.
Without `DATABASE_PATH`, the file is `bot.sqlite3` inside `BOT_DATA_DIR`.
Without either setting, the location is `.data/bot.sqlite3` under the process working directory.
`BOT_DATA_DIR` also holds the daily log files; see [Runtime](runtime.md#logs).
Relative paths resolve from the working directory, so launch the bot consistently from the repository or configure an absolute path.
Configure these variables before the first store operation; one connection is owned by each process until shutdown.
`:memory:` is also accepted as `DATABASE_PATH` for isolated tests, and its contents disappear when the connection closes.

New storage directories use mode `0700` and the database file uses mode `0600` on supported systems.
Existing parent directory permissions are preserved.
The database contains Discord member IDs and Riot account IDs, so keep it outside Git and shared folders.

## What survives restart

| Data | Owner | Persistence |
| --- | --- | --- |
| Tracked Discord members per guild, in bind order | `src/store/bindingStore.ts` | SQLite (`tracked_members`) |
| Ordered list of each member's Riot accounts | `src/store/bindingStore.ts` | SQLite (`member_accounts`) |
| Announcer style, `sweet` or `old` (default `old`) | `src/store/announcerStore.ts` | SQLite |
| One horse record per tracked member per announced match | `src/store/horseRecordStore.ts` | SQLite (`horse_records`) |
| Polling timer | `src/store/announcerStore.ts` | Memory only |
| Current voice channel | `src/store/announcerStore.ts` | Memory only |
| Session match baseline | `src/store/announcerStore.ts` | Memory only |

An unconfigured guild uses the `old` voice.
Removing a tracked member removes only that member's account rows, and the guild's chosen voice stays.
Each monitoring session establishes its own baseline, so old stored match IDs cannot trigger replay after restart.

A guild can track several members, each with an ordered list of Riot accounts.
`listTrackedMembers(guildId)` returns members in the order they were first bound, and `getTrackedMember(guildId, userId)` returns one.
`setMemberAccounts(guildId, userId, accounts)` adds the member if needed, placing them after everyone already tracked, and replaces their accounts in one transaction.
Re-saving an existing member keeps their place in the order.
At least one account is required.
A PUUID already owned by another member of the same guild throws `AccountBoundToOtherMemberError`, which carries the `puuid` and `ownerId`.
A guild may hold at most 10 Riot accounts in total across all its members, and going over throws `GuildAccountLimitError`.
Duplicate PUUIDs within one replacement are rejected too.
Every one of these failures rolls back the whole replacement, including a newly created member.
Different guilds can track the same Riot account independently.
`removeTrackedMember(guildId, userId)` removes that member and their accounts, returns whether anyone was removed, and leaves other members and the voice preference alone.
`findAccountOwner(guildId, puuid)` returns the owning member, and `listAllTracking()` returns every guild that has tracked members for startup reconciliation.
The public command layer still enforces one tracked member per server until the multi-member command changes land.
Store reads return fresh values, so changing a returned object does not silently modify persisted settings.

`setVoiceStyle` persists its change before updating the runtime state.
`resetAnnouncerRuntime(guildId)` clears that guild's polling timer, voice channel, and match baseline while retaining its voice choice.

## Schema versions and migration

`src/store/database.ts` holds an ordered `MIGRATIONS` list, and entry `i` upgrades a database from schema version `i` to `i + 1`.
Each step runs in its own transaction together with the `user_version` bump, so a failed step rolls back completely and leaves the file at the previous version with its data intact.
A fresh database runs every step in order.
A database from a newer bot is rejected with an error instead of being modified.
Shipped migrations are never edited; a new schema change appends a new entry.

| Version | Tables |
| --- | --- |
| 1 | `guild_bindings` (one member per guild), `bound_accounts`, `guild_preferences` |
| 2 | `tracked_members`, `member_accounts`, `guild_preferences` |
| 3 | The version 2 tables plus `horse_records` |

The 1 to 2 step copies each `guild_bindings` row into `tracked_members` at position 0 and each `bound_accounts` row into `member_accounts` with its account order, then drops the two old tables.
`guild_preferences` is unchanged, so the voice choice carries over.
The 2 to 3 step only creates `horse_records` and its indexes, so every existing row is untouched.
Migration happens in place, with no downgrade path, the first time any command opens an existing older database file.
That includes `npm start`, `npm run dev`, `npm run doctor` (which only opens a file that already exists) and the `verify:*` scripts.
`npm run register` does not open the database.
Each step takes the write lock before it checks the version, so two processes opening the same old file at the same moment apply each step once and both succeed.

Before the first step, a file whose version is between 1 and the current version is copied with `VACUUM INTO` to `<database path>.v<old version>.bak`, for example `.data/bot.sqlite3.v1.bak`.
The copy is consistent even when the bot left an uncheckpointed `-wal` file, it has mode `0600`, and it is made outside the migration transaction.
The bot never overwrites an existing backup: if that name is taken it uses `<database path>.v<old version>.2.bak`, then `.3.bak`, and so on.
A fresh database and `:memory:` are not backed up, and once the file is current, later opens create no backup.
The backup is not deleted automatically; remove it once the upgraded bot has run well.
An older bot cannot open the upgraded file, so to go back, stop the bot and restore the `.bak` file as `bot.sqlite3`.
Copying `bot.sqlite3` yourself before the first launch of the new version is optional extra safety.

## 马厩 (horse records)

`horse_records` holds one row per tracked member per announced match, keyed by (`guild_id`, `discord_user_id`, `match_id`).
[马厩](stable.md) describes what each column stores and why.
It deliberately has no foreign key to `tracked_members`, so removing a member never deletes their history.
`/unbind` keeps the history; only `eraseMemberHorseRecords(guildId, userId)`, behind the administrator command `/stable-erase`, deletes it.
Rebinding the same Discord member continues the same history, because the key is the Discord user and not the binding.

`recordHorseRecords(records)` validates every record, saves the batch in one transaction and returns how many were new.
An existing key is left unchanged, so recording a match twice never makes a second row.
`listHorseRecords(guildId, { mock, discordUserId?, from?, to?, order?, limit? })` returns records whose `played_at` lies in `[from, to)`, and the `mock` flag is required so that mock and real records are never returned together.
`listMatchHorseRecords`, `countMemberHorseRecords` and `eraseMemberHorseRecords` complete the API.
Only tracked members are stored: no teammate or enemy PUUID, name or champion appears in the table.

## Durability and shutdown

`src/store/database.ts` owns connection initialization, schema versioning, and `closeDatabase()`.
The schema uses foreign keys with cascading account deletion from tracked member to accounts, WAL journaling, a five-second busy timeout, and full synchronous writes.
Call `closeDatabase()` during graceful shutdown after stopping monitors.
It closes only the SQLite connection; callers remain responsible for stopping their timers and voice processes.

A newer unsupported schema or a corrupt file produces an error.
The bot never silently replaces an existing database or falls back to an empty memory store.

For a backup, stop the bot cleanly, then copy the database file to a safe location.
If copying while the bot is running, include the `-wal` and `-shm` files or use SQLite's online backup API; copying just the main file can miss recent writes.
To restore, stop the bot and place the saved database at the configured path before restarting.

## Verification

`tests/store.test.ts` uses temporary databases and separate Node processes to verify real restart behavior.
It covers member and account ordering, guild isolation, cross-member PUUID rejection, the 10-account cap, atomic rollback, member removal, voice preferences, runtime reset, filesystem permissions, configuration precedence, and visible failures for corrupt or unsupported database files.
`tests/horseRecordStore.test.ts` holds the version 2 to 3 migration tests: a literal version 2 file written by a separate process without a checkpoint, the `.v2.bak` backup, a failing step that rolls back to version 2, and the horse record API.
Migration tests build a literal version 1 file in WAL mode, written by a process that exits without closing so rows remain in an uncheckpointed `-wal` file, and upgrade it from a separate process.
They check that members, account order, voice styles and file mode survive and the old tables are gone.
They also check the automatic backup (present, mode `0600`, holding the version 1 data, never overwritten, not repeated), two processes opening the same old file concurrently, that a failing migration rolls back to version 1, and that reopening a current file changes nothing.
The tests do not write to the bot's actual data directory.
