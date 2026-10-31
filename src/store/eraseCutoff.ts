/**
 * When each member's stable was last erased, in memory only.
 *
 * `/stable-erase` leaves the member bound, so the database's ownership check cannot tell a write that predates the erase from a
 * new one. The writes that can predate it are the ones the monitor makes minutes after a report (the late LP write, and the
 * 马厩 records written after the voice when the text post failed). They compare their match's detection time with this cutoff.
 * A match detected at or before the erase was already on its way when the member asked for their data to go, so nothing
 * of it is written back; a match detected later is recorded normally.
 * Detection time is the monitor's own clock, the same one the erase uses, unlike the match's end time, which is Riot's clock.
 * Nothing is persisted: a restart drops every pending late write anyway, so the cutoff is never needed afterwards.
 */
const erasedAt = new Map<string, number>();

const keyOf = (guildId: string, discordUserId: string) => JSON.stringify([guildId, discordUserId]);

/** Remembers that the member's history was erased now. */
export function markMemberErased(guildId: string, discordUserId: string, at = Date.now()): void {
  const key = keyOf(guildId, discordUserId);
  erasedAt.set(key, Math.max(at, erasedAt.get(key) ?? 0));
}

/** True when the member was erased at or after the moment the match was detected, so its rows must not be written. */
export function erasedSince(guildId: string, discordUserId: string, detectedAt: number): boolean {
  const at = erasedAt.get(keyOf(guildId, discordUserId));
  return at !== undefined && at >= detectedAt;
}

/** Forgets every cutoff; for tests. */
export function resetEraseCutoffs(): void {
  erasedAt.clear();
}
