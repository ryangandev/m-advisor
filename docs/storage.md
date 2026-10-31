# Local storage

The bot keeps each server's tracked members, their Riot accounts, the announcer voice preference, the 马厩 horse records and the stored LP results in a local SQLite database.
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
| Closed `/why` appeal cases | `src/store/appealStore.ts` | SQLite (`appeal_cases`) |
| Final LP result per tracked member per ranked match | `src/store/rankStore.ts` | SQLite (`rank_results`) |
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
`/bind` adds members through `setMemberAccounts` and `/unbind` removes one through `removeTrackedMember`; both then reconcile monitoring.
Store reads return fresh values, so changing a returned object does not silently modify persisted settings.

`setVoiceStyle` persists its change before updating the runtime state.
`resetAnnouncerRuntime(guildId)` clears that guild's polling timer and match baselines while retaining its voice choice.
`clearLastMatchIds(guildId, puuids)` forgets only the named accounts' baselines, for a member who leaves voice or is unbound while others stay monitored.

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
| 4 | The version 3 tables plus `report_settings` and `report_marks` |
| 5 | The version 4 tables plus `pregame_settings` |
| 6 | The version 5 tables plus `appeal_cases` |
| 7 | The version 6 tables plus `rank_results` |

The 1 to 2 step copies each `guild_bindings` row into `tracked_members` at position 0 and each `bound_accounts` row into `member_accounts` with its account order, then drops the two old tables.
`guild_preferences` is unchanged, so the voice choice carries over.
The 2 to 3 step only creates `horse_records` and its indexes, so every existing row is untouched.
The 3 to 4 step only creates `report_settings` and `report_marks`, so every existing row is untouched.
The 4 to 5 step only creates `pregame_settings`, so every existing row is untouched.
The 5 to 6 step only creates `appeal_cases` and its index, so every existing row is untouched.
The 6 to 7 step only creates `rank_results` and its index, so every existing row is untouched.
Migration happens in place, with no downgrade path, the first time any command opens an existing older database file.
That includes `npm start`, `npm run dev` and `npm run doctor` (which only opens a file that already exists).
`npm run register` does not open the database.
The `verify:*` scripts set `DATABASE_PATH` to their own fresh temporary database, so they never open, migrate or back up the bot's real file.
Each step takes the write lock before it checks the version, so two processes opening the same old file at the same moment apply each step once and both succeed.

