/**
 * When each member's stable was last erased, in memory only.
 *
 * `/stable-erase` leaves the member bound, so the database's ownership check cannot tell a write that predates the erase from a
 * new one. The writes that can predate it are the ones the monitor makes minutes after a report (the late LP write, and the
 * 马厩 records written after the voice when the text post failed). They compare their match's detection stamp with this cutoff.
 * A match detected before the erase was already on its way when the member asked for their data to go, so nothing
 * of it is written back; a match detected after the erase is recorded normally.
 * The order is decided by a process-wide counter, not by clock time: the wall clock can step backwards (NTP, sleep, a manual
 * change) and two events can share a millisecond, while every stamp is unique and only ever grows.
 * Nothing is persisted: a restart drops every pending late write anyway, so the cutoff is never needed afterwards.
 */
let lastStamp = 0;
const erasedAt = new Map<string, number>();

const keyOf = (guildId: string, discordUserId: string) => JSON.stringify([guildId, discordUserId]);

/** The next stamp of the process-wide counter: later events always get a larger one. */
export function nextStamp(): number {
  return ++lastStamp;
}

/** Remembers that the member's history was erased now. */
export function markMemberErased(guildId: string, discordUserId: string): void {
  erasedAt.set(keyOf(guildId, discordUserId), nextStamp());
}

/** True when the member was erased after the match got its detection stamp, so its rows must not be written. */
export function erasedSince(guildId: string, discordUserId: string, detectedStamp: number): boolean {
  const at = erasedAt.get(keyOf(guildId, discordUserId));
  return at !== undefined && at > detectedStamp;
}

/** Forgets every cutoff; for tests. */
export function resetEraseCutoffs(): void {
  erasedAt.clear();
}
