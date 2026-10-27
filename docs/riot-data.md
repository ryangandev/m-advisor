# Riot data and simulation

`RIOT_MODE=mock` is the default and does not require a Riot key or make Riot network requests.
All Discord replies and spoken announcements using this mode must carry a clear `模拟数据` label.
The provider exports `getRiotDataLabel()` and `isMockData()` for this purpose.
Set `RIOT_MODE=real` explicitly to use NA1 account statistics and Americas match history.
An invalid mode, missing key, or failed real request produces an error instead of simulated results.

## Mock profiles

| Riot ID | Scenario |
| --- | --- |
| `MockWin#NA1` | Ranked account with a winning baseline match |
| `MockLoss#NA1` | Ranked account with a losing baseline match and an enemy with the highest KDA |
| `MockUnranked#NA1` | Account without ranked entries |
| `MockAlt#NA1` | Second account with its own independent match history |
| `MockRateLimit#NA1` | Explicit simulated 429 error with a 1 second retry delay |
| `MockService#NA1` | Explicit simulated 503 service error |
| `MockAuth#NA1` | Explicit simulated 401 authentication error |
| `MockMissing#NA1` | Explicit simulated 404 account error |
| `MockNoTimeline#NA1` | Normal profile and matches whose timelines fail with a simulated 404 |

Mock matches are complete match-v5 response bodies with positions, champions, team objectives and the statistics used by [Horse ranking](scoring.md).
They pass through the same parser as real matches.
Their allied support has no kills but strong vision and protection, and their allied ADC feeds, so the ranking visibly differs from a KDA order.

Each mock match also has a match-v5 timeline body, built on request by `buildMockTimeline()` and passed through the same parser as a real timeline.
Hand-written key moments sit between filler kills, and every player's kills, deaths and assists and each team's dragons, barons and heralds match the match detail.
Scripted objective fights happen at the monster's pit; filler deaths happen in the victim's lane, away from both pits and at least 29 seconds apart, so they never form a fight.
In both outcomes the support carries a won objective fight and the feeding ADC is the first to fall in a lost one, so mock reports cite a moment for both the 特等马 and the 没有马.

Other Riot IDs receive deterministic synthetic profiles, and previously persisted bindings can be tested in mock mode.
This does not validate that a real player exists.
Mock histories live in memory and reset when the bot restarts; user bindings and voice settings have a separate persistence layer.
Each mock account's history starts with one baseline match, created on its first lookup and ended 24 hours before that.
It is old history even for a member whose first lookup runs after they join voice, so a saved mock binding never announces it.

## Simulating a finished game

`simulateMockMatch(puuid, "win" | "loss")` adds a new match to that account's mock history and returns `{ matchId, outcome }`.
`getLatestSRMatchId()` and `getMatchDetail()` then return it through the same public APIs used by normal polling.
Simulation is rejected in real mode.
The command or test runner should establish the monitoring baseline first, simulate a match, and then poll again.
`resetMockData()` is available to isolate automated tests.

## Real request behavior

Keys are passed in the `X-Riot-Token` header and removed from legacy `api_key` query parameters.
Only HTTPS calls to the configured NA1 and Americas Riot hosts are allowed, with redirects rejected.
Each request has a 10 second timeout and at most two retries for network failures, 429 responses, or server errors.
Retries use 1 and 2 second backoff unless Riot specifies `Retry-After`.
The requester applies 429 cooldowns across all endpoints on the affected regional host.
A delay longer than 10 seconds is returned as `RiotApiError.retryAfterMs` and blocks further requests on that host until the cooldown has elapsed.
Authentication and not-found errors are returned immediately.
Errors carry a stable `code`, optional HTTP `status`, optional `retryAfterMs`, and a `simulated` flag without exposing request keys or raw upstream diagnostic bodies.
Response parsers normalize omitted zero statistics and reject malformed profile, rank, or match shapes.
`parseMatchDetail()` keeps each participant's position (team position, falling back to individual position), champion, K/D/A, result and the scoring statistics, plus team objective counts, the game end time when present, whether the game was a remake, and whether it was aborted without a winner (`endOfGameResult` other than `GameComplete`).
Optional scoring statistics that are missing or non-numeric are omitted rather than treated as zero.

