# Codex Task: M-Advisor Phase 2 — Account Binding

Read REQUIREMENTS.md for full context. Implement Phase 2: admin-only account binding system.

## Rules (from requirements):
- One Discord member tracked per server at a time (MVP)
- That member can have multiple LoL accounts bound
- Only server admins can use bind/unbind/bindings commands
- /bind adds a LoL account to a member's list
- /unbind @user removes ALL of that member's bound accounts
- /bindings shows current server binding (who is bound + their accounts)
- Storage: in-memory Map (clears on restart)

## Step 1: Create src/store/bindingStore.ts

In-memory store for server bindings:

```typescript
import { RiotAccount } from '../types';

interface ServerBinding {
  discordUserId: string;
  accounts: RiotAccount[];
}

// Map<guildId, ServerBinding>
const store = new Map<string, ServerBinding>();

export function getBinding(guildId: string): ServerBinding | undefined
export function setBinding(guildId: string, binding: ServerBinding): void
export function clearBinding(guildId: string): void
```

Also add to src/types.ts (append, do not remove existing):
```typescript
export interface ServerBinding {
  discordUserId: string;
  accounts: RiotAccount[];
}
```

## Step 2: Create src/utils/permissions.ts

```typescript
import { ChatInputCommandInteraction } from 'discord.js';

// Returns true if the interaction member has Administrator permission
export function isAdmin(interaction: ChatInputCommandInteraction): boolean
```

Use: `interaction.memberPermissions?.has('Administrator') ?? false`

## Step 3: Create src/commands/bind.ts

Slash command:
- name: "bind"
- description: "Bind a LoL account to a Discord member (Admin only)"
- Options:
  - "user" (User type, required) — "Discord member to bind"
  - "riotid" (String type, required) — "Riot ID (e.g. Faker#KR1)"

Execute logic:
1. Check isAdmin(interaction) — if not admin, reply ephemeral: "You need Administrator permission to use this command."
2. await interaction.deferReply({ ephemeral: true })
3. Get user option and riotid option
4. Validate riotid format (must have exactly one '#', both parts non-empty)
5. Call getAccountByRiotId(gameName, tagLine) from riotApi to resolve PUUID
   - On error: editReply with error embed
6. Check current binding for this guild (getBinding(guildId))
7. If a binding exists AND it's for a DIFFERENT user: reply error "This server already has a binding for <@existingUserId>. Use /unbind first."
8. If binding exists for SAME user: check if this riotId is already in accounts list (case-insensitive gameName + tagLine). If duplicate: reply "This account is already bound."
9. Add account to binding (create new or append to existing accounts array)
10. Reply with success embed: green color, "Bound [RiotID] to <@userId>"

## Step 4: Create src/commands/unbind.ts

Slash command:
- name: "unbind"
- description: "Remove all LoL account bindings from a Discord member (Admin only)"
- Options:
  - "user" (User type, required) — "Discord member to unbind"

Execute logic:
1. Check isAdmin(interaction) — if not admin, reply ephemeral error
2. await interaction.deferReply({ ephemeral: true })
3. Get binding for this guild
4. If no binding or binding is for a different user: reply "No binding found for that member."
5. clearBinding(guildId)
6. Reply with success embed: "Removed all bindings for <@userId>"

## Step 5: Create src/commands/bindings.ts

Slash command:
- name: "bindings"
- description: "View the current server binding (Admin only)"

Execute logic:
1. Check isAdmin(interaction) — if not admin, reply ephemeral error
2. Get binding for this guild
3. If no binding: reply embed "No bindings set for this server."
4. Build embed showing:
   - Title: "Server Bindings"
   - Color: blue (0x5865F2)
   - Field "Tracked Member": <@discordUserId>
   - Field "Bound Accounts": list of riotIds (one per line, e.g. "• Faker#KR1\n• Hide#KR2")
   - Footer: "NA Server • M-Advisor"

## Step 6: Update src/types.ts
Add BotEvent type (if not already present):
```typescript
export interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void> | void;
}
```

Also add to Discord.js Client augmentation at bottom of src/types.ts:
```typescript
import { Collection } from 'discord.js';
import { BotCommand } from './types';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, BotCommand>;
  }
}
```

Note: check if this augmentation already exists in types.ts before adding.

## After writing all files:
1. Run: npm run build
2. Fix ALL TypeScript errors until zero errors remain
3. Do NOT modify package.json, tsconfig.json, or any .env file
4. Do NOT call getAccountByRiotId in bind.ts if you want to avoid API calls during testing — actually DO call it since we want to validate the Riot ID is real when binding
