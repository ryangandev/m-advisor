# M-Advisor — Discord Bot Requirements

> A League of Legends advisor bot for Discord servers.
> Hosted on Mac mini. Testing on 2–3 servers, small scale.

---

## Constraints & Scope

- **Region:** North America (NA) only — hardcoded, no region selection exposed to users
- **Scale:** Development API key is sufficient (low traffic, 2–3 servers during testing)
- **Storage (Phase 1):** In-memory only (data clears on restart; DB migration is future work)
- **Per-server binding:** One Discord member can be tracked per server (MVP simplicity)

---

## Feature 1: Player Profile Lookup

**Command:** `/profile <RiotID>`
- Format: `GameName#TAG` (e.g. `Faker#KR1`)

**Displays (via styled Discord Embed):**
- Summoner level + profile icon
- Solo/Duo rank: tier, LP, wins, losses
- Flex rank: tier, LP, wins, losses
- Clean, readable layout — no raw API output

**API flow:**
1. Call Account API → get PUUID from Riot ID
2. Call Summoner API → get summoner info
3. Call League API → get ranked stats
4. Build and send Embed

---

## Feature 2: Account Binding (Admin Only)

**Who can use:** Server admins only (permission check on all bind/unbind commands)

**Commands:**
- `/bind <@DiscordUser> <RiotID>` — Bind a LoL account to a Discord member
- `/unbind <@DiscordUser>` — Remove **all** LoL accounts bound to that member
- `/bindings` — View the current binding for this server (admin only)

**Rules:**
- One Discord member tracked per server at a time (MVP)
- That member can have multiple LoL accounts bound to them
- `/bind` on a new RiotID for the same user **adds** to their list
- `/unbind @user` clears **all** of their bound accounts

**Storage (in-memory data model):**
```
Map<guildId, {
  discordUserId: string,
  accounts: Array<{ riotId: string, puuid: string, summonerId: string }>
}>
```

---

## Feature 3: Auto Voice Channel Announcement

**Trigger flow:**
1. Bot detects bound Discord member enters a Voice Channel → **start polling**
2. Bot detects bound Discord member leaves all Voice Channels → **stop polling**
3. While polling: check Riot Match API every ~45 seconds for a newly completed match
4. On new match detected:
   - Verify it's Summoner's Rift (queue IDs: 400, 420, 430, 440)
   - Confirm member is still in a VC
   - Bot joins their Voice Channel
   - Announces result via TTS
   - Bot leaves VC

**Announcement content (TTS):**
- Win or loss
- Best performer: player with highest KDA in the match
- Worst performer: player with lowest KDA in the match
- If the named player is also in the same VC, @ mention them in chat alongside the TTS

**Polling details:**
- No Riot webhook available — polling is the only option
- Poll only while bound member is in a VC (saves API calls)
- Track last seen `matchId` to avoid duplicate announcements
- Rate: ~45s interval is safe within dev key limits (1 user per server × 2–3 servers)

**Voice / TTS:**
- Use macOS `say` command (free, no API key, bot runs on Mac mini)
- Generate audio file → play via `@discordjs/voice` + ffmpeg
- Single unified voice for now (e.g. `Samantha` — clean US English)
- Voice style switching is **deferred** to a later phase

---

## Feature 4: Announcer Voice Style *(Deferred)*

> Planned but not built in Phase 3. Will be added later once a preferred audio source is chosen.

- `/announcer <style>` — switch between voice styles
- Styles TBD (Ryan to decide on audio source preferences)

---

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript |
| Discord framework | discord.js v14 |
| Voice | `@discordjs/voice` + ffmpeg |
| TTS | macOS `say` command (free, local) |
| Riot API | Official Riot Games API (dev key) |
| Storage (Phase 1) | In-memory Map |
| Storage (Phase 2) | SQLite / PostgreSQL (future) |
| Environment | dotenv |

---

## Slash Commands

| Command | Who | Description |
|---|---|---|
| `/profile <RiotID>` | Anyone | Look up a player's ranked profile |
| `/bind <@user> <RiotID>` | Admin | Bind a LoL account to a Discord member |
| `/unbind <@user>` | Admin | Remove all LoL accounts from a Discord member |
| `/bindings` | Admin | View current server binding |

---

## Development Phases

| Phase | Features |
|---|---|
| Phase 1 | Bot framework + `/profile` |
| Phase 2 | `/bind` `/unbind` `/bindings` + in-memory storage |
| Phase 3 | Game-end polling + VC auto-announcement + TTS |
| Phase 4 | Voice style switching + DB migration |

---

## Riot API Endpoints Used

| Purpose | Endpoint |
|---|---|
| Riot ID → PUUID | `GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` (Americas) |
| PUUID → Summoner | `GET /lol/summoner/v4/summoners/by-puuid/{puuid}` (na1) |
| Ranked stats | `GET /lol/league/v4/entries/by-summoner/{summonerId}` (na1) |
| Recent matches | `GET /lol/match/v5/matches/by-puuid/{puuid}/ids` (Americas) |
| Match detail | `GET /lol/match/v5/matches/{matchId}` (Americas) |

---

*Last updated: 2026-03-06*
