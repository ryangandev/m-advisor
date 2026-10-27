import { getDatabase } from "./database";

export type ReportKind = "day" | "week";

/** One server's 马报 settings. A server without a row, or with no channel, gets no automatic reports. */
export interface ReportSettings {
  guildId: string;
  /** The text channel automatic reports go to, or null when automatic reports are off. */
  channelId: string | null;
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  rolesEnabled: boolean;
  /** The 本周特等马 role the bot manages. Always set while roles are enabled. */
  topRoleId: string | null;
  /** The 本周没有马 role the bot manages. Always set while roles are enabled. */
  noneRoleId: string | null;
  /** Members the bot itself gave the 本周特等马 role, so the next rotation takes it back from exactly them. */
  topHolderIds: string[];
  noneHolderIds: string[];
}

interface ReportSettingsRow {
  guild_id: string;
  channel_id: string | null;
  daily_enabled: number;
  weekly_enabled: number;
  roles_enabled: number;
  top_role_id: string | null;
  none_role_id: string | null;
  top_holder_ids: string;
  none_holder_ids: string;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
}

function requireKind(kind: unknown): asserts kind is ReportKind {
  if (kind !== "day" && kind !== "week") throw new TypeError("A report kind must be day or week.");
}

function fromRow(row: ReportSettingsRow): ReportSettings {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    dailyEnabled: row.daily_enabled === 1,
    weeklyEnabled: row.weekly_enabled === 1,
    rolesEnabled: row.roles_enabled === 1,
    topRoleId: row.top_role_id,
    noneRoleId: row.none_role_id,
    topHolderIds: JSON.parse(row.top_holder_ids) as string[],
    noneHolderIds: JSON.parse(row.none_holder_ids) as string[],
  };
}

/** Settings read fresh from the database; undefined when the server never configured anything. */
export function getReportSettings(guildId: string): ReportSettings | undefined {
  requireString(guildId, "Guild ID");
  const row = getDatabase().prepare("SELECT * FROM report_settings WHERE guild_id = ?").get(guildId) as ReportSettingsRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Every server that has a report channel, for the scheduler. */
export function listReportDestinations(): ReportSettings[] {
  const rows = getDatabase().prepare("SELECT * FROM report_settings WHERE channel_id IS NOT NULL ORDER BY guild_id").all() as ReportSettingsRow[];
  return rows.map(fromRow);
}

function ensureRow(guildId: string): void {
  getDatabase().prepare("INSERT INTO report_settings (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING").run(guildId);
}

/**
 * Sets or clears the channel and returns whether the server had no channel before.
 * Switching channels keeps everything else, including which periods were already handled.
 */
export function setReportChannel(guildId: string, channelId: string | null): boolean {
  requireString(guildId, "Guild ID");
  if (channelId !== null) requireString(channelId, "Channel ID");
  const db = getDatabase();
  return db.transaction(() => {
    const before = getReportSettings(guildId);
    ensureRow(guildId);
    db.prepare("UPDATE report_settings SET channel_id = ? WHERE guild_id = ?").run(channelId, guildId);
    return before?.channelId == null;
  })();
}

export function setReportKindEnabled(guildId: string, kind: ReportKind, enabled: boolean): void {
  requireString(guildId, "Guild ID");
  requireKind(kind);
  ensureRow(guildId);
  const column = kind === "day" ? "daily_enabled" : "weekly_enabled";
  getDatabase().prepare(`UPDATE report_settings SET ${column} = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, guildId);
}

/** Turns weekly roles on with the two roles to manage, or off while remembering the roles for the next time. */
export function setReportRoles(guildId: string, roles: { enabled: true; topRoleId: string; noneRoleId: string } | { enabled: false }): void {
  requireString(guildId, "Guild ID");
  ensureRow(guildId);
  const db = getDatabase();
  if (!roles.enabled) {
    db.prepare("UPDATE report_settings SET roles_enabled = 0 WHERE guild_id = ?").run(guildId);
    return;
  }
  requireString(roles.topRoleId, "Top role ID");
  requireString(roles.noneRoleId, "None role ID");
  if (roles.topRoleId === roles.noneRoleId) throw new TypeError("The two weekly roles must be different roles.");
  db.prepare(`
    UPDATE report_settings SET roles_enabled = 1, top_role_id = ?, none_role_id = ?,
      top_holder_ids = CASE WHEN top_role_id IS ? THEN top_holder_ids ELSE '[]' END,
      none_holder_ids = CASE WHEN none_role_id IS ? THEN none_holder_ids ELSE '[]' END
    WHERE guild_id = ?
  `).run(roles.topRoleId, roles.noneRoleId, roles.topRoleId, roles.noneRoleId, guildId);
}

/** Remembers who the bot gave each weekly role, replacing the previous lists. */
export function setReportRoleHolders(guildId: string, holders: { top: readonly string[]; none: readonly string[] }): void {
  requireString(guildId, "Guild ID");
  ensureRow(guildId);
  getDatabase().prepare("UPDATE report_settings SET top_holder_ids = ?, none_holder_ids = ? WHERE guild_id = ?")
    .run(JSON.stringify([...new Set(holders.top)]), JSON.stringify([...new Set(holders.none)]), guildId);
}

/** The start of the latest period of this kind that was posted or deliberately skipped, or undefined if none. */
export function getReportMark(guildId: string, mock: boolean, kind: ReportKind): number | undefined {
  requireString(guildId, "Guild ID");
  requireKind(kind);
  const row = getDatabase().prepare("SELECT period_start FROM report_marks WHERE guild_id = ? AND mock = ? AND kind = ?")
    .get(guildId, mock ? 1 : 0, kind) as { period_start: number } | undefined;
  return row?.period_start;
}

/**
 * Records that the period starting at `periodStart` is done, whether it was posted or skipped.
 * A mark only moves forward, so handling an older period later never makes a newer one due again.
 * Mock and real data keep separate marks: a rehearsal in mock mode never uses up a real report.
 */
export function markReportHandled(guildId: string, mock: boolean, kind: ReportKind, periodStart: number, handledAt: number): void {
  requireString(guildId, "Guild ID");
  requireKind(kind);
  if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(handledAt)) throw new TypeError("Period start and handling time must be integer milliseconds.");
  getDatabase().prepare(`
    INSERT INTO report_marks (guild_id, mock, kind, period_start, handled_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, mock, kind) DO UPDATE SET
      handled_at = CASE WHEN excluded.period_start > period_start THEN excluded.handled_at ELSE handled_at END,
      period_start = max(period_start, excluded.period_start)
  `).run(guildId, mock ? 1 : 0, kind, periodStart, handledAt);
}
