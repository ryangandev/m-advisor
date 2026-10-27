import { getDatabase } from "./database";

/** A closed case is forgotten after this long, which bounds the table; a year is far longer than anyone re-appeals. */
export const APPEAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Identifies one /why appeal: a member, a match, and whether the record is mock or real. */
export interface AppealCase {
  guildId: string;
  discordUserId: string;
  matchId: string;
  mock: boolean;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
}

function validate(appeal: AppealCase): void {
  requireString(appeal.guildId, "Guild ID");
  requireString(appeal.discordUserId, "Discord user ID");
  requireString(appeal.matchId, "Match ID");
}

/** Whether this member already appealed this match. A case older than the retention period no longer counts. */
export function isAppealClosed(appeal: AppealCase, now = Date.now()): boolean {
  validate(appeal);
  return getDatabase().prepare(
    "SELECT 1 FROM appeal_cases WHERE guild_id = ? AND discord_user_id = ? AND match_id = ? AND mock = ? AND closed_at >= ?",
  ).get(appeal.guildId, appeal.discordUserId, appeal.matchId, appeal.mock ? 1 : 0, now - APPEAL_RETENTION_MS) !== undefined;
}

/**
 * Closes a case and deletes every case past the retention period in the same transaction.
 * Returns false when the case was already closed, so only one caller can win a double click.
 */
export function closeAppeal(appeal: AppealCase, now = Date.now()): boolean {
  validate(appeal);
  const database = getDatabase();
  return database.transaction(() => {
    database.prepare("DELETE FROM appeal_cases WHERE closed_at < ?").run(now - APPEAL_RETENTION_MS);
    return database.prepare(
      "INSERT OR IGNORE INTO appeal_cases (guild_id, discord_user_id, match_id, mock, closed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(appeal.guildId, appeal.discordUserId, appeal.matchId, appeal.mock ? 1 : 0, now).changes === 1;
  }).immediate();
}

/** Reopens a case, for a ruling that could not be sent. Returns whether it was closed. */
export function reopenAppeal(appeal: AppealCase): boolean {
  validate(appeal);
  return getDatabase().prepare(
    "DELETE FROM appeal_cases WHERE guild_id = ? AND discord_user_id = ? AND match_id = ? AND mock = ?",
  ).run(appeal.guildId, appeal.discordUserId, appeal.matchId, appeal.mock ? 1 : 0).changes === 1;
}

/** How many closed cases a member has in one server, mock and real together, for the erase confirmation. */
export function countMemberAppeals(guildId: string, discordUserId: string): number {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  return (getDatabase().prepare("SELECT count(*) AS count FROM appeal_cases WHERE guild_id = ? AND discord_user_id = ?")
    .get(guildId, discordUserId) as { count: number }).count;
}

/** Deletes every closed case, real and mock, of one member in one server and returns how many were removed. */
export function eraseMemberAppeals(guildId: string, discordUserId: string): number {
  requireString(guildId, "Guild ID");
  requireString(discordUserId, "Discord user ID");
  return getDatabase().prepare("DELETE FROM appeal_cases WHERE guild_id = ? AND discord_user_id = ?").run(guildId, discordUserId).changes;
}
