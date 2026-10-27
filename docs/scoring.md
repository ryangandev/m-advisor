# Horse ranking

After each completed game, the bot ranks the tracked player's five teammates as 特等马, 上等马, 中等马, 下等马 and 没有马.
Enemies are never scored or named.
It praises the 特等马 and roasts the 没有马 in the spoken report and the channel report.
The ranking lives in `src/services/horseRanking.ts` and the wording in `src/services/announcementText.ts`.

## Why not KDA

KDA measures how a player traded kills, not what the position asked of them.
In the real reference sample, ranking teammates by (kills + assists) / deaths put the top laner last in 35% of teams, against an ideal 20%.
It put supports and junglers last only 10% and 13% of the time, because their assists inflate the ratio.
A support who dies protecting a carry still drops, while a top laner who holds a lane alone with few takedowns is punished almost every game.
The current model keeps every position near 20% for every tier; see [Validation](#validation).

## Research basis

No public tool publishes its exact formula, so the model combines the published principles of several:

- Riot's post-game grades compare a player only with others in the same champion and position ([community summary](https://blog.loltheory.gg/how-to-get-s-in-lol/)).
  The bot compares with the same position, because champion-level references need far larger samples.
- [Mobalytics GPI](https://mobalytics.gg/gpi/) scores separate skill areas and weights them by role, for example vision for junglers and supports.
- [PandaSkill](https://arxiv.org/html/2501.10049v2) uses a separate model per role, normalizes statistics by game length and converts the result to percentiles that are independent of the game outcome.
- [OP.GG's OP Score](https://help.op.gg/hc/en-us/articles/31088715328665-OP-Score-explained) presents a 0-10 per-match score across many factors.

## Model

Each statistic is normalized per minute or as a share of the team total.
Lane matchup features compare the player directly with the enemy in the same position.

| Dimension | Features (weight inside the dimension) |
| --- | --- |
| damage | damage share 0.6, damage per minute 0.4 |
| teamfight | kill participation 0.75, takedowns per minute 0.25 |
| survival | deaths per minute 0.6 (lower is better), (kills + assists) / (deaths + 1) 0.4 |
| economy | gold 0.4, CS 0.35, experience 0.25, all per minute |
| frontline | damage taken share 0.6, self-mitigated damage per minute 0.4 |
| vision | vision score 0.6, control wards 0.2, ward takedowns 0.2, all per minute |
| objectives | epic monster takedown share 0.35, building damage per minute 0.45, turret takedown share 0.2 |
| utility | effective heal and shield 0.4, crowd-control time 0.3, immobilizations 0.3, all per minute |
| matchup | gold difference 0.4 and experience difference 0.3 per minute, max CS lead 0.3 |

Every feature becomes a percentile against the same position in the reference sample.
Each dimension averages its feature percentiles, and the position weights below combine the dimensions.

| Dimension | TOP | JUNGLE | MIDDLE | BOTTOM | UTILITY |
| --- | --- | --- | --- | --- | --- |
| damage | 0.18 | 0.14 | 0.24 | 0.26 | 0.08 |
| teamfight | 0.10 | 0.18 | 0.14 | 0.12 | 0.20 |
| survival | 0.12 | 0.10 | 0.12 | 0.13 | 0.08 |
| economy | 0.12 | 0.10 | 0.13 | 0.16 | 0.03 |
| frontline | 0.14 | 0.07 | 0.03 | 0.00 | 0.07 |
| vision | 0.05 | 0.11 | 0.05 | 0.04 | 0.22 |
| objectives | 0.12 | 0.20 | 0.09 | 0.11 | 0.06 |
| utility | 0.05 | 0.05 | 0.06 | 0.03 | 0.22 |
| matchup | 0.12 | 0.05 | 0.14 | 0.15 | 0.04 |

The combined value is calibrated once more against the same position, so the final score means "better than this share of same-position reference players".
A score of 8.5 beats 85% of them.
This calibration is what keeps a support as likely to be 特等马 as a carry.
The game result is not an input; winning teams score higher only because their statistics are better.

Missing statistics are skipped and the remaining weights are renormalized.
A player without a known position uses the all-position reference and weights.
Ties are ordered by score, then by the combined value, then by PUUID.
Remakes, aborted games without a winner and games shorter than 10 minutes are not ranked; the bot announces that it will not judge them.

## Validation

`npm run benchmarks:build` prints a fairness report over both teams of every sampled match.
The committed reference was built on 2026-10-03 from 441 NA ranked solo matches from Silver to Diamond on patches 16.15 to 16.19.
It holds 882 players per position.

Share of teams in which each position received each tier (ideal 20%):

| Tier | TOP | JUNGLE | MIDDLE | BOTTOM | UTILITY |
| --- | --- | --- | --- | --- | --- |
| 特等马 | 23% | 20% | 19% | 19% | 18% |
| 上等马 | 16% | 19% | 22% | 23% | 20% |
| 中等马 | 19% | 22% | 19% | 18% | 22% |
| 下等马 | 21% | 21% | 18% | 19% | 21% |
| 没有马 | 21% | 18% | 21% | 20% | 19% |

For comparison, a KDA-only ranking on the same sample:

| Rank | TOP | JUNGLE | MIDDLE | BOTTOM | UTILITY |
| --- | --- | --- | --- | --- | --- |
| First | 13% | 25% | 19% | 18% | 25% |
| Last | 35% | 13% | 23% | 19% | 10% |

The winning team's 特等马 outscored the losing team's in 89% of matches, even though the result is not an input.
The same sample filtered out one game stopped by an anti-cheat exit in which neither team won.

## Refreshing the reference

```sh
npm run benchmarks:sample
npm run benchmarks:build
npm run champions:update
```

Sampling needs a valid `RIOT_API_KEY` and paces requests below the development-key limit of 100 requests per two minutes.
It reads the most recent ranked solo match from the first page of players in each tier and division, limited to the last 60 days.
Use `--tiers=`, `--divisions=`, `--per-division=` and `--max-age-days=` to change the sample.
Raw matches contain other players' identities, so they stay in the ignored `.data/benchmark-sample` directory.
Only aggregated quantiles are committed to `src/data/roleBenchmarks.json`.
The build skips remakes, aborted games, games under 10 minutes and games older than 60 days.

Chinese champion names come from Data Dragon's `zh_CN` data, where `title` holds the short name such as 亚索.
They are keyed by numeric champion ID because match data and Data Dragon disagree on some identifiers, such as `FiddleSticks`.
Unknown champions fall back to their English identifier.

## Commentary rules

Speech reads the result and game length, then all five tiers in order with champion, name and score.
The praise cites a statistic from the 特等马's strongest relevant dimension that is at least the 60th percentile for the position.
The roast cites one from the 没有马's weakest relevant dimension that is at most the 40th percentile.
Because those percentiles are position-relative but the lines quote absolute numbers, each line also has an absolute bar, such as at least 60% kill participation for "哪里有架打哪里就有你" or at least 7 deaths for "泉水年卡".
If the first dimension's number misses its bar, the next qualifying dimension is tried; if none qualifies, a general compliment or jab is used.
On the reference sample that fallback happened in 2.5% of praises and 5.3% of roasts.
Extra lines call out a losing 特等马, a winning 没有马, and the summoner when they are 特等马 or 没有马 themselves.

### Timeline moments

When the match-v5 timeline is available, a concrete moment can replace the statistic in the praise or the roast.
It replaces that one line rather than adding one, so the report does not grow; the openers, closers and phrase choices stay the same.
At most one moment is cited for the 特等马 and one for the 没有马, and without a qualifying moment the line is the statistic as before.
`src/services/matchEvents.ts` extracts the moments and `announcementText.ts` words them.

A fight is a run of at least 3 deaths, each no more than 15 seconds after the previous one.
An epic monster (baron, elder dragon, dragon or herald) belongs to a fight or a death when a team takes it from the first death until 45 seconds after the last.
The strongest qualifying moment is cited, in this order:

| Praise for 特等马 | Rule | Example |
| --- | --- | --- |
| Multi-kill | Triple kill or more from Riot's multi-kill event | 第24分钟一波三杀，对面排着队来给你送人头。 |
| Won objective fight | Survived a fight the team won on deaths, took part in at least 3 of its kills, and the team took an epic monster | 第24分钟大龙团你参与4个击杀还全身而退，大龙顺手就收了。 |
| Shutdown | Killed an enemy with a shutdown bounty of at least 400 gold | 第26分钟终结对面中单，一口吞下700赏金，这波饭真香。 |
| Won fight | The same fight without an epic monster | 第18分钟那波团战你参与3个击杀还全身而退，直接把对面打穿。 |
| First blood | Made the first kill of the game, solo or with help | 第3分钟单杀对面上单拿下一血，开局就把对面打懵了。 |

| Roast for 没有马 | Rule | Example |
| --- | --- | --- |
| First to fall in a lost objective fight | First death of a fight the team did not win on deaths, and the enemy took an epic monster | 第22分钟大龙团你第一个倒下，对面转身就把大龙拿了。 |
| Death before an objective | The enemy took an epic monster within 45 seconds of the death | 第17分钟小龙前你先倒下了，小龙就这么拱手送人。 |
| First to fall in a lost fight | The same fight without an epic monster | 第20分钟那波团战你第一个倒下，队友只能四打五。 |
| Shutdown given | Was killed with a shutdown bounty of at least 400 gold | 第20分钟揣着700赏金被对面中单终结，这钱送得比外卖还准时。 |
| First blood given | Died first in the game to an enemy champion | 第3分钟就被对面打野拿走一血，开局先给对面发了个红包。 |

Ties go to the bigger monster (baron, elder, dragon, herald), then the bigger number, then the earlier moment.
An execution by a turret or minion is a death but never first blood.
Minutes are read from the game clock, so 22:40 is 第22分钟.
An enemy appears only as a position such as 对面打野; a moment never carries an enemy's name, PUUID or champion.
The thresholds are first estimates from Riot's documented event fields and are not yet calibrated on a real timeline sample.
Roasts stay about in-game play; they never target identity, appearance or family.
Phrase choices are seeded by the match ID, so the same match always produces the same report.
Mock reports start with `模拟战报` and carry a mock title and footer.
Names are stripped of mention and Markdown characters before use.
On the reference sample, speech ran 268 to 377 characters with a median of 317.
On the `MockWin` and `MockLoss` baseline reports, citing timeline moments changed speech from 287 to 285 and from 275 to 283 characters.
The 271-character mock report produced 52.6 seconds of Serena audio, so a typical report lasts about one minute.
