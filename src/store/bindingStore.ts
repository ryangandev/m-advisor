import { GuildTracking, RiotAccount, TrackedMember } from "../types";
import { getDatabase } from "./database";

import { AccountBoundToOtherMemberError, GuildAccountLimitError, MAX_ACCOUNTS_PER_GUILD } from "./storeErrors";

export { AccountBoundToOtherMemberError, GuildAccountLimitError, MAX_ACCOUNTS_PER_GUILD };

interface MemberRow {
  guild_id: string;
  discord_user_id: string;
}

interface AccountRow extends MemberRow {
  puuid: string;
  game_name: string;
  tag_line: string;
}

function groupByGuild(memberRows: MemberRow[], accountRows: AccountRow[]): Map<string, TrackedMember[]> {
  const byGuild = new Map<string, TrackedMember[]>();
  const byMember = new Map<string, TrackedMember>();
  for (const row of memberRows) {
    const member: TrackedMember = { discordUserId: row.discord_user_id, accounts: [] };
    byMember.set(`${row.guild_id}\u0000${row.discord_user_id}`, member);
    const members = byGuild.get(row.guild_id) ?? [];
    members.push(member);
    byGuild.set(row.guild_id, members);
  }
  for (const account of accountRows) {
    byMember.get(`${account.guild_id}\u0000${account.discord_user_id}`)?.accounts.push({
      puuid: account.puuid,
      gameName: account.game_name,
      tagLine: account.tag_line,
    });
  }
  return byGuild;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a nonempty string.`);
  }
}

function validateAccount(account: RiotAccount): void {
  if (!account || typeof account !== "object") {
    throw new TypeError("Each binding account must be a Riot account.");
  }
  requireString(account.puuid, "Account PUUID");
  requireString(account.gameName, "Account game name");
  requireString(account.tagLine, "Account tag line");
}

/** Members of one guild in bind order, each with accounts in bind order. */
export function listTrackedMembers(guildId: string): TrackedMember[] {
  requireString(guildId, "Guild ID");
  const db = getDatabase();
  return db.transaction(() => {
    const members = db.prepare(
      "SELECT guild_id, discord_user_id FROM tracked_members WHERE guild_id = ? ORDER BY position",
    ).all(guildId) as MemberRow[];
    const accounts = db.prepare(
      "SELECT guild_id, discord_user_id, puuid, game_name, tag_line FROM member_accounts WHERE guild_id = ? ORDER BY position",
    ).all(guildId) as AccountRow[];
    return groupByGuild(members, accounts).get(guildId) ?? [];
  })();
}

export function getTrackedMember(guildId: string, discordUserId: string): TrackedMember | undefined {
  requireString(discordUserId, "Discord user ID");
  return listTrackedMembers(guildId).find((member) => member.discordUserId === discordUserId);
}

/**
 * Create the member if needed (bound after everyone already tracked) and replace their accounts atomically.
 * Throws AccountBoundToOtherMemberError or GuildAccountLimitError and leaves everything unchanged.
 */
export function setMemberAccounts(guildId: string, discordUserId: string, accounts: RiotAccount[]): void {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError("A tracked member must have at least one Riot account.");
  }
  accounts.forEach(validateAccount);

  const db = getDatabase();
  db.transaction(() => {
    const findOwner = db.prepare("SELECT discord_user_id FROM member_accounts WHERE guild_id = ? AND puuid = ?");
    for (const account of accounts) {
      const owner = findOwner.get(guildId, account.puuid) as { discord_user_id: string } | undefined;
      if (owner && owner.discord_user_id !== discordUserId) {
        throw new AccountBoundToOtherMemberError(account.puuid, owner.discord_user_id);
      }
    }
    db.prepare(`
      INSERT INTO tracked_members (guild_id, discord_user_id, position)
      VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM tracked_members WHERE guild_id = ?))
      ON CONFLICT(guild_id, discord_user_id) DO NOTHING
    `).run(guildId, discordUserId, guildId);
    db.prepare("DELETE FROM member_accounts WHERE guild_id = ? AND discord_user_id = ?").run(guildId, discordUserId);
    const insertAccount = db.prepare(`
      INSERT INTO member_accounts (guild_id, discord_user_id, puuid, game_name, tag_line, position) VALUES (?, ?, ?, ?, ?, ?)
    `);
    accounts.forEach((account, index) => {
      insertAccount.run(guildId, discordUserId, account.puuid, account.gameName, account.tagLine, index);
    });
    const total = db.prepare("SELECT count(*) AS count FROM member_accounts WHERE guild_id = ?").get(guildId) as { count: number };
    if (total.count > MAX_ACCOUNTS_PER_GUILD) throw new GuildAccountLimitError();
  })();
}

/** Remove one member and their accounts. Other members and the guild's voice preference are untouched. */
export function removeTrackedMember(guildId: string, discordUserId: string): boolean {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  // The foreign key cascades account removal in the same SQLite statement.
  const result = getDatabase().prepare("DELETE FROM tracked_members WHERE guild_id = ? AND discord_user_id = ?").run(guildId, discordUserId);
  return result.changes > 0;
}

/** The Discord member who owns this PUUID in the guild, if any. */
export function findAccountOwner(guildId: string, puuid: string): string | undefined {
  requireString(guildId, "Guild ID");
  requireString(puuid, "Account PUUID");
  const row = getDatabase().prepare("SELECT discord_user_id FROM member_accounts WHERE guild_id = ? AND puuid = ?").get(guildId, puuid) as { discord_user_id: string } | undefined;
  return row?.discord_user_id;
}

/** Every guild with at least one tracked member, ordered by guild ID, for startup reconciliation. */
export function listAllTracking(): GuildTracking[] {
  const db = getDatabase();
  return db.transaction(() => {
    const members = db.prepare("SELECT guild_id, discord_user_id FROM tracked_members ORDER BY guild_id, position").all() as MemberRow[];
    const accounts = db.prepare(
      "SELECT guild_id, discord_user_id, puuid, game_name, tag_line FROM member_accounts ORDER BY guild_id, position",
    ).all() as AccountRow[];
    return [...groupByGuild(members, accounts)].map(([guildId, guildMembers]) => ({ guildId, members: guildMembers }));
  })();
}
