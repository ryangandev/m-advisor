import { RiotAccount, ServerBinding } from "../types";
import { getDatabase } from "./database";

interface BindingRow {
  guild_id: string;
  discord_user_id: string;
}

interface AccountRow {
  puuid: string;
  game_name: string;
  tag_line: string;
}

function readBinding(row: BindingRow): ServerBinding {
  const accounts = getDatabase().prepare(
    "SELECT puuid, game_name, tag_line FROM bound_accounts WHERE guild_id = ? ORDER BY position",
  ).all(row.guild_id) as AccountRow[];
  return {
    discordUserId: row.discord_user_id,
    accounts: accounts.map((account) => ({
      puuid: account.puuid,
      gameName: account.game_name,
      tagLine: account.tag_line,
    })),
  };
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

export function getBinding(guildId: string): ServerBinding | undefined {
  requireString(guildId, "Guild ID");
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.prepare("SELECT guild_id, discord_user_id FROM guild_bindings WHERE guild_id = ?").get(guildId) as BindingRow | undefined;
    return row ? readBinding(row) : undefined;
  })();
}

export function setBinding(guildId: string, binding: ServerBinding): void {
  requireString(guildId, "Guild ID");
  if (!binding || typeof binding !== "object") {
    throw new TypeError("A binding must contain a Discord member and Riot accounts.");
  }
  requireString(binding.discordUserId, "Discord user ID");
  if (!Array.isArray(binding.accounts) || binding.accounts.length === 0) {
    throw new TypeError("A binding must contain at least one Riot account.");
  }
  binding.accounts.forEach(validateAccount);

  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO guild_bindings (guild_id, discord_user_id) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET discord_user_id = excluded.discord_user_id
    `).run(guildId, binding.discordUserId);
    db.prepare("DELETE FROM bound_accounts WHERE guild_id = ?").run(guildId);
    const insertAccount = db.prepare(`
      INSERT INTO bound_accounts (guild_id, puuid, game_name, tag_line, position) VALUES (?, ?, ?, ?, ?)
    `);
    binding.accounts.forEach((account, index) => {
      insertAccount.run(guildId, account.puuid, account.gameName, account.tagLine, index);
    });
  })();
}

export function clearBinding(guildId: string): void {
  requireString(guildId, "Guild ID");
  // The foreign key cascades account removal in the same SQLite statement.
  getDatabase().prepare("DELETE FROM guild_bindings WHERE guild_id = ?").run(guildId);
}

export function listBindings(): Array<{ guildId: string; binding: ServerBinding }> {
  const db = getDatabase();
  return db.transaction(() => {
    const rows = db.prepare("SELECT guild_id, discord_user_id FROM guild_bindings ORDER BY guild_id").all() as BindingRow[];
    return rows.map((row) => ({ guildId: row.guild_id, binding: readBinding(row) }));
  })();
}
