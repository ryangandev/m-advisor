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
A simulated match ID is `MOCK_<boot>_<epoch>_<sequence>`, where `<boot>` is a base36 clock plus 16 random bits chosen once per process.
The stable and the LP store keep a game by its ID and skip one they already hold, so IDs never repeat after a restart.
The ID is about 20 characters and does not contain the PUUID, which keeps it far inside the 40 characters an appeal button allows even after thousands of simulations.
The baseline match keeps `MOCK_<puuid>_<epoch>_BASELINE`; it is old history and never a stored record.
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
A call can pass `{ retry: false }` to make one attempt only, so a network failure, a 5xx or a 429 is thrown at once; a short cooldown on the host is still waited out first, because that wait is not a retry.
`getLatestSRMatchId(puuid, options)`, `getMatchDetail(matchId, options)` and `getRecentMatchIds(puuid, count, options)` pass it to every request they make, for a caller whose next poll is the retry.
The requester applies 429 cooldowns across all endpoints on the affected regional host.
A delay longer than 10 seconds is returned as `RiotApiError.retryAfterMs` and blocks further requests on that host until the cooldown has elapsed.
Authentication and not-found errors are returned immediately.
A rejected key is made visible in the log: `src/services/riotKey.ts` holds the shared `Riot rejected RIOT_API_KEY (<status>); paste a new key into .env and restart.` line, used by `/profile`, `/bind`, `/recent` and the one startup check described in [Runtime](runtime.md).
Errors carry a stable `code`, optional HTTP `status`, optional `retryAfterMs`, and a `simulated` flag without exposing request keys or raw upstream diagnostic bodies.
Response parsers normalize omitted zero statistics and reject malformed profile, rank, or match shapes.
`parseMatchDetail()` keeps each participant's position (team position, falling back to individual position), champion, K/D/A, result and the scoring statistics, plus team objective counts, the game end time when present, whether the game was a remake, and whether it was aborted without a winner (`endOfGameResult` other than `GameComplete`).
Optional scoring statistics that are missing or non-numeric are omitted rather than treated as zero.
In a supported Summoner's Rift queue every participant must be on team 100 or 200, with at most five on each team, or the match is an `invalid_response`.
Without that check a missing `teamId` would parse as 0 for everyone, and the ranking would treat all ten players as one team and name the enemies.
Other modes, such as Arena with up to eight teams, are never ranked or announced, so their team IDs are not checked.

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

