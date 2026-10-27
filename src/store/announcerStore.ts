import { getDatabase } from "./database";

type VoiceStyle = "sweet" | "old";

/** Servers without a saved choice hear the old strategist voice that suits 策马军师. */
export const DEFAULT_VOICE_STYLE: VoiceStyle = "old";

interface AnnouncerState {
  voiceStyle: VoiceStyle;
  lastMatchIds: Map<string, string>;
  pollingInterval: NodeJS.Timeout | null;
}

const store = new Map<string, AnnouncerState>();

function createDefaultState(guildId: string): AnnouncerState {
  const savedPreference = getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId) as { voice_style: VoiceStyle } | undefined;
  return {
    voiceStyle: savedPreference?.voice_style ?? DEFAULT_VOICE_STYLE,
    lastMatchIds: new Map<string, string>(),
    pollingInterval: null,
  };
}

export function getAnnouncerState(guildId: string): AnnouncerState {
  if (typeof guildId !== "string" || guildId.trim().length === 0) {
    throw new TypeError("Guild ID must be a nonempty string.");
  }
  let state = store.get(guildId);
  if (!state) {
    state = createDefaultState(guildId);
    store.set(guildId, state);
  }
  return state;
}

export function setVoiceStyle(guildId: string, style: VoiceStyle): void {
  if (style !== "sweet" && style !== "old") {
    throw new TypeError("Voice style must be sweet or old.");
  }
  const state = getAnnouncerState(guildId);
  // Update memory only after persistence succeeds, keeping both views consistent.
  getDatabase().prepare(`
    INSERT INTO guild_preferences (guild_id, voice_style) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET voice_style = excluded.voice_style
  `).run(guildId, style);
  state.voiceStyle = style;
}

/** Whether the pre-game voice line is spoken in this server. No saved row means on. */
export function getPregameVoiceEnabled(guildId: string): boolean {
  if (typeof guildId !== "string" || guildId.trim().length === 0) {
    throw new TypeError("Guild ID must be a nonempty string.");
  }
  const row = getDatabase().prepare("SELECT voice_enabled FROM pregame_settings WHERE guild_id = ?").get(guildId) as { voice_enabled: number } | undefined;
  return row === undefined ? true : row.voice_enabled === 1;
}

export function setPregameVoiceEnabled(guildId: string, enabled: boolean): void {
  if (typeof guildId !== "string" || guildId.trim().length === 0) {
    throw new TypeError("Guild ID must be a nonempty string.");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("The pre-game voice switch must be a boolean.");
  }
  getDatabase().prepare(`
    INSERT INTO pregame_settings (guild_id, voice_enabled) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET voice_enabled = excluded.voice_enabled
  `).run(guildId, enabled ? 1 : 0);
}

export function setPollingInterval(guildId: string, interval: NodeJS.Timeout | null): void {
  const state = getAnnouncerState(guildId);
  state.pollingInterval = interval;
}

export function setLastMatchId(guildId: string, puuid: string, matchId: string): void {
  const state = getAnnouncerState(guildId);
  state.lastMatchIds.set(puuid, matchId);
}

export function getLastMatchId(guildId: string, puuid: string): string | undefined {
  const state = getAnnouncerState(guildId);
  return state.lastMatchIds.get(puuid);
}

/** Forget the baselines of accounts that are no longer monitored, so a later return starts a fresh baseline. */
export function clearLastMatchIds(guildId: string, puuids: Iterable<string>): void {
  const state = getAnnouncerState(guildId);
  for (const puuid of puuids) state.lastMatchIds.delete(puuid);
}

/** End a monitoring session without erasing the persisted voice preference. */
export function resetAnnouncerRuntime(guildId: string): void {
  const state = getAnnouncerState(guildId);
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
  }
  state.pollingInterval = null;
  state.lastMatchIds.clear();
}

export type { AnnouncerState, VoiceStyle };