`getMatchTimeline()` reads `/lol/match/v5/matches/{matchId}/timeline` on the Americas host with its own requester.
That requester makes one attempt, aborts the request after 5 seconds, never retries, and fails at once during its own 429 cooldown instead of waiting.
A 429 on a timeline therefore never sets the shared cooldown that profile and match requests honor.
`parseMatchTimeline()` in `src/utils/matchTimeline.ts` keeps only champion kills with their positions, first blood and multi-kill awards, and epic monster kills.
It maps participant IDs to PUUIDs from `info.participants`, falling back to the order of `metadata.participants`, and skips malformed events instead of rejecting the timeline.
Voidgrubs (`HORDE`) and other monsters are ignored.
Timelines are not cached, because each finished match is announced once.
The timeline is optional flavor for the report: `fetchMatchEvents()` returns null and logs a warning when the request fails, times out or returns a malformed body, and the report then uses statistics only.
It never falls back to a mock timeline, and it skips the request for remakes, aborted games and games shorter than 10 minutes.
The fields it reads (`position`, `shutdownBounty`, `KILL_FIRST_BLOOD`, `KILL_MULTI` with `multiKillLength`, `killerTeamId`, `monsterSubType` and `info.participants`) were confirmed on a real NA timeline on 2026-10-07.

The latest match lookup checks up to 20 matches for supported Summoner's Rift queues and caches at most 200 immutable match details.
Supported queues are 400, 420, 430, 440, 480, and 490; this includes Swiftplay and Quickplay and preserves Blind Pick for older history.

