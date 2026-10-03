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
Roasts stay about in-game play; they never target identity, appearance or family.
Phrase choices are seeded by the match ID, so the same match always produces the same report.
Mock reports start with `模拟战报` and carry a mock title and footer.
Names are stripped of mention and Markdown characters before use.
On the reference sample, speech ran 268 to 377 characters with a median of 317.
The 271-character mock report produced 52.6 seconds of Serena audio, so a typical report lasts about one minute.
