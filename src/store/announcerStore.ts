type VoiceStyle = "sweet" | "old";

interface AnnouncerState {
  voiceStyle: VoiceStyle;
  lastMatchIds: Map<string, string>;
  pollingInterval: NodeJS.Timeout | null;
  activeVoiceChannelId: string | null;
}

const store = new Map<string, AnnouncerState>();

function createDefaultState(): AnnouncerState {
  return {
    voiceStyle: "sweet",
    lastMatchIds: new Map<string, string>(),
    pollingInterval: null,
    activeVoiceChannelId: null,
  };
}

export function getAnnouncerState(guildId: string): AnnouncerState {
  let state = store.get(guildId);
  if (!state) {
    state = createDefaultState();
    store.set(guildId, state);
  }
  return state;
}

export function setVoiceStyle(guildId: string, style: VoiceStyle): void {
  const state = getAnnouncerState(guildId);
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

export type { AnnouncerState, VoiceStyle };
