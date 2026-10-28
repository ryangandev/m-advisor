# 马报 (daily and weekly channel posts)

The bot posts a daily recap and a weekly leaderboard of who was 特等马 and who was 没有马 to a text channel an administrator chooses.
Optionally the weekly champions also get the Discord roles 本周特等马 and 本周没有马.
The numbers come from the 马厩 records described in [马厩](stable.md), and the tables are described in [Storage](storage.md#马报-report-settings).

## Periods and timing

All periods are Pacific time, the time zone of the NA servers, and are computed by `src/utils/pacificTime.ts`.
A day is a Pacific calendar day, so it is 23 or 25 hours long when daylight saving changes.
A week runs from Monday 00:00 to the next Monday 00:00, so it settles at the end of Sunday.
A game belongs to the period containing its `played_at`.

A finished period becomes due 30 minutes after it ends (`REPORT_GRACE_MS` in `src/services/reports.ts`).
A game's time is when it ended, but Riot publishes the match minutes later, the monitor polls every 45 seconds and the record is written around the announcement.
Half an hour keeps a game that ended just before midnight in its own day, and on Sunday in its own week and its roles.
At 00:30 Pacific the previous day is posted, and on Mondays the previous week too.
There is no mechanism that holds a report while a game is still unrecorded; a game recorded more than the grace after its period ended is not reported.

## What a report contains

`buildReportData` in `src/services/reports.ts` is pure and `src/utils/reportEmbed.ts` turns its result into the embed.
Only records of the current data mode are used, so mock and real games never mix, and only currently tracked members appear.
A member removed with `/unbind` keeps their history but is left out of reports, and enemies and strangers never have records.

| Part | Daily | Weekly |
| --- | --- | --- |
| Per-member lines | Games, wins, average score and the count of each tier | The same, as a leaderboard ranked by average score |
| Ranking bar | One game | `MIN_WEEKLY_GAMES`, 3 games |
| 特等马 and 没有马 | Best and worst average among ranked members, each with a 军师 line | The same, for the week |
| Best and worst single game | Yes, over everyone | Yes, over everyone |
| 军师总评 | Tier totals and a closing remark | Tier totals, busiest member, longest 特等马 and 没有马 streak inside the week and a closing remark |

When the period holds a single game, the best and the worst single game are the same record, so 单局之最 lists it once as 唯一一局.

The weekly bar is 3 games, the same bar the 马厩 uses before it calls a dimension a strength, so that one lucky or unlucky game cannot decide the week.
Members below the bar are listed without a rank and are not eligible.
Nobody is named when fewer than two members are ranked or when everyone averaged the same, and the report then says why.
Averages are compared as the report prints them, with one decimal, so 6.34 and 6.26 (both 6.3) are a tie.
That applies to the top, the bottom, the everyone-tied check and the leaderboard order, where a printed tie falls to the count of 特等马 games, then games played.
Members whose printed averages are equal share the same medal or place, as 并列 does, and the next place skips (1, 1, 3).
When several members share the best or the worst average, all of them are named as 并列 in the text and all of them get the weekly role.
Last place can be only relative: when the bottom member's printed average is at least `RELATIVE_BOTTOM_AVERAGE` = 6.0, or their worst game of the period was a 特等马 or 上等马, the field is titled `🐢 垫底（相对）` (a neutral icon, not a tier icon) and the 军师 says so softly instead of roasting a 没有马, like the 车队内战 does with 相对背锅 (Ryan's decision of 2026-10-28).
With a 并列 bottom, the soft wording is used only when every one of them qualifies.
The soft closings praise the score (分数不低) only when the printed average is at least 6.0; a bottom member triggered by a 上等马 or 特等马 worst game with a lower average gets closings about the rank in the party (队内排名不差) instead.
A member with exactly one game is described with 那一把是…, in the soft and in the harsh closing, instead of 最低的是… or 最难看的是….
A genuinely bad bottom member keeps the harsh 没有马 closing.
The soft line is chosen deterministically from the period and the members like the others, and it talks about play only.
The weekly 没有马 role follows the data, not the wording.
The busiest member and the longest 特等马 or 没有马 streak name everyone who shares the top value, and the busiest line is left out when the whole field played the same number of games.
The 军师 lines are chosen deterministically from the period and the member, so the same report always reads the same, and they talk about play only.

A finished period is worded as that period: the daily post says 当日 and the weekly post says 当周, and the title carries the date or date range.
Only `/report` on the period in progress says 今日 and 本周, and no closing line promises a tomorrow or a next week.
Members are written as `<@id>`, and every send passes `allowedMentions` that pings nobody.
A mock-mode report has the title prefix 模拟数据 and a mock footer.
A period with no recorded games is not posted; it is marked as handled silently.

## Posting and catch-up

`src/services/reportScheduler.ts` checks for due reports when the bot connects and then keeps checking.
The wait until the next check is the time until the next report is due, but never more than a minute, because a timer does not count the time the computer slept and a short tick notices the wake-up.
Each check posts, per server with a channel, only the most recent finished day and the most recent finished week that have not been handled.
After an outage this means the latest missed day and week and never a flood of older reports.
Each handled period is stored in `report_marks`, kept apart for mock and real data, and a mark only moves forward, so a period is posted at most once even across restarts.
The mark is written right after the send, so a crash between the two could post one period twice, which is accepted over losing a report.

When a channel is first set, or a daily or weekly report is switched from off to on, every period that has already ended is marked as handled, even one still inside its grace period.
Reports then start with the next period instead of replaying yesterday, and `/report` still shows any finished period on demand.
Switching a report on when it is already on changes nothing, so it never drops a report that is due.