Before the first step, a file whose version is between 1 and the current version is copied with `VACUUM INTO` to `<database path>.v<old version>.bak`, for example `.data/bot.sqlite3.v1.bak`.
The copy is consistent even when the bot left an uncheckpointed `-wal` file, it has mode `0600`, and it is made outside the migration transaction.
The bot never overwrites an existing backup: if that name is taken it uses `<database path>.v<old version>.2.bak`, then `.3.bak`, and so on.
A fresh database and `:memory:` are not backed up, and once the file is current, later opens create no backup.
The backup is not deleted automatically; remove it once the upgraded bot has run well.
It is a full copy taken before the upgrade, so it still holds anything `/stable-erase` removes later; see [what an erase does not reach](#what-an-erase-does-not-reach).
An older bot cannot open the upgraded file, so to go back, stop the bot and restore the `.bak` file as `bot.sqlite3`.
Copying `bot.sqlite3` yourself before the first launch of the new version is optional extra safety.

## 马厩 (horse records)

`horse_records` holds one row per tracked member per announced match, keyed by (`guild_id`, `discord_user_id`, `match_id`, `mock`).
[马厩](stable.md) describes what each column stores and why.
It deliberately has no foreign key to `tracked_members`, so removing a member never deletes their history.
`/unbind` keeps the history; only `eraseMemberHorseRecords(guildId, userId)`, behind the administrator command `/stable-erase`, deletes it.
Rebinding the same Discord member continues the same history, because the key is the Discord user and not the binding.
An erase leaves the member bound, so the database cannot tell a late write for a match reported before the erase from a new one.
`eraseMemberHorseRecords` therefore also remembers the erase time per server and member in memory (`src/store/eraseCutoff.ts`), and nothing is added to the schema.
The monitor's late LP write and its 马厩 write after the voice skip a member erased at or after the moment the match was detected, and still record a match detected later.
The cutoff compares the monitor's own detection time with the erase time, both from the same clock, and not Riot's match end time.
A restart drops the cutoffs, which is safe because it also drops every pending late write.

`recordHorseRecords(records)` validates every record, saves the batch in one transaction and returns how many were new.
Inside that transaction it also checks that each (server, member, account) is currently in `member_accounts`, and otherwise throws `UntrackedMemberError` and saves nothing.
An existing key is left unchanged, so recording a match twice never makes a second row.
`listHorseRecords(guildId, { mock, discordUserId?, from?, to?, order?, limit? })` returns records whose `played_at` lies in `[from, to)`, and the `mock` flag is required so that mock and real records are never returned together.
`listMatchHorseRecords`, `countMemberHorseRecords` and `eraseMemberHorseRecords` complete the API.
Only tracked members are stored: no teammate or enemy PUUID, name or champion appears in the table.

## Appeal cases

`appeal_cases` holds one row per closed `/why` 上诉 case, keyed by (`guild_id`, `discord_user_id`, `match_id`, `mock`) with a `closed_at` time in Unix milliseconds, so one member appeals one match once even across restarts (see [/why](why.md#上诉)).
Mock and real cases are separate keys.
It has no foreign key, like `horse_records`, so `/unbind` keeps the cases.
`src/store/appealStore.ts` owns it: `closeAppeal` inserts the case and returns whether it was new, `isAppealClosed` reads it, and `reopenAppeal` deletes it when the ruling could not be sent.
The table is bounded by age: every `closeAppeal` deletes the cases closed more than a year ago (`APPEAL_RETENTION_MS`) in the same transaction, and `isAppealClosed` already ignores them.
`eraseMemberHorseRecords` deletes the member's cases in the same transaction as their records, so `/stable-erase` leaves nothing behind in the database.
No Riot name, champion or score is stored in it.

## LP results

`rank_results` holds one row per tracked member per ranked match (solo/duo or flex) whose 段位变化 row reached a final state, keyed by (`guild_id`, `discord_user_id`, `match_id`, `mock`).
LP history cannot be backfilled from Riot later, which is why the rows are stored now even though nothing reads them yet; a weekly LP line in the 马报 is planned once a few weeks of rows exist.
Mock and real rows are separate keys, so the same match number can have both.
It has no foreign key, like `horse_records`, so `/unbind` keeps the rows.
The table is STRICT and has two indexes: (`guild_id`, `discord_user_id`, `mock`, `played_at`) for one member's history and (`guild_id`, `mock`, `played_at`) for a server-wide period, such as the planned weekly 马报 line.

| Column | Meaning |
| --- | --- |
| `queue_type` | `solo` (queue 420) or `flex` (queue 440) |
| `played_at`, `recorded_at` | Unix milliseconds: the game's end (the record time when Riot gave none) and when the row was written |
| `kind` | `change`, `promoted`, `demoted`, `placed` or `unattributable`, as in [段位变化](announcements.md#段位变化) |
| `tier`, `division`, `league_points` | The rank after the game, as Riot's strings (`GOLD`, `II`); `division` is NULL for MASTER and above |
| `lp_delta` | The ladder distance of the game; NULL for `demoted`, `placed` and `unattributable` |
| `before_tier`, `before_division`, `before_league_points` | The rank before the game, whenever it is known; NULL for `placed` and `unattributable` |

A demotion stores its ranks but no `lp_delta`, the same as its row shows, because the ladder distance is not the LP Riot actually takes until a real demotion has been measured.
A pending, stale or unavailable row, a row that was left out, and a remake or any other queue are never stored.
Table checks pin these rules: a change or promotion needs a delta and a before-value, a demotion needs a before-value, a placement has neither a delta nor a before-value, and an unattributable change has no delta.

`src/store/rankStore.ts` owns the table: `recordRankResults(results)` validates the batch and saves it in one transaction, and `listRankResults(guildId, { mock, discordUserId?, order?, limit? })` requires the `mock` flag so mock and real rows are never returned together.
`recordRankResults` skips only a key that already exists (`ON CONFLICT DO NOTHING`), so a row that settles twice is stored once and the first row is never changed, while a row that breaks the table's checks throws instead of vanishing.
`eraseMemberHorseRecords` deletes the member's rank results in the same transaction as their records and appeal cases, so `/stable-erase` leaves nothing behind in the database.
The monitor writes the rows, as described under [Stored results](announcements.md#stored-results).
No Riot name, champion or account name is stored in it, only the member and the account's PUUID.

## 马报 (report settings)

`report_settings` holds one row per server that was ever configured: the report channel, the daily, weekly and roles switches, the two role ids and the members the bot itself gave each role.
`report_marks` holds, per server, data mode (`mock`) and kind (`day` or `week`), the start of the latest period that was posted or deliberately skipped, so a period is never posted twice.
A mark only moves forward, and mock and real marks are separate.
`src/store/reportStore.ts` owns both tables, and [马报](ma-bao.md) describes how they are used.
Neither table has a foreign key, so `/unbind` and `/stable-erase` never touch them.

## Pre-game voice switch

`pregame_settings` holds one row per server that ever changed the switch: `voice_enabled` is 1 (speak the pre-game line) or 0 (text only).
A server without a row has the switch on.
It is a separate table because `guild_preferences.voice_style` is `NOT NULL`, so a row there could not exist without a style.
`getPregameVoiceEnabled(guildId)` and `setPregameVoiceEnabled(guildId, enabled)` in `src/store/announcerStore.ts` read and write it, and `/announcer pregame_voice` sets it (Administrator only; `style` stays open to everyone).
`saveAnnouncerSettings` writes the style and the switch in one transaction and updates the in-memory style only after it commits.
The game start watcher reads it for every 锦囊 (see [Announcements](announcements.md#text-and-voice)): the text card is always posted, and the voice line is queued only while the switch is on.

## What an erase does not reach

`/stable-erase` scrubs the live database file and its WAL, and nothing else.
The WAL step never waits for another process: if another process is reading the database at that moment, the WAL is left alone with a warning in the log, and `closeDatabase()` truncates it once more when the bot shuts down.
Two other kinds of copy stay until the host deletes them by hand:

- Backups made before a schema upgrade (`bot.sqlite3.v<N>.bak`) are full copies from that moment.
  The bot never deletes them, so a member erased later is still readable in any backup made while their rows existed.
  Delete the backups you no longer need, and all of them when an erase has to be complete.
- Log files under `BOT_DATA_DIR/logs` can name Riot accounts and Discord members, for example in monitoring and report lines.
  Files older than 14 days are deleted when the bot starts and when it runs into a new day.
  Delete newer files by hand if an erase has to reach them.

The `/stable-erase` reply says this in one sentence, and the site's privacy page (`site/src/content/docs/privacy.md`) says it to players.

Removing the bot from a server deletes nothing either.
Every row for that server stays, the log records the removal once and that server's monitoring session is stopped (`src/events/guildDelete.ts`).
With the bot gone, `/stable-erase` can no longer be run for that server, so the host deletes the rows on request.
To do it by hand, stop the bot and open the database with the `sqlite3` shell.
Run `PRAGMA secure_delete = ON;` first so the deleted content is overwritten (or run `VACUUM;` afterwards), then delete the server's rows from every table that holds its `guild_id`:

- `tracked_members` and `member_accounts`
- `guild_preferences` and `pregame_settings`
- `horse_records`, `appeal_cases` and `rank_results`
- `report_settings` and `report_marks`

Finish with `PRAGMA wal_checkpoint(TRUNCATE);`.
Then delete the `bot.sqlite3.v<N>.bak` backups too, because they still hold the server's rows, and delete any log files that mention the server.

## Durability and shutdown

`src/store/database.ts` owns connection initialization, schema versioning, and `closeDatabase()`.
The schema uses foreign keys with cascading account deletion from tracked member to accounts, WAL journaling, a five-second busy timeout, and full synchronous writes.
Every connection also turns on `secure_delete`, so deleted content is overwritten with zeros instead of staying readable in free pages.
After the erase transaction, `eraseMemberHorseRecords` runs `wal_checkpoint(TRUNCATE)`, so the old page images do not linger in the `-wal` file either.
The checkpoint runs with `busy_timeout = 0` (restored afterwards), because the store is synchronous and waiting on another process would stall the event loop past Discord's three second reply window.
The erase is already committed by then, so a checkpoint that cannot finish (another process has the database open for reading) logs a warning and does not fail the command.
`closeDatabase()` runs the same truncating checkpoint once more before closing.
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
`tests/pregameSettings.test.ts` holds the version 4 to 5 migration tests (a literal version 4 file, the `.v4.bak` backup, a failing step that rolls back to version 4, newer-schema rejection) and the pre-game voice switch API.
`tests/rankStore.test.ts` holds the version 6 to 7 migration tests (a literal version 6 file upgraded by a separate process, the `.v6.bak` backup, a failing step that rolls back to version 6, newer-schema rejection), the LP result API, the table checks and the erase scope.
`tests/monitor.test.ts` pins when the monitor writes the rows.
`tests/appealStore.test.ts` holds the version 5 to 6 migration tests (a literal version 5 file upgraded by a separate process, the `.v5.bak` backup, a failing step that rolls back to version 5) and the appeal case API, including survival across processes, pruning and erasing.
`tests/store.test.ts` also stores marker match IDs as horse records, LP results and appeal cases, erases them, and checks that the marker is gone from the database file and the WAL and that the WAL is empty.
Further tests cover rows already checkpointed into the main file, and with a second connection holding a read transaction, where the erase must return in well under a second and still commit.
`tests/guildDelete.test.ts` pins the removal log line and the monitoring stop.
The tests do not write to the bot's actual data directory.
