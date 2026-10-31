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

The monitor records a match once its text report has been posted, before the voice plays.
When the text cannot be posted, for example without Send Messages, it records the match after the voice plays instead (see [Announcements](announcements.md#text-first-timeline-and-马厩-records)):

```ts
import { buildHorseRecords } from "./horseRecords";
import { recordHorseRecords } from "../store/horseRecordStore";

recordHorseRecords(buildHorseRecords({
  guildId,
  detail,
  tracked: listTrackedMembers(guildId).flatMap((member) =>
    member.accounts.map((account) => ({ discordUserId: member.discordUserId, puuid: account.puuid }))),
  mock: this.dependencies.mock(),
  announcement: { announcement, perspectivePuuid: speaker.puuid, events },
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
`/unbind` removes the member's accounts and stops monitoring them, and keeps the history, because it is the group's history.
`horse_records` has no foreign key to `tracked_members`, so nothing cascades.
Binding the same member again continues the same history, and `/stable` still shows an unbound member, with a note that no new games are recorded.

An administrator erases one member's whole history, real and mock, with `/stable-erase user confirm:true`, which Discord hides from non-administrators by default and also checks in the handler.
Without `confirm:true` the command only counts the records and erases nothing.
The member's closed `/why` appeal cases and stored [LP results](storage.md#lp-results) are deleted in the same transaction as the records.
The count and the confirmation include all three: a member who has only appeal cases or LP results is told what will go, and the command never says there is nothing to erase while any of them remains.
The reply is private and the erase is not reversible, so restore the migration backup if one is needed.
An erase does not unbind the member, so a bound member is recorded again for every match the monitor detects after the erase, including one that ended before it; a match detected before the erase and reported later is not recorded (see [storage](storage.md#马厩-horse-records)).
A confirmed erase of a member with nothing stored yet sets the same cutoff.
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

## 军师赛前锦囊

The 锦囊 turns our own teammates' 马厩 history into a short spoken line and a text card for a game that is about to start.
`buildPregameBrief` in `src/services/pregameBrief.ts` is pure and `buildPregameEmbed` in `src/utils/pregameEmbed.ts` draws the card.
Detecting the start of a game and posting the card are a separate step that is not part of this builder.

### What it says

It reads the bound members on the perspective team and nothing else: `{ memberId, name, championId, smite, records }` for each, plus a count of the other players on that team and whether a bound member is playing on the other side.
For each teammate it reads the records of the current data mode that the caller passes, at most 200 per teammate (`RECORDS_PER_TEAMMATE` in `src/services/gameStartWatcher.ts`).
The last 5 tiers, the averages, the trend and the runs use the latest 10 of them.
The record on the champion in the game, the signature champion, the position and the pick use every record passed in.
The card shows:

- the last 5 tiers, newest first, and their average score;
- the last 5 against the 5 before with an arrow, only when both sides have at least 3 games, where a difference of 1.0 or more counts as up or down, and the card labels the earlier window with its real size (前3局 to 前5局);
- the record on the champion in the game when there are at least 2 games, and the likely position, which is 打野 only with Smite and otherwise the most common non-jungle position on that champion, or none;
- 🔥 for a run of at least 2 特等马 and 🥶 for a run of at least 2 没有马.

军师之选 is the teammate with the highest last-5 average among those with at least 3 recorded games, plus up to 2 points when the champion in the game is a signature champion (拿手英雄).
A champion is a signature champion with at least 2 games as 特等马 in at least half of at least 3 games on it, and more 特等马 than 没有马.
Ties go to the earlier bound member, and when nobody has 3 games nobody is picked and the line says `底细还不够，军师先不押人。` before the order.
The reason spoken after the pick's name is one of: `阿狸是他的拿手英雄`, `连着N局特等马`, `近况最旺` (average 6.5 or more and the highest raw average), `状态最稳` (4.5 or more), or else `N个里先挑他`, which is `先押他了` with one teammate.
军师指令 aims at the strongest negative signal in the team, never at the pick and never at a signature champion: a champion that ended as 没有马 in at least 2 games and 30% of at least 3, then the longest cold run, then the biggest fall in form.
Without a negative signal it is a playful order to the pick, which names the pick again so the sentence makes sense heard alone.
The wording is fixed phrases about play, chosen with `seededChooser` seeded by `pregame:` and the game ID, so the same game always gets the same brief.

The spoken line is at most two sentences and 75 characters, the mock label included, and starts with `模拟锦囊，` in mock mode.
When it is too long the form phrase goes first, then the names are shortened step by step.
Characters that would end a sentence are removed from names, so a name can never add a sentence.

A team where nobody has a record yet is a cold start: the line begins with `马厩里还没有各位的底细，军师掐指一算……`, nobody is picked and the order is generic.
A teammate without records next to rated ones is `新马` and stays unrated.

### What it never says

Enemies, strangers and a tracked member on the other team are never passed to the builder, so they are never named, rated or counted into a pick.
Strangers appear only as `还有 N 位路人队友` in the footer, and the footer always says `对面不评`.
A bound member on the other side is acknowledged in the card by `对面也有自家人，军师两边不站`, without a name or a rating.
The message above the card does mention every tracked player of the game who is in the voice channel, from both teams, so a friend on the other side is pinged that the game started (`pregameMentionContent` in `src/utils/pregameEmbed.ts`).
The card shows bound teammates by `<@id>` mention, never by a Riot name, and the speech sanitizes names like the announcement does.
The spoken name is `storedGameName`, which must come from the stored binding and never from spectator or match data about the live game.
The builder throws for a `memberId` that is not a Discord snowflake (17 to 20 digits) and for a repeated `memberId`, so a caller bug fails loudly instead of printing a PUUID or a name into a mention.
Mock and real records are never mixed: the builder refuses a record whose kind differs from the brief, and mock cards carry `模拟数据 · 军师赛前锦囊` and the mock footer.
`pregameAllowedMentions(userIds)` gives the `allowedMentions` for the message: no parse, no roles and only the named members, and it drops anything that is not a snowflake.

## Verification

`tests/horseRecordStore.test.ts` upgrades a literal version 2 file written by a separate process, checks the backup, the rollback of a failing step, idempotent writes, history surviving member removal, erasing, mock and real separation and range queries at Pacific day and week boundaries including daylight saving.
`tests/horseRecordGuards.test.ts` covers the bound-members-only refusal, mock and real keys, team grouping and the commentary columns.
`tests/pacificTime.test.ts` covers the day, week and month helpers.
`tests/horseRecords.test.ts` covers record building, `tests/horseProfile.test.ts` the profile math, and `tests/stable.test.ts` the commands for an empty and a full profile.
`tests/pregameBrief.test.ts` covers the 锦囊: what never leaks, the pick and the instruction, cold and partial cold starts, determinism per game, the mock label, the sentence and length limit with 32-character names, and refusing mixed records.
