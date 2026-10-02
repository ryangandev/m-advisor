import { getDatabase } from "./database";

type VoiceStyle = "sweet" | "old";

interface AnnouncerState {
  voiceStyle: VoiceStyle;
  lastMatchIds: Map<string, string>;
  pollingInterval: NodeJS.Timeout | null;
  activeVoiceChannelId: string | null;
}

const store = new Map<string, AnnouncerState>();

function createDefaultState(guildId: string): AnnouncerState {
  const savedPreference = getDatabase().prepare("SELECT voice_style FROM guild_preferences WHERE guild_id = ?").get(guildId) as { voice_style: VoiceStyle } | undefined;
  return {
    voiceStyle: savedPreference?.voice_style ?? "sweet",
    lastMatchIds: new Map<string, string>(),
    pollingInterval: null,
    activeVoiceChannelId: null,
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

export function setActiveVoiceChannel(guildId: string, channelId: string | null): void {
  const state = getAnnouncerState(guildId);
  state.activeVoiceChannelId = channelId;
}

/** End a monitoring session without erasing the persisted voice preference. */
export function resetAnnouncerRuntime(guildId: string): void {
  const state = getAnnouncerState(guildId);
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
  }
  state.pollingInterval = null;
  state.activeVoiceChannelId = null;
  state.lastMatchIds.clear();
}

export type { AnnouncerState, VoiceStyle };
