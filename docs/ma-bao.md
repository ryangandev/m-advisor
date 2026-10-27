# 马报 (daily and weekly channel posts)

The bot posts a daily recap and a weekly leaderboard of who was 特等马 and who was 没有马 to a text channel an administrator chooses.
Optionally the weekly champions also get the Discord roles 本周特等马 and 本周没有马.
The numbers come from the 马厩 records described in [马厩](stable.md), and the tables are described in [Storage](storage.md#马报-report-settings).

## Periods and timing

All periods are Pacific time, the time zone of the NA servers, and are computed by `src/utils/pacificTime.ts`.
A day is a Pacific calendar day, so it is 23 or 25 hours long when daylight saving changes.
A week runs from Monday 00:00 to the next Monday 00:00, so it settles at the end of Sunday.
A game belongs to the period containing its `played_at`.

A finished period becomes due 5 minutes after it ends (`REPORT_GRACE_MS` in `src/services/reports.ts`).
A game that ends just before midnight is announced and recorded a little later, and the grace keeps it in its own day.
At 00:05 Pacific the previous day is posted, and on Mondays the previous week too.

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

The weekly bar is 3 games, the same bar the 马厩 uses before it calls a dimension a strength, so that one lucky or unlucky game cannot decide the week.
Members below the bar are listed without a rank and are not eligible.
Nobody is named when fewer than two members are ranked or when everyone averaged the same, and the report then says why.
The 军师 lines are chosen deterministically from the period and the member, so the same report always reads the same, and they talk about play only.

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

When a channel is first set, or a daily or weekly report is switched on, the periods that have already finished are marked as handled.
Reports then start with the next period instead of replaying yesterday, and `/report` still shows any finished period on demand.

A failed send does not mark the period when the cause may pass, and it is retried on the next check, up to 3 attempts.
A missing channel, missing access or missing permissions give up on that period at once and log a warning.
A server that fails never blocks the other servers.

### Startup and shutdown hook

`src/events/reportScheduler.ts` is a second `ClientReady` listener that the existing event loader registers by itself, so `ready.ts` and `gameMonitor.ts` are untouched.
It calls `startReportScheduler(client)`, whose first check is the restart catch-up.
`src/index.ts` calls `stopReportScheduler()` first in graceful shutdown, before monitoring, the client and the database are closed.
It cancels the timer and waits for a report that is being sent, and the stopping flag prevents a new one from starting.

## Commands

| Command | Access | Behavior |
| --- | --- | --- |
| `/report day` and `/report week`, option `when` | Everyone, public reply | The period in progress (default) or the previous finished one, built by the same code as the scheduled report. It changes no marks and no roles. |
| `/report-settings show` | Administrator, private reply | Show the channel, switches and roles |
| `/report-settings channel channel` | Administrator, private reply | Set the channel, after checking the bot has View Channel, Send Messages and Embed Links there |
| `/report-settings channel-clear` | Administrator, private reply | Stop automatic reports; the other settings are kept |
| `/report-settings daily enabled` and `weekly enabled` | Administrator, private reply | Switch the daily or weekly report |
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
When nobody was named, the old holders lose the roles and nobody gains them.
A week with no games is skipped and leaves the roles as they were.
Roles are only changed for real data: in mock mode the report is posted and the roles are left alone.

Any Discord failure is logged and collected, never thrown, so it cannot block the report, which is posted first.
The channel then gets one short note listing what to fix, and the rotation tries again the next week.
Turning roles off takes them back from the members the bot gave them to, keeps the role ids for later and does not delete the roles.

## What the administrator does in Discord

1. Give the bot the Manage Roles permission, through its role or when inviting it, if you want weekly roles.
2. In Server Settings, Roles, drag the bot's role above 本周特等马 and 本周没有马, and above any role you pass in.
3. Give the bot View Channel, Send Messages and Embed Links in the report channel.
4. Run `/report-settings channel`, then `/report-settings roles enabled:true` if you want the roles.

## Verification

`tests/reportStore.test.ts` covers the version 3 to 4 migration from a literal version 3 file with an uncheckpointed WAL, its backup, rollback of a failed step and the settings and marks API.
`tests/reports.test.ts` covers the period timing including daylight saving, the report math, mock and real separation and the embed.
`tests/reportScheduler.test.ts` covers catch-up, at-most-once posting, empty periods, retries, the timer, shutdown and the role hand-off with a fake clock and fake Discord.
`tests/reportRoles.test.ts` and `tests/reportCommands.test.ts` cover role rotation and failures with a fake server and the commands.
None of them contacts Discord, and live posting and role changes are not yet verified in a real server.