The latest match lookup checks up to 20 matches for supported Summoner's Rift queues and caches at most 200 immutable match details, dropping the least recently used first.
It also remembers the queue of up to 2000 matches, so a match already seen as another mode is skipped and one already seen as supported is returned without a request.
A repeat poll of an account therefore costs only its ID list, and only matches never seen before are fetched, newest first, until the first supported one.
`/recent` reads its accounts two at a time (each account's matches one at a time), and its requests are bulk requests for [request pacing](#request-pacing).
Concurrency alone does not keep it under the limit: a cold `/recent count:10` over 10 accounts is 110 americas requests, more than the 100 per 2 minutes the development key allows.
Supported queues are 400, 420, 430, 440, 480, and 490; this includes Swiftplay and Quickplay and preserves Blind Pick for older history.

Queue IDs were checked against [Riot's official queue constants](https://static.developer.riotgames.com/docs/lol/queues.json) on 2026-10-02.
Retry and authentication failure behavior follows the [Riot Developer Portal response-code documentation](https://developer.riotgames.com/docs/portal).
NA1 and Americas routing follows the [official League of Legends routing documentation](https://developer.riotgames.com/docs/lol).

### Request pacing

Riot's development key allows 20 requests per 1 s and 100 per 120 s on each routing host, counted separately on `na1.api.riotgames.com` and `americas.api.riotgames.com`.
Going past either answers 429 with a Retry-After of up to the rest of the 2-minute window, and the cooldown then fails every shared request on that host until it ends.
`src/services/riotPacing.ts` paces requests so they wait for room instead of being sent and rejected.

- One pacer is shared by every requester in the process: the shared requester behind `riotFetch`, the spectator, league and timeline requesters, and scripts that create their own. Every caller draws on one budget per host.
- `RIOT_PACING_WINDOWS` keeps each host at most 16 requests per 1.2 s and 95 per 125 s. The counts are below Riot's 20 and 100, and the windows are longer than Riot's 1 s and 120 s, so a request that reaches Riot a little late is still inside the window it was counted in.
- Every attempt takes a turn, retries included, because Riot counts each one. A request counts as sent when it gets its turn, and its timeout starts then.
- Each response's `X-App-Rate-Limit-Count` tells the pacer Riot's own count. When Riot has counted more, for example requests from before a restart or from another process on the same key, the pacer counts the difference as sent. It never lowers its own count.
- The Retry-After cooldown still applies on top: a request first waits out a short cooldown (or fails on a long one), then waits for its turn, and when a new 429 started a cooldown while it waited, it gives the turn back and honors that cooldown too.
- A requester that never waits out a cooldown (spectator, league and timelines, `maxRetryDelayMs` 0) waits at most its 5 s timeout for a turn. When the turn would come later, the request is refused at once as `rate_limited` with the wait as `retryAfterMs` and is never sent. The game start watcher and the rank tracker already skip a `rate_limited` read quietly, and a refused timeline leaves the report on statistics only. Any other requester waits as long as its turn takes.
- At shutdown a waiting request is refused within a second (`unavailable`, never sent), and so is every later one. Waiting uses unref'd timers, so it never keeps the process alive.

Polling must not starve behind `/recent`, so requests have two priorities.
`/recent` sends bulk requests; everything else is normal, including finished-match polling with its match detail and timeline, league and spectator reads, `/profile`, `/bind` and the key check.
Bulk requests may use at most 10 turns per short window and 55 per long one, and a freed turn goes to a waiting normal request first.
Normal requests therefore always have 6 per short window and 40 per long window that bulk cannot take, more than a 10-account poll needs (10 ID lists per 45 s, about 28 per 125 s, plus a detail and a timeline per finished match).
A `/recent` burst can hold a poll's request back by at most one short window at a time, about a second, and never for the long window.
A smaller share was chosen over a strict priority queue so that `/recent` always makes progress, and over a cap on what `/recent` shows so that its reply stays the same.
The cost is time: a cold `/recent count:10` over 10 accounts sends 55 requests within a few seconds and the rest after the first ones leave the window, so its reply comes after about 2 minutes, well inside the 15 minutes a deferred Discord reply allows.
On na1 there are no bulk requests; the worst case of spectator (60 per 2 minutes for 10 accounts) and league (30, see [Rank tracking](#rank-tracking)) leaves 5 turns for `/profile` and `/bind`, which otherwise wait for the window.

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
A 401 or 403 is thrown as a `RiotApiError`; `isSpectatorAuthError()` recognizes it so the watcher can disable itself for the session.
The watcher's log line tells the developer to check `RIOT_API_KEY` and does not say matches are still announced: a dead key stops the match poll too.

### Mock active games

`simulateMockGameStart(blue, red = [])` starts a labeled mock game and returns `{ matchId, gameId }`.
The game is still loading (`gameStartTime` 0, `gameLength` 0) in queue 420 on Summoner's Rift.
The `blue` accounts (one to five) take team 100 in order and the optional `red` accounts (up to five) take team 200, so a friend on the other side can be simulated.
`MOCK-ALLY-*` and `MOCK-ENEMY-*` fill the remaining seats, numbered in seat order.
Parsed mock games have `mock: true`, and their game ID starts at 9 billion, far above the game IDs Riot has issued so far, which makes them easy to tell apart.
Nothing relies on that: `mock` comes from the mode.
Its match ID is reserved in the same `MOCK_<boot>_<epoch>_<sequence>` form, and `matchIdOf()` returns it.
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
Riot still counts every request against the same na1 app limit on its side, and the shared [pacer](#request-pacing) counts it with the rest.

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
`/simulate outcome:晋级（模拟）` and `掉段（模拟）` place the account at GOLD I 90 or GOLD IV 5 with `setMockRankedEntry`, keeping its games, before they simulate a win or a loss; see [Announcements](announcements.md#段位播报).

### Rank tracking

`src/services/rankTracker.ts` schedules every league-v4 read; when they happen and what the report shows is in [Announcements](announcements.md#段位变化).
It depends on an injected `readEntries(puuid)`, which is `getLeagueEntries` in production, and never on a requester directly.

- Snapshots live in memory, keyed by data mode and PUUID, so a mock read is never a real before-value, and in real mode a saved `MOCK-` account is never read.
- Each account keeps its last 4 successful reads with the time each was sent, so a match's before-value can be the newest read from before it ended.
- Reads run one at a time across every guild. Each is also bounded by the tracker's own 10 second guard, so a stuck dependency cannot hold the queue.
- Every read of an account comes at least 60 seconds after its previous read of any kind, failed reads included, checked when it is queued and again when its turn comes. The only exception is a match's first after-read, which goes out at detection.
- While league-v4 has not caught up (`wins + losses` unchanged), the account is read again on that floor, at most 4 reads per account per match.
- Only one snapshot read per account waits in the queue.
- The worst case is therefore 3 reads per account in any 2 minutes (two reads a floor apart plus one first after-read), 30 for 10 accounts, and in practice about 2 per account. That leaves room under the na1 app limit of 100 per 2 minutes next to spectator's 60 for `/profile` and `/bind`, and inside the pacer's 95 (see [Request pacing](#request-pacing)).
- `hasReadSince(puuid, since)` says whether a successful read was sent at or after `since`.
  It is true when nothing more will be read for the account, such as LP off or a saved mock account in real mode.
- A ranked game's start is retried through it.
  The game start watcher remembers the first sighting and passes it with `snapshot(puuids, { matchId, since })`.
  On each later in-game recheck it asks again for the players who still have no successful read from that time on.
  A timeout or a 429 at the start therefore does not leave an older read as the before-value, which would count a dodge or decay as part of the game.
  A player is asked at most 1 + 3 times per game, and the tracker's 60 second floor still spaces the reads.
  The watcher forgets a game's start bookkeeping when its accounts leave the game or voice, when the game finishes, and when it stops.
- A game the watcher saw at its start whose before-value is older than that sighting is not given a normal LP change.
  Its `change`, `promoted` and `demoted` result becomes `unattributable`, because the older read may hold a dodge or decay.
  A game the watcher never saw, such as one that began before monitoring, and mock data keep using the newest read from before the game ended.
- `rebase(puuids)` exists for `/simulate` only and does nothing in real mode: in mock mode it forgets the accounts' earlier reads and reads them again at once, past the floor, so a mock entry that was just placed is the before-value of the next simulated game. Mock reads never reach Riot.
- At shutdown `stop()` turns every queued read into a no-op, clears the retry timers and settles every pending row with no row; a read already sent is ignored when it answers.

Failures never reach the report as an error:

- A 401 or 403 turns LP off until the bot restarts, with one log line that tells the developer to check `RIOT_API_KEY`; pending rows are dropped.
  The line makes no promise about finished matches, because a 401, or a 403 from an expired key, also stops the match poll at its next run.
- A 429 is quiet: that read counts toward the cap and the scheduled read follows.
- A timeout, the requester's 5 seconds or the tracker's guard, counts as not caught up yet.
- Any other failure is logged once per kind, with one line when a read works again, and the row says `段位暂时查不到`.

Each account's after-reads log one line per match, `league-v4 caught up N s after game end (read k)`, or that it had not caught up after the last read.
A result that shows no row because the entry disappeared or the tier is unknown is logged as `none/<reason>`.

### Still to measure

These need real ranked games and are not known yet: how long league-v4 lags behind the end of a game, whether a remake changes LP or `wins + losses`, whether an entry exists during placements, and where a demotion places you in LP.
The lag lines above answer the first: the retry window is to be set from the p95 of at least 10 real ranked games.
