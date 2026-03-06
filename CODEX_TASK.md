# Codex Task: M-Advisor Phase 1

Read REQUIREMENTS.md for full project context. Build Phase 1: bot framework + /profile slash command.

## Existing structure:
src/commands/, src/events/, src/handlers/, src/utils/ (all empty)
src/index.ts (minimal, needs replacing)

## Files to create/replace:

### src/types.ts
Define TypeScript interfaces:
- RiotAccount: { puuid: string, gameName: string, tagLine: string }
- Summoner: { id: string, accountId: string, puuid: string, name: string, profileIconId: number, summonerLevel: number }
- RankedEntry: { queueType: string, tier: string, rank: string, leaguePoints: number, wins: number, losses: number }
- BotCommand: { data: SlashCommandBuilder, execute: (interaction: ChatInputCommandInteraction) => Promise<void> }

### src/utils/riotApi.ts
Riot API helpers (NA hardcoded, no region param exposed):
- Base URLs: NA1 = https://na1.api.riotgames.com, AMERICAS = https://americas.api.riotgames.com
- API key from: process.env.RIOT_API_KEY
- Helper: riotFetch(url) — appends ?api_key=KEY, throws readable Error on non-200
- getAccountByRiotId(gameName, tagLine): calls /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine} on AMERICAS
- getSummonerByPuuid(puuid): calls /lol/summoner/v4/summoners/by-puuid/{puuid} on NA1
- getRankedEntries(summonerId): calls /lol/league/v4/entries/by-summoner/{summonerId} on NA1

### src/utils/embeds.ts
- buildProfileEmbed(riotId, summoner, rankedEntries): returns EmbedBuilder
  - Title: the riotId string
  - Thumbnail: https://ddragon.leagueoflegends.com/cdn/14.1.1/img/profileicon/{profileIconId}.png
  - Color: 0xF0B232
  - Field "Summoner Level": summoner.summonerLevel
  - Field "Solo/Duo": find entry where queueType === "RANKED_SOLO_5x5"; if found: "GOLD II — 75 LP | 120W 80L (60%)"; else "Unranked"
  - Field "Flex": find entry where queueType === "RANKED_FLEX_SR"; same format or "Unranked"
  - Win rate = Math.round(wins / (wins + losses) * 100)
  - Footer: "NA Server • M-Advisor"
- buildErrorEmbed(message): returns red EmbedBuilder with error message

### src/commands/profile.ts
Slash command:
- name: "profile", description: "Look up a League of Legends player profile"
- Option: "riotid" (string, required) — description: "Riot ID (e.g. Faker#KR1)"
Execute:
1. await interaction.deferReply()
2. Get riotid option value
3. Validate: must contain exactly one "#", both parts non-empty; if invalid reply with buildErrorEmbed
4. Split into gameName and tagLine
5. Call getAccountByRiotId, getSummonerByPuuid, getRankedEntries in sequence
6. Build embed with buildProfileEmbed and editReply
7. Catch any error: editReply with buildErrorEmbed(error.message)

### src/handlers/commandHandler.ts
- loadCommands(client): reads all .ts files from src/commands/ using fs and path
  - dynamic import each file
  - store in client.commands (Collection)
- registerCommands(): registers slash commands via REST using CLIENT_ID and DISCORD_TOKEN

### src/events/ready.ts
- once: true, event: "ready"
- logs: "Logged in as {client.user.tag}"
- calls registerCommands()

### src/events/interactionCreate.ts
- event: "interactionCreate"
- if not isChatInputCommand(), return
- lookup command in client.commands
- try execute(interaction), catch and reply with error embed

### src/index.ts
- dotenv.config()
- Create Client with intents: Guilds, GuildMembers, GuildVoiceStates
- Attach client.commands = new Collection()
- Load events from src/events/
- loadCommands(client)
- client.login(process.env.DISCORD_TOKEN)

## After writing all files:
Run: npm run build
Fix ALL TypeScript errors until zero errors remain.
Do NOT touch package.json, tsconfig.json, or .env files.
Do NOT create a .env file.
