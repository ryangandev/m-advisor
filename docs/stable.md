# 马厩 (horse records)

Every announced game leaves a permanent record of each tracked friend's horse tier.
The records answer long-term questions such as how often someone was 特等马 or 没有马, and which dimension is their strongest and weakest.
`/stable [user]` shows one member's profile, and the weekly reports, `/why` and the in-party ranking read the same records.
The ranking itself is described in [Horse ranking](scoring.md), the table in [Storage](storage.md#马厩-horse-records), and `/why` in [/why 判决书](why.md).

## What is recorded

`src/services/horseRecords.ts` turns a match and the tracked members' accounts into records with `buildHorseRecords`.
It is pure, so it can be called without a database.
It ranks the team of each tracked member with the same `rankTeam` and benchmarks the announcement used, and keeps only the tracked members' rows.
Teammates and enemies are ranked to place the members and are then dropped: no PUUID, Riot name or champion of anyone else is stored.

Pass the spoken announcement as `announcement: { announcement, perspectivePuuid, events }` to keep the commentary.
The announcement praises the best horse and roasts the worst of the perspective's team only, so only those members get a line, and a member on the other team gets none.
The stored line names only the member it is about, because the praise and the roast name only their own horse.

A tracked member who plays on the other team from the announcement's point of view is still a friend, so they are recorded from their own team's ranking.
A member appears at most once per match, through the first of their accounts in the input.
Remakes, games stopped without a result and games shorter than 10 minutes are not judged by the announcement, so they leave no record.

| Field | Why it is stored |
| --- | --- |
| `guild_id`, `discord_user_id`, `match_id`, `mock` | The key. One record per member per match per server, and a mock and a real record of the same match ID can never collide. |
| `puuid` | Which of the member's accounts played. |
| `mock` | Mock-fixture games are kept apart from real ones. |
| `team_id` | Riot's team (100 or 200). Friends on opposite teams were ranked against their own teammates, so the in-party ranking compares only records with the same `team_id`. |
| `game_version` | Riot's game version string when the match data has one, otherwise empty, so scores can be grouped by patch. |
| `played_at`, `recorded_at` | Game end in Unix milliseconds (recording time when Riot omits it) for range queries, and when the record was made. |
| `queue_id`, `duration_seconds`, `won` | Context for reports. |
| `position`, `champion_id`, `champion_name`, `kills`, `deaths`, `assists` | The line shown in recent games, and which position's weights apply to the dimensions. |
| `tier`, `team_rank`, `team_size` | The verdict. |
| `score`, `composite` | The 0-10 score, and the combined value that breaks ties. |
| `score_above`, `score_below` | The scores of the teammates ranked one place higher and lower, as anonymous numbers. `/why` uses them for the gap to the neighbouring tiers. |
| `dimensions` | Percentile against the same position for each dimension the match had data for (JSON). |
| `features` | The normalized statistics behind the dimensions, such as kill participation (JSON). |
| `benchmark_version`, `benchmark_collected_at` | Which reference sample scored the record, because scores from different samples do not compare exactly. |
| `commentary_tone`, `commentary`, `moment_kind` | The praise or roast the 军师 spoke about this member, and the kind of timeline moment it cited (a `MatchEvent` kind). Empty when the announcement said nothing about them, so `/why` can quote what was said. |

## Recording a match

The monitor records a match once its announcement has been played:

```ts
import { buildHorseRecords } from "./horseRecords";
import { recordHorseRecords } from "../store/horseRecordStore";

recordHorseRecords(buildHorseRecords({
  guildId,
  detail,
  tracked: listTrackedMembers(guildId).flatMap((member) =>
    member.accounts.map((account) => ({ discordUserId: member.discordUserId, puuid: account.puuid }))),
  mock: this.dependencies.mock(),
  announcement: { announcement, perspectivePuuid: account.puuid, events },
}));
```

`recordHorseRecords` saves the whole batch in one transaction and returns how many records were new.
A record for a (server, member, match) that already exists is left exactly as it was, so recording a match twice, or after a retry, never makes a second entry.
`recordHorseRecords` refuses a record whose (server, member, account) is not in `member_accounts` at that moment, inside the same transaction, and throws `UntrackedMemberError` with nothing saved, so only bound members can ever be stored.
Build the list from the current tracked members just before recording, so a member unbound during playback is simply absent.
A failed write should be logged and must not undo or repeat the announcement.
Pass the same `benchmarks` to `buildHorseRecords` as to `buildMatchAnnouncement` when the announcement does not use the default reference.

## Mock and real data

Every record carries a `mock` flag, and every query must say which kind it wants.
`/stable` shows the kind that matches the bot's data mode, and says so when the other kind holds games that are not counted.
Mock profiles carry the 模拟数据 title and footer.
`summarizeHorseRecords` refuses a list that mixes both kinds.

## Unbinding and erasing

History does not belong to the binding.
`/unbind` removes the member's accounts and stops monitoring, and keeps the history, because it is the group's history.
`horse_records` has no foreign key to `tracked_members`, so nothing cascades.
Binding the same member again continues the same history, and `/stable` still shows an unbound member, with a note that no new games are recorded.

An administrator erases one member's whole history, real and mock, with `/stable-erase user confirm:true`, which Discord hides from non-administrators by default and also checks in the handler.
Without `confirm:true` the command only counts the records and erases nothing.
The reply is private and the erase is not reversible, so restore the migration backup if one is needed.
Nothing erases history automatically.

## The profile

`getMemberHorseProfile(guildId, userId, mock)` reads one member's records and `summarizeHorseRecords` computes:

- games, wins, the count and share of each tier, and the average score;
- the current and the longest run of 特等马 and of 没有马;
- the latest 10 results, newest first, and the latest 5 games;
- the average percentile of each dimension, counting a game only when the position's weight for that dimension is at least 0.08, as the ranking does for strengths;
- the strongest and weakest dimension, named only when each has at least 3 games and at least two dimensions qualify.

The 军师批注 line is picked from fixed phrases by the profile's numbers, seeded by member and game count, and it talks about play only.
It says 你 only to the member looking at their own profile and names the member otherwise.
A dimension is 常年垫底 only at an average percentile of 0.3 or below, and 是明显的短板 up to 0.4; 看家本领 needs 0.7 and 是强项 0.6.
Scores print through `formatScore` from `announcementText.ts`, the same rounding as the spoken report.

## Range queries for reports

`listHorseRecords(guildId, { mock, discordUserId?, from?, to?, order?, limit? })` returns records whose `played_at` is in the half-open range `[from, to)`.
`src/utils/pacificTime.ts` gives the ranges: `pacificDay(instant)` and `pacificWeek(instant)` return `{ start, end }` for the Pacific day or the Monday-to-Monday week containing the instant.
Days are 23 or 25 hours and weeks 167 or 169 hours when daylight saving changes, so always take the range from these helpers instead of adding 24 hours.
`pacificMonth(instant)` gives the calendar month the same way.
`listMatchHorseRecords(guildId, matchId, mock)` returns every tracked member's record for one match, grouped by `team_id` and best first within a team, for ranking the friends against each other.

## Verification

`tests/horseRecordStore.test.ts` upgrades a literal version 2 file written by a separate process, checks the backup, the rollback of a failing step, idempotent writes, history surviving member removal, erasing, mock and real separation and range queries at Pacific day and week boundaries including daylight saving.
`tests/horseRecordGuards.test.ts` covers the bound-members-only refusal, mock and real keys, team grouping and the commentary columns.
`tests/pacificTime.test.ts` covers the day, week and month helpers.
`tests/horseRecords.test.ts` covers record building, `tests/horseProfile.test.ts` the profile math, and `tests/stable.test.ts` the commands for an empty and a full profile.
