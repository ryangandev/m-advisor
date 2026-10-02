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

Other Riot IDs receive deterministic synthetic profiles, and previously persisted bindings can be tested in mock mode.
This does not validate that a real player exists.
Mock histories live in memory and reset when the bot restarts; user bindings and voice settings have a separate persistence layer.

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