A failed send does not mark the period, and it is retried on every check until it has kept failing for 6 hours (`GIVE_UP_AFTER_MS`), counted from the first failure in this process.
Network and timeout errors therefore never use up attempts: a Mac that wakes without Wi-Fi for a few minutes still posts once the network is back.
The log gets one line when a send starts failing and one when the period is given up.
A missing channel, missing access or missing permissions give up on that period at once.
A server that fails never blocks the other servers.

Every report is sent with a nonce derived from the server, data mode, kind and period and with `enforceNonce: true`, which discord.js 14.27 supports.
If a request times out after Discord already accepted it, the retry carries the same nonce and Discord returns the first message instead of posting a second one.
Discord only remembers a nonce for a few minutes, so a restart is protected by the stored marks and not by the nonce.
If the database refuses the mark after a successful send, the period is remembered in memory and logged, so it is not reposted every minute; after a restart it could post once more.

### Startup and shutdown hook

`src/events/reportScheduler.ts` is a second `ClientReady` listener that the existing event loader registers by itself, so `ready.ts` and `gameMonitor.ts` are untouched.
It calls `startReportScheduler(client)`, whose first check is the restart catch-up.
`src/index.ts` calls `haltReportScheduler()` first in graceful shutdown, which cancels the timer and stops any new check or send at once without waiting.
Just before the database closes it calls `finishReportScheduler()`, which waits at most 3 seconds (`SHUTDOWN_WAIT_MS`) for a report that is still being sent.
Role calls and a hung send therefore cannot hold up the voice, speech and client cleanup.

## Commands

| Command | Access | Behavior |
| --- | --- | --- |
| `/report day` and `/report week`, option `when` | Everyone, public reply | The period in progress (default) or the previous finished one, built by the same code as the scheduled report. It changes no marks and no roles. |
| `/report-settings show` | Administrator, private reply | Show the channel, switches and roles |
| `/report-settings channel channel` | Administrator, private reply | Set the channel, after checking the bot has View Channel, Send Messages and Embed Links there |
| `/report-settings channel-clear` | Administrator, private reply | Stop automatic reports; the other settings are kept. If weekly roles are on, they are released and turned off too |
| `/report-settings daily enabled` and `weekly enabled` | Administrator, private reply | Switch the daily or weekly report. Switching weekly off while roles are on releases and turns off the roles |
| `/report-settings roles enabled top-role none-role` | Administrator, private reply | Switch the weekly roles; the two role options reuse existing roles |

Automatic reports are off until a channel is set, and then daily and weekly are both on.
Changing definitions needs `npm run build` and `npm run register` like any command.

## Weekly roles

Roles are off by default.
Enabling them first runs a dry check, and nothing is created or changed unless it passes.
The bot needs Manage Roles, and any role you pass must be an ordinary role below the bot's highest role.
Otherwise the administrator gets a private explanation of what to fix.
Without role options the bot creates 本周特等马 and 本周没有马 with no permissions, which Discord places below the bot's own role.

After the weekly report is posted, `rotateWeeklyRoles` in `src/services/reportRoles.ts` gives the week's two champions their roles and takes the roles back from last week's holders.
It touches only the two configured roles and only members the bot itself gave them to, which are stored in `report_settings`, so roles given by hand are never taken away.
A role that was deleted is created again, and a champion who left the server is skipped.
When creating the two roles fails after the first one was made, that role is kept and reused on the next try instead of being created twice.
When nobody was named, the old holders lose the roles and nobody gains them.
A week with no games posts nothing, but the roles still rotate silently to nobody, so a stale 本周特等马 never lingers; a failure there is only logged.
Roles are only changed for real data: in mock mode the report is posted and the roles are left alone.

Any Discord failure is logged and collected, never thrown, so it cannot block the report, which is posted first.
The channel then gets one short note listing what to fix, and the rotation tries again the next week.
Turning roles off takes them back from the members the bot gave them to, keeps the role ids for later and does not delete the roles.
Roles follow the weekly report, so clearing the channel or switching weekly reports off while roles are on also releases the holders and turns the roles off; they stay off until `/report-settings roles` enables them again.
Enabling roles with different roles than before first takes the replaced roles back from their holders, and lists in the reply any member Discord would not let it release so an administrator can remove the role by hand.
A role that no longer exists counts as already released.

## What the administrator does in Discord

1. Give the bot the Manage Roles permission, through its role or when inviting it, if you want weekly roles.
2. In Server Settings, Roles, drag the bot's role above 本周特等马 and 本周没有马, and above any role you pass in.
3. Give the bot View Channel, Send Messages and Embed Links in the report channel.
4. Run `/report-settings channel`, then `/report-settings roles enabled:true` if you want the roles.

## Verification

`tests/reportStore.test.ts` covers the version 3 to 4 migration from a literal version 3 file with an uncheckpointed WAL, its backup, rollback of a failed step and the settings and marks API.
`tests/reports.test.ts` and `tests/reportEmbed.test.ts` cover the period timing including daylight saving, the report math, ties, mock and real separation, the finished and in-progress wording and the embed.
`tests/reportScheduler.test.ts` covers catch-up, at-most-once posting, empty periods, retries, the timer, shutdown and the role hand-off with a fake clock and fake Discord.
`tests/reportRoles.test.ts` and `tests/reportCommands.test.ts` cover role rotation and failures with a fake server and the commands.
None of them contacts Discord, and live posting and role changes are not yet verified in a real server.