Queue IDs were checked against [Riot's official queue constants](https://static.developer.riotgames.com/docs/lol/queues.json) on 2026-10-02.
Retry and authentication failure behavior follows the [Riot Developer Portal response-code documentation](https://developer.riotgames.com/docs/portal).
NA1 and Americas routing follows the [official League of Legends routing documentation](https://developer.riotgames.com/docs/lol).

## Profile icons and visible labels

Profile replies carry a simulated-data label in both their title and footer in mock mode.
Mock lookup failures and validation errors are also visibly labeled, and real-mode authentication failures do not display private response diagnostics.
Profile icons use the official Data Dragon CDN with version `16.19.1`, verified against [the official versions endpoint](https://ddragon.leagueoflegends.com/api/versions.json) on 2026-10-02.
Set `DDRAGON_VERSION` to a current published numeric version to update the CDN path without changing code.
An invalid version or icon ID omits the thumbnail rather than breaking the reply.

## Active games (spectator-v5)

`getActiveGame(puuid)` in `src/utils/riotSpectatorApi.ts` asks `GET https://na1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/{puuid}` whether an account is in a game right now.
The game start watcher polls it; see [Game start](announcements.md#game-start).

Verified against Riot with the development key on 2026-10-27:

- An account that is not in a game answers 404 with `{"httpStatus":404,"errorCode":"NOT_FOUND","message":"Not Found","implementationDetails":"filtered"}`, which `getActiveGame()` returns as `null`.
- The app rate limit is `X-App-Rate-Limit: 100:120,20:1`, counted separately on na1 from americas.
- The method limit is `3000:10,180000:600`.

The 200 response shape is NOT yet verified: it follows Riot's documented `CurrentGameInfo` and is pending a capture of a real game.
`tests/fixtures/spectator-active-game.documented.json` is built from that documentation and is not a capture; replace it with a capture when there is one.

The parser is strict only about what identifies the game: the body must be an object with a positive safe integer `gameId`, an integer `gameStartTime` (0 while loading), a `participants` array and a finite `gameLength` (negative is allowed).
Anything else degrades instead of failing, because custom games, Practice Tool, Arena and privacy-filtered players would otherwise break every poll with `invalid_response`:

- `gameQueueConfigId`, `mapId` and `platformId` are `null` when missing or unusable, and `isAnnouncedGame()` is false for a null queue or map.
- A participant whose `puuid` is missing, empty or not text (a bot, or a hidden human) is kept with `puuid: null`.
- A missing or bad `championId`, `spell1Id` or `spell2Id` becomes 0, and a `bot` that is not `true` is false.
- A participant that is not an object or has no `teamId` of 100 or 200 cannot be placed on a team and is dropped.

A body that is not an object, or has no usable `gameId`, `gameStartTime`, `participants` or `gameLength`, is an `invalid_response` error, never "not in a game".
The participant `riotId` is never read: names come from stored bindings.

Spectator's own requester also reads the `errorCode` token of a 404 (kept only if it is a short upper-case token).
`NOT_FOUND` means "not in a game" and returns `null`; any other 404, such as Riot's older `{"status":{...}}` envelope or a gateway page, is an `invalid_response` error with status 404.

`matchIdOf(game)` is `NA1_${gameId}`, the match-v5 ID the game will have once finished.
`isLoading(game)` is true while `gameStartTime` is 0.
Spectator has its own requester with one attempt, a 5 second timeout and no waiting, like the timeline requester.
A spectator 429 therefore never sets the shared na1 cooldown that `/profile` and `/bind` honor, and its own cooldown fails fast.
A 401 or 403 is thrown as a `RiotApiError`; `isSpectatorAuthError()` recognizes it so the watcher can disable itself without stopping match monitoring.

### Mock active games

`simulateMockGameStart(blue, red = [])` starts a labeled mock game and returns `{ matchId, gameId }`.
The game is still loading (`gameStartTime` 0, `gameLength` 0) in queue 420 on Summoner's Rift.
The `blue` accounts (one to five) take team 100 in order and the optional `red` accounts (up to five) take team 200, so a friend on the other side can be simulated.
`MOCK-ALLY-*` and `MOCK-ENEMY-*` fill the remaining seats, numbered in seat order.
Parsed mock games have `mock: true`, and their game ID starts at 9 billion, far above the game IDs Riot has issued so far, which makes them easy to tell apart.
Nothing relies on that: `mock` comes from the mode.
Its match ID is reserved as `MOCK_<first puuid>_<epoch>_<sequence>`, and `matchIdOf()` returns it.
`simulateMockMatch()` for an account in the game ends it for everyone in it and reuses that ID, so the start and the finished match are one match.
The finished match seats every member of the game on their own team with the champions the game had, and its ID is the newest entry of every member's history.
The outcome passed to `simulateMockMatch()` is the result of the team of the account it was called for.
`resetMockData()` clears mock games.
With no mock game, the mock spectator endpoint answers a simulated 404.
Mock accounts that simulate a failure fail the spectator request the same way, and starting a game for them is refused.

## League snapshots (league-v4)

`getLeagueEntries(puuid)` in `src/utils/riotLeagueApi.ts` reads `GET https://na1.api.riotgames.com/lol/league/v4/entries/by-puuid/{puuid}` and returns `{ entries, dropped }`.
It exists to read an account's rank and LP before and after a ranked game.
`/profile` still uses `getRankedEntries()` and its own parser.

The league endpoint has its own requester, like spectator: one attempt, a 5 second timeout, no retries and no waiting.
The caller schedules any retry.
A league 429 therefore never sets the shared na1 cooldown that `/profile` and `/bind` honor, and the league requester's own cooldown fails fast.
Riot still counts every request against the same na1 app limit on its side.

The parser is tolerant per entry, because the numbers drive an LP difference:

- An entry is kept only with a string `queueType`, `tier` and `rank`, and whole, non-negative `leaguePoints`, `wins` and `losses`.
- A missing `leaguePoints` rejects that entry. It is never read as 0, which would invent an LP change.
- A malformed entry is dropped and counted in `dropped`; the other queue's entry survives.
- A body that is not an array, or an array whose every entry is malformed, is an `invalid_response` error, because an empty list would read as an unranked account.

Real-mode failures are thrown as `RiotApiError`.
They never fall back to mock data, and real mode never reads the mock ranked state.

### Ladder math

`src/services/rankMath.ts` is pure and uses Riot's enums only: `IRON` to `CHALLENGER` and divisions `IV` to `I`.
Display names belong to the text layer, not to the math.

- The ladder value is `tier * 400 + division * 100 + LP`, with IRON 0 to DIAMOND 6 (EMERALD is 5) and IV 0 to I 3. `MASTER`, `GRANDMASTER` and `CHALLENGER` share `2800 + LP`, and their `rank` string means nothing.
- The delta is the value after minus the value before. It is correct across divisions, tiers and the DIAMOND to MASTER boundary: DIAMOND I 90 to MASTER 15 is +25, and GOLD IV 90 to GOLD III 10 is +20.
- Queue 420 is `RANKED_SOLO_5x5` and 440 is `RANKED_FLEX_SR`. Other queues have no LP read.
- The attribution key is `wins + losses` of the matching queue entry, before and after: no new game is `pending`, exactly one new game is attributed to the game, and anything else is `unattributable`.
- A promotion or demotion is a change of rung over one game, in one small predicate (`countsAsRankMove`). Per Ryan's decision of 2026-10-27, every division change and every tier change counts, in solo and in flex (`灵活组排`).
- Moves between `MASTER`, `GRANDMASTER` and `CHALLENGER` happen through cutoffs, not games, so they are a plain `change`, never a promotion.
- No entry before and one after is `placed`, with no delta. An entry that disappeared, an unknown tier or division and a queue mismatch give `none`, never an error.

### Mock ranked state

Mock ranked entries are mutable per PUUID, seeded from the fixture profile (`MockWin#NA1` starts at GOLD II 64 LP solo and SILVER I 28 LP flex) and shared with `/profile`.
`simulateMockMatch()` moves the entry of the match's queue: +22 LP and one more win for a win, -19 LP and one more loss for a loss, with division and tier rollover.
Every mock match is queue 420, so only solo moves.
In a mock game the outcome is the result of the team of the account it was called for, and each member moves by their own team's result.
An account without an entry in that queue stays unranked.
`setMockRankedEntry(puuid, entry)` replaces or adds an entry for tests and is rejected in real mode.
`resetMockData()` clears the ranked state back to the fixtures.

### Rank tracking

`src/services/rankTracker.ts` schedules every league-v4 read; when they happen and what the report shows is in [Announcements](announcements.md#段位变化).
It depends on an injected `readEntries(puuid)`, which is `getLeagueEntries` in production, and never on a requester directly.

- Snapshots live in memory, keyed by data mode and PUUID, so a mock read is never a real before-value, and in real mode a saved `MOCK-` account is never read.
- Each account keeps its last 4 successful reads with the time each was sent, so a match's before-value can be the newest read from before it ended.
- Reads run one at a time across every guild. Each is also bounded by the tracker's own 10 second guard, so a stuck dependency cannot hold the queue.
- Every read of an account comes at least 60 seconds after its previous read of any kind, failed reads included, checked when it is queued and again when its turn comes. The only exception is a match's first after-read, which goes out at detection.
- While league-v4 has not caught up (`wins + losses` unchanged), the account is read again on that floor, at most 4 reads per account per match.
- Only one snapshot read per account waits in the queue.
- The worst case is therefore 3 reads per account in any 2 minutes (two reads a floor apart plus one first after-read), 30 for 10 accounts, and in practice about 2 per account. That leaves room under the na1 app limit of 100 per 2 minutes next to spectator's 60 for `/profile` and `/bind`.
- At shutdown `stop()` turns every queued read into a no-op, clears the retry timers and settles every pending row with no row; a read already sent is ignored when it answers.

Failures never reach the report as an error:

- A 401 or 403 turns LP off until the bot restarts, with one log line; pending rows are dropped and finished matches are still announced.
- A 429 is quiet: that read counts toward the cap and the scheduled read follows.
- A timeout, the requester's 5 seconds or the tracker's guard, counts as not caught up yet.
- Any other failure is logged once per kind, with one line when a read works again, and the row says `段位暂时查不到`.

Each account's after-reads log one line per match, `league-v4 caught up N s after game end (read k)`, or that it had not caught up after the last read.
A result that shows no row because the entry disappeared or the tier is unknown is logged as `none/<reason>`.

### Still to measure

These need real ranked games and are not known yet: how long league-v4 lags behind the end of a game, whether a remake changes LP or `wins + losses`, whether an entry exists during placements, and where a demotion places you in LP.
The lag lines above answer the first: the retry window is to be set from the p95 of at least 10 real ranked games.
